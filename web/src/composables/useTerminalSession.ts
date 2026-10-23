import { ref, type Ref } from 'vue'
import { appLog } from '@/utils/appLog'
import { on, NativeError } from '@/native/bridge'
import * as api from '@/native/api'
import { ErrorCode } from '@/native/api'

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
  /** Called with raw PTY text (already decoded from base64 by this class). */
  onData: (data: string) => void
  onExit?: (code: number) => void
  /** Fired once per session id, so the tab can record it. */
  onSessionId?: (id: string) => void
}

/**
 * One terminal session, backed by an SSH connection held in the native layer.
 *
 * ## Why the connection lives in native
 *
 * The terminal is a PTY on the far side of an SSH channel. Doing that in
 * JavaScript is not possible (no sockets, no channel multiplexing, and the
 * WebView has no exec), so the SSH client and the channel are native. This class
 * is the VIEW side: it holds the tab's state and forwards keystrokes.
 *
 * ## Reconnect
 *
 * The native layer keeps the session alive after a failed WRITE (a socket that
 * died while the phone slept); `ssh.connect` with an existing `sessionId`
 * re-attaches to the same channel. `session_gone` means the channel is really
 * dead and starting a new one is the user's decision.
 *
 * ## Base64 on the wire
 *
 * PTY bytes are not valid UTF-8 in general (a half-written multi-byte character
 * is normal, and escape sequences contain arbitrary bytes). The bridge is a
 * string channel, so native base64-encodes and this decodes back to bytes with
 * `TextDecoder`, which buffers an incomplete sequence instead of emitting a
 * replacement character.
 */
export class TerminalSession {
  readonly state: Ref<ConnectionState> = ref('idle')
  readonly error: Ref<string> = ref('')
  readonly errorCode: Ref<string> = ref('')
  readonly sessionId: Ref<string> = ref('')

  private opts: TerminalSessionOptions
  private disposed = false
  private lastSize = { cols: 0, rows: 0 }
  /** What the host already knows. Separate from lastSize so a resize during the
   *  dial is still sent once the connection is up. */
  private sentSize = { cols: 0, rows: 0 }
  private unsubscribers: (() => void)[] = []
  private decoder = new TextDecoder('utf-8')
  private connecting = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0

  constructor(opts: TerminalSessionOptions) {
    this.opts = opts
    this.lastSize = { cols: opts.cols, rows: opts.rows }
    this.subscribe()
  }

  private subscribe() {
    // Events are broadcast to every listener; filter by our own session id so
    // two open tabs cannot consume each other's output.
    this.unsubscribers.push(on('terminal.data', (p) => {
      if (p.sessionId !== this.sessionId.value) return
      const b64 = typeof p.data === 'string' ? p.data : ''
      if (!b64) return
      this.opts.onData(this.decode(b64))
    }))

    this.unsubscribers.push(on('terminal.exit', (p) => {
      if (p.sessionId !== this.sessionId.value) return
      this.state.value = 'exited'
      this.opts.onExit?.(Number(p.code ?? 0))
    }))

    this.unsubscribers.push(on('terminal.state', (p) => {
      if (p.sessionId !== this.sessionId.value) return
      const next = String(p.state ?? '')
      if (next === 'connected') {
        this.attempt = 0
        this.state.value = 'connected'
      } else if (next === 'reconnecting') {
        this.state.value = 'reconnecting'
      } else if (next === 'error') {
        this.state.value = 'error'
        this.error.value = String(p.message ?? '')
        this.errorCode.value = String(p.code ?? '')
      }
    }))
  }

  /**
   * Decode base64 → bytes → text.
   *
   * `stream: true` is the important part: a multi-byte character split across
   * two chunks must be held, not turned into U+FFFD. Without it, every chunk
   * boundary in CJK output shows a replacement character.
   */
  private decode(b64: string): string {
    try {
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return this.decoder.decode(bytes, { stream: true })
    } catch (err) {
      appLog.w(TAG, 'failed to decode chunk', String(err))
      return ''
    }
  }

  /** Open (or re-attach) the session. */
  async connect(): Promise<void> {
    if (this.disposed || this.connecting) return
    this.connecting = true
    const reattach = this.sessionId.value !== ''
    this.state.value = reattach ? 'reconnecting' : 'connecting'
    this.error.value = ''
    this.errorCode.value = ''

    try {
      const res = await api.connectSession({
        hostId: this.opts.hostId,
        cols: this.lastSize.cols,
        rows: this.lastSize.rows,
        title: this.opts.title,
        // Re-attach by id when we have one; the native side ignores hostId then.
        ...(reattach ? { sessionId: this.sessionId.value } : {}),
      })
      if (res?.sessionId && res.sessionId !== this.sessionId.value) {
        this.sessionId.value = res.sessionId
        this.opts.onSessionId?.(res.sessionId)
      }
      this.state.value = 'connected'
      this.attempt = 0
      // The geometry went with ssh.connect, so record it as already sent. Only a
      // size that CHANGED while the dial was in flight needs a follow-up, and
      // `resize()` compares against this value to decide.
      this.sentSize = { cols: this.lastSize.cols, rows: this.lastSize.rows }
    } catch (err) {
      this.handleConnectError(err)
    } finally {
      this.connecting = false
    }
  }

  private handleConnectError(err: unknown) {
    const e = err as NativeError
    this.error.value = e?.message ?? String(err)
    this.errorCode.value = e?.code ?? ''

    if (this.errorCode.value === ErrorCode.sessionGone) {
      // The channel is gone for good. Clearing the id means the next attempt
      // starts a fresh session instead of re-attaching to a corpse.
      this.sessionId.value = ''
      this.state.value = 'exited'
      this.disposed = true
      return
    }
    if (this.errorCode.value === ErrorCode.sessionBusy) {
      this.state.value = 'error'
      this.disposed = true
      return
    }
    // A dial/auth/host-key failure is not retryable without user action, but it
    // IS recoverable by pressing "reconnect" — keep the object usable.
    if (this.errorCode.value === ErrorCode.hostKeyChanged
      || this.errorCode.value === ErrorCode.authFailed
      || this.errorCode.value === ErrorCode.connectionRefused
      || this.errorCode.value === ErrorCode.timeout
      || this.errorCode.value === ErrorCode.hostNotFound) {
      this.state.value = 'error'
      return
    }
    this.scheduleRetry()
  }

  private scheduleRetry() {
    if (this.disposed) return
    this.state.value = 'reconnecting'
    this.attempt++
    // 400ms, 800, 1.6s, 3.2s, 6.4s, then 8s
    const delay = Math.min(400 * 2 ** (this.attempt - 1), 8000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, delay)
  }

  private clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  send(data: string) {
    if (!data || !this.sessionId.value) return
    // Fire-and-forget: a keystroke must never block the UI, and a failed write
    // surfaces as a state event from native rather than a rejected promise.
    void api.writeSession(this.sessionId.value, data).catch((err) => {
      appLog.w(TAG, 'write failed', String(err))
    })
  }

  resize(cols: number, rows: number) {
    if (cols <= 0 || rows <= 0) return
    this.lastSize = { cols, rows }
    if (!this.sessionId.value) return
    if (cols === this.sentSize.cols && rows === this.sentSize.rows) return
    this.sentSize = { cols, rows }
    void api.resizeSession(this.sessionId.value, cols, rows).catch(() => {})
  }

  /** Keep the native session alive; only unsubscribe locally (tab switch). */
  detach() {
    this.clearRetry()
    this.unsubscribe()
  }

  /** End the session for good (tab close). */
  close() {
    this.disposed = true
    this.clearRetry()
    this.unsubscribe()
    if (this.sessionId.value) {
      void api.closeSession(this.sessionId.value).catch(() => {})
      this.sessionId.value = ''
    }
  }

  private unsubscribe() {
    for (const off of this.unsubscribers) off()
    this.unsubscribers = []
  }

  get isTerminal(): boolean {
    return this.state.value === 'exited' || this.state.value === 'error'
  }
}
