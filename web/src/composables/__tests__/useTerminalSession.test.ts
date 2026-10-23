import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalSession } from '../useTerminalSession'

/**
 * Minimal WebSocket double. The session only uses readyState, send, close and
 * the four event slots, so a hand-rolled fake keeps the test independent of
 * jsdom's partial WebSocket implementation.
 */
class FakeWS {
  static instances: FakeWS[] = []
  static OPEN = 1
  static CONNECTING = 0
  readyState = 0
  url: string
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWS.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }

  // Test helpers ---------------------------------------------------------
  open() {
    this.readyState = 1
    this.onopen?.()
  }

  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }

  drop() {
    this.readyState = 3
    this.onclose?.()
  }

  frames() {
    return this.sent.map((s) => JSON.parse(s))
  }
}

function makeSession(overrides: Partial<ConstructorParameters<typeof TerminalSession>[0]> = {}) {
  const data: string[] = []
  const exits: number[] = []
  const ids: string[] = []
  const s = new TerminalSession({
    hostId: 1,
    title: 'h',
    cols: 80,
    rows: 24,
    onData: (d) => data.push(d),
    onExit: (c) => exits.push(c),
    onSessionId: (id) => ids.push(id),
    ...overrides,
  })
  return { s, data, exits, ids }
}

beforeEach(() => {
  FakeWS.instances = []
  vi.stubGlobal('WebSocket', FakeWS)
  vi.useFakeTimers()
})

describe('TerminalSession', () => {
  it('starts connecting and reports connected on open', () => {
    const { s } = makeSession()
    s.connect()
    expect(s.state.value).toBe('connecting')
    FakeWS.instances[0].open()
    expect(s.state.value).toBe('connected')
  })

  it('records the session id from the ready frame', () => {
    const { s, ids } = makeSession()
    s.connect()
    FakeWS.instances[0].open()
    FakeWS.instances[0].emit({ type: 'ready', sessionId: 'abc' })
    expect(s.sessionId.value).toBe('abc')
    expect(ids).toEqual(['abc'])
  })

  // Replay arrives before any live output; both are just text to write.
  it('forwards replay and output to onData', () => {
    const { s, data } = makeSession()
    s.connect()
    FakeWS.instances[0].open()
    FakeWS.instances[0].emit({ type: 'replay', data: 'old\n' })
    FakeWS.instances[0].emit({ type: 'output', data: 'new\n' })
    expect(data).toEqual(['old\n', 'new\n'])
  })

  it('reports the exit code and stops', () => {
    const { s, exits } = makeSession()
    s.connect()
    FakeWS.instances[0].open()
    FakeWS.instances[0].emit({ type: 'exit', code: 3 })
    expect(s.state.value).toBe('exited')
    expect(exits).toEqual([3])
  })

  // A dropped socket is NOT a dead shell: the server keeps the PTY for a grace
  // period, so the client must retry and re-attach to the same session id.
  it('reconnects to the same session after a socket drop', () => {
    const { s } = makeSession()
    s.connect()
    FakeWS.instances[0].open()
    FakeWS.instances[0].emit({ type: 'ready', sessionId: 'sid-1' })
    FakeWS.instances[0].drop()

    expect(s.state.value).toBe('reconnecting')
    vi.advanceTimersByTime(500)
    expect(FakeWS.instances.length).toBe(2)
    const url = new URL(FakeWS.instances[1].url)
    expect(url.searchParams.get('session')).toBe('sid-1')
    // A re-attach must NOT carry a host id, or the server opens a new PTY.
    expect(url.searchParams.has('hostId')).toBe(false)
  })

  it('backs off exponentially and caps the delay', () => {
    const { s } = makeSession()
    s.connect()
    FakeWS.instances[0].open()

    // Drop repeatedly without ever opening: each retry schedules a longer wait.
    for (let i = 0; i < 8; i++) {
      FakeWS.instances[FakeWS.instances.length - 1].drop()
      // The delay after attempt n is min(400 * 2^(n-1), 8000).
      const expected = Math.min(400 * 2 ** i, 8000)
      const before = FakeWS.instances.length
      vi.advanceTimersByTime(expected - 1)
      expect(FakeWS.instances.length, `too early after attempt ${i + 1}`).toBe(before)
      vi.advanceTimersByTime(1)
      expect(FakeWS.instances.length, `did not retry after attempt ${i + 1}`).toBe(before + 1)
    }
  })

  // session_gone means the PTY is gone for good; retrying would spin forever.
  it('stops retrying when the session is gone', () => {
    const { s } = makeSession()
    s.connect()
    FakeWS.instances[0].open()
    FakeWS.instances[0].emit({ type: 'error', errcode: 'session_gone', message: 'gone' })

    expect(s.state.value).toBe('exited')
    expect(s.sessionId.value).toBe('')
    vi.advanceTimersByTime(60_000)
    expect(FakeWS.instances.length).toBe(1)
  })

  // Every error frame is terminal: the server decided the attempt failed and is
  // about to close the socket. Retrying would loop on the same failure.
  it.each([
    ['connect_failed', 'error'],
    ['auth_failed', 'error'],
    ['host_key_changed', 'error'],
    ['session_limit', 'error'],
    ['session_busy', 'error'],
    ['shell_failed', 'error'],
  ])('treats %s as terminal', (code, expected) => {
    const { s } = makeSession()
    s.connect()
    FakeWS.instances[0].open()
    FakeWS.instances[0].emit({ type: 'error', errcode: code, message: 'nope' })
    expect(s.state.value).toBe(expected)
    expect(s.errorCode.value).toBe(code)
    vi.advanceTimersByTime(60_000)
    expect(FakeWS.instances.length).toBe(1)
  })

  it('sends input frames only while open', () => {
    const { s } = makeSession()
    s.connect()
    // Not open yet: nothing must be written (the socket would throw).
    s.send('x')
    expect(FakeWS.instances[0].sent).toEqual([])

    FakeWS.instances[0].open()
    s.send('ls\n')
    expect(FakeWS.instances[0].frames()).toEqual([{ type: 'input', data: 'ls\n' }])
  })

  it('ignores empty input', () => {
    const { s } = makeSession()
    s.connect()
    FakeWS.instances[0].open()
    s.send('')
    expect(FakeWS.instances[0].sent).toEqual([])
  })

  // A resize is only sent when it CHANGES: the terminal recomputes its size on
  // every layout pass, and a frame per pass would flood the socket.
  it('sends a resize only when the geometry changes', () => {
    const { s } = makeSession()
    s.connect()
    FakeWS.instances[0].open()

    s.resize(80, 24) // same as the initial size
    expect(FakeWS.instances[0].sent).toEqual([])

    s.resize(100, 30)
    expect(FakeWS.instances[0].frames()).toEqual([{ type: 'resize', cols: 100, rows: 30 }])

    s.resize(100, 30)
    expect(FakeWS.instances[0].sent.length).toBe(1)
  })

  it('ignores a zero-size resize', () => {
    const { s } = makeSession()
    s.connect()
    FakeWS.instances[0].open()
    s.resize(0, 0)
    expect(FakeWS.instances[0].sent).toEqual([])
  })

  // detach() closes the socket WITHOUT ending the server session (tab switch);
  // close() is permanent. Getting them confused kills the shell on a tab click.
  it('detach closes the socket but does not retry', () => {
    const { s } = makeSession()
    s.connect()
    FakeWS.instances[0].open()
    s.detach()
    vi.advanceTimersByTime(60_000)
    expect(FakeWS.instances.length).toBe(1)
  })

  it('close prevents any further connection', () => {
    const { s } = makeSession()
    s.connect()
    FakeWS.instances[0].open()
    s.close()
    s.connect()
    vi.advanceTimersByTime(60_000)
    expect(FakeWS.instances.length).toBe(1)
  })

  it('ignores unparsable frames instead of throwing', () => {
    const { s, data } = makeSession()
    s.connect()
    const ws = FakeWS.instances[0]
    ws.open()
    // A non-JSON frame must not take the socket down.
    ws.onmessage?.({ data: 'not json' })
    ws.emit({ type: 'output', data: 'ok' })
    expect(data).toEqual(['ok'])
    expect(s.state.value).toBe('connected')
  })

  // A second connect() while one is in flight must not open a second socket:
  // two sockets would mean two owners of the same PTY.
  it('does not open a second socket while connecting', () => {
    const { s } = makeSession()
    s.connect()
    s.connect()
    expect(FakeWS.instances.length).toBe(1)
  })
})
