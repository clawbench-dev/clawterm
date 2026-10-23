import { ref, type Ref } from 'vue'
import { appLog } from '@/utils/appLog'
import {
  ErrCode,
  terminalWsUrl,
  type ClientMessage,
  type ServerMessage,
} from '@/utils/terminalProtocol'

const TAG = 'TerminalSession'

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'exited'
  | 'error'

export interface TerminalSessionOptions {
  hostId: number
  title: string
  cols: number
  rows: number
  /** Called with raw PTY text. Replay arrives before any live output. */
  onData: (data: string) => void
  onExit?: (code: number) => void
  /** Fired once per session id, so the tab can record it for re-attach. */
  onSessionId?: (id: string) => void
}

/**
 * One terminal tab's WebSocket.
 *
 * Reconnect policy: retry with capped exponential backoff while the app is in
 * the foreground, and re-attach to the SAME server session id. The server keeps
 * the PTY alive for a grace period after a detach, so a phone that slept for a
 * minute comes back to the same shell rather than a fresh login.
 *
 * A `session_gone` answer means the grace period expired — that is terminal
 * (the PTY is gone), so it stops retrying instead of spinning forever.
 */
export class TerminalSession {
  readonly state: Ref<ConnectionState> = ref('idle')
  readonly error: Ref<string> = ref('')
  readonly errorCode: Ref<string> = ref('')
  readonly sessionId: Ref<string> = ref('')

  private ws: WebSocket | null = null
  private opts: TerminalSessionOptions
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private lastSize = { cols: 0, rows: 0 }

  constructor(opts: TerminalSessionOptions) {
    this.opts = opts
    this.lastSize = { cols: opts.cols, rows: opts.rows }
  }

  /** Open (or re-open) the connection. */
  connect(): void {
    if (this.disposed) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    this.clearRetry()
    const reattach = this.sessionId.value !== ''
    this.state.value = reattach ? 'reconnecting' : 'connecting'
    this.error.value = ''
    this.errorCode.value = ''

    const url = terminalWsUrl({
      hostId: reattach ? undefined : this.opts.hostId,
      sessionId: reattach ? this.sessionId.value : undefined,
      cols: this.lastSize.cols,
      rows: this.lastSize.rows,
      title: this.opts.title,
    })

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (err) {
      this.fail('websocket_failed', String(err))
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      this.state.value = 'connected'
      appLog.d(TAG, `connected ${this.sessionId.value || '(new)'}`)
    }

    ws.onmessage = (ev) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage
      } catch {
        appLog.w(TAG, 'unparsable frame')
        return
      }
      this.handle(msg)
    }

    ws.onclose = () => {
      this.ws = null
      if (this.disposed) return
      if (this.state.value === 'exited') return
      // The server closing without an `exit` frame means the socket died, not
      // the shell: retry. Backoff caps at 8s so a long outage does not leave
      // the tab frozen for minutes after the network returns.
      this.scheduleRetry()
    }

    ws.onerror = () => {
      // `onclose` always follows and owns the retry decision; logging here
      // would double-report every disconnect.
      appLog.w(TAG, 'socket error')
    }
  }

  private handle(msg: ServerMessage) {
    switch (msg.type) {
      case 'ready':
        if (msg.sessionId && msg.sessionId !== this.sessionId.value) {
          this.sessionId.value = msg.sessionId
          this.opts.onSessionId?.(msg.sessionId)
        }
        this.state.value = 'connected'
        break
      case 'replay':
      case 'output':
        if (msg.data) this.opts.onData(msg.data)
        break
      case 'exit':
        this.state.value = 'exited'
        this.opts.onExit?.(msg.code ?? 0)
        break
      case 'error':
        this.error.value = msg.message || 'error'
        this.errorCode.value = msg.errcode || ''
        // EVERY error frame is terminal: the server has already decided the
        // attempt failed and is about to close the socket, so retrying would
        // just loop. `session_gone` additionally clears the id — the PTY is
        // gone and a fresh session is a user decision, not a retry.
        if (msg.errcode === ErrCode.sessionGone) {
          this.state.value = 'exited'
          this.sessionId.value = ''
        } else {
          this.state.value = 'error'
        }
        this.disposed = true
        this.close()
        break
      case 'pong':
        break
    }
  }

  private scheduleRetry() {
    if (this.disposed) return
    this.state.value = 'reconnecting'
    this.attempt++
    // 400ms, 800, 1.6s, 3.2s, 6.4s, then 8s
    const delay = Math.min(400 * 2 ** (this.attempt - 1), 8000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private fail(code: string, message: string) {
    this.errorCode.value = code
    this.error.value = message
    this.state.value = 'error'
  }

  send(data: string) {
    if (!data) return
    this.write({ type: 'input', data })
  }

  resize(cols: number, rows: number) {
    if (cols <= 0 || rows <= 0) return
    if (cols === this.lastSize.cols && rows === this.lastSize.rows) return
    this.lastSize = { cols, rows }
    this.write({ type: 'resize', cols, rows })
  }

  private write(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /** Close the socket without ending the server-side session (tab switch). */
  detach() {
    this.clearRetry()
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
  }

  /** Permanently end this session (tab close). */
  close() {
    this.disposed = true
    this.clearRetry()
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
  }

  /** Whether the shell has ended or the session is unrecoverable. */
  get isTerminal(): boolean {
    return this.state.value === 'exited' || this.state.value === 'error'
  }
}
