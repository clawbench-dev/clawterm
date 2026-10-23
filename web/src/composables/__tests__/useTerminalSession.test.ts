import { beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetBridgeForTests, installBridgeCallbacks } from '@/native/bridge'

/**
 * The terminal session over the native bridge.
 *
 * The interesting parts are the ones a real device exercises and a browser test
 * cannot: base64 decoding across chunk boundaries, event filtering by session
 * id, and the reconnect policy.
 */

interface FakeNative {
  invoke: (id: string, method: string, payload: string) => void
  calls: { id: string; method: string; payload: unknown }[]
}

let fake: FakeNative
/** Reply behaviour per method; defaults to success. */
let reply: (method: string, payload: unknown) => { ok: boolean; result: unknown; code?: string }

function install() {
  fake = {
    calls: [],
    invoke(id, method, payload) {
      const parsed = payload ? JSON.parse(payload) : null
      fake.calls.push({ id, method, payload: parsed })
      const r = reply(method, parsed)
      // Reply on a microtask, not a timer: the tests switch to fake timers for
      // the retry logic, and a timer-based reply would never fire there.
      Promise.resolve().then(() => {
        if (r.ok) {
          (window as unknown as Record<string, unknown>).__clawtermNativeResolve?.(
            id, true, JSON.stringify(r.result ?? null))
        } else {
          (window as unknown as Record<string, unknown>).__clawtermNativeResolve?.(
            id, false, JSON.stringify({ message: r.result ?? 'failed', code: r.code }))
        }
      })
    },
  }
  ;(window as unknown as Record<string, unknown>).ClawTermNative = fake
  installBridgeCallbacks()
}

function emit(type: string, payload: unknown) {
  ;(window as unknown as Record<string, unknown>).__clawtermNativeEvent?.(type, JSON.stringify(payload))
}

/** Encode a UTF-8 string as base64, the way the host does. */
function b64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

beforeEach(() => {
  _resetBridgeForTests()
  delete (window as unknown as Record<string, unknown>).ClawTermNative
  reply = () => ({ ok: true, result: { sessionId: 'sess-1' } })
  vi.useRealTimers()
})

describe('TerminalSession over the bridge', () => {
  it('connects and records the session id', async () => {
    install()
    const { TerminalSession } = await import('@/composables/useTerminalSession')
    const ids: string[] = []
    const s = new TerminalSession({
      hostId: 1, title: 't', cols: 80, rows: 24,
      onData: () => {}, onSessionId: (id) => ids.push(id),
    })
    await s.connect()
    expect(s.state.value).toBe('connected')
    expect(s.sessionId.value).toBe('sess-1')
    expect(ids).toEqual(['sess-1'])
  })

  it('sends the initial geometry', async () => {
    install()
    const { TerminalSession } = await import('@/composables/useTerminalSession')
    const s = new TerminalSession({ hostId: 1, title: 't', cols: 100, rows: 30, onData: () => {} })
    await s.connect()
    const connectCall = fake.calls.find((c) => c.method === 'ssh.connect')
    expect(connectCall?.payload).toMatchObject({ hostId: 1, cols: 100, rows: 30 })
  })

  it('decodes base64 output to text', async () => {
    install()
    const { TerminalSession } = await import('@/composables/useTerminalSession')
    const got: string[] = []
    const s = new TerminalSession({ hostId: 1, title: 't', cols: 80, rows: 24, onData: (d) => got.push(d) })
    await s.connect()
    emit('terminal.data', { sessionId: 'sess-1', data: b64('hello\r\n') })
    expect(got).toEqual(['hello\r\n'])
  })

  // The bug this guards: a multi-byte character split across two chunks must be
  // held, not turned into two replacement characters. `TextDecoder` with
  // `stream: true` is what makes that work.
  it('reassembles a multi-byte character split across chunks', async () => {
    install()
    const { TerminalSession } = await import('@/composables/useTerminalSession')
    const got: string[] = []
    const s = new TerminalSession({ hostId: 1, title: 't', cols: 80, rows: 24, onData: (d) => got.push(d) })
    await s.connect()

    // '中' is E4 B8 AD in UTF-8. Split after the first byte.
    const full = new TextEncoder().encode('中')
    const first = btoa(String.fromCharCode(full[0]))
    const rest = btoa(String.fromCharCode(full[1], full[2]))

    emit('terminal.data', { sessionId: 'sess-1', data: first })
    emit('terminal.data', { sessionId: 'sess-1', data: rest })

    const joined = got.join('')
    expect(joined).toBe('中')
    expect(joined).not.toContain('\uFFFD')
  })

  // Two open tabs share the event stream; a chunk addressed to one must not be
  // written into the other's buffer.
  it('ignores data addressed to another session', async () => {
    install()
    const { TerminalSession } = await import('@/composables/useTerminalSession')
    const got: string[] = []
    const s = new TerminalSession({ hostId: 1, title: 't', cols: 80, rows: 24, onData: (d) => got.push(d) })
    await s.connect()
    emit('terminal.data', { sessionId: 'someone-else', data: b64('nope') })
    emit('terminal.data', { sessionId: 'sess-1', data: b64('mine') })
    expect(got).toEqual(['mine'])
  })

  it('reports the exit code', async () => {
    install()
    const { TerminalSession } = await import('@/composables/useTerminalSession')
    const codes: number[] = []
    const s = new TerminalSession({
      hostId: 1, title: 't', cols: 80, rows: 24, onData: () => {}, onExit: (c) => codes.push(c),
    })
    await s.connect()
    emit('terminal.exit', { sessionId: 'sess-1', code: 3 })
    expect(s.state.value).toBe('exited')
    expect(codes).toEqual([3])
  })

  // A dropped connection is NOT a dead shell: the host keeps the PTY, so a
  // retry must re-attach by session id rather than opening a new one.
  it('re-attaches by session id when a connect fails with a transport error', async () => {
    vi.useFakeTimers()
    install()
    const { TerminalSession } = await import('@/composables/useTerminalSession')

    // First connect succeeds, so the id is known.
    let attempts = 0
    reply = (method) => {
      if (method === 'ssh.connect') {
        attempts++
        if (attempts === 2) return { ok: false, result: 'socket died', code: 'write_failed' }
      }
      return { ok: true, result: { sessionId: 'sess-1' } }
    }

    const s = new TerminalSession({ hostId: 1, title: 't', cols: 80, rows: 24, onData: () => {} })
    await s.connect()
    expect(s.sessionId.value).toBe('sess-1')

    // Force a reconnect; the second attempt fails with a retryable code.
    const reconnect = s.connect()
    await vi.advanceTimersByTimeAsync(1)
    await reconnect
    expect(s.state.value).toBe('reconnecting')

    // The retry must carry the session id.
    await vi.advanceTimersByTimeAsync(600)
    const calls = fake.calls.filter((c) => c.method === 'ssh.connect')
    const retry = calls[calls.length - 1]
    expect(retry.payload).toMatchObject({ sessionId: 'sess-1' })
  })

  it('sends keystrokes with the session id', async () => {
    install()
    const { TerminalSession } = await import('@/composables/useTerminalSession')
    const s = new TerminalSession({ hostId: 1, title: 't', cols: 80, rows: 24, onData: () => {} })
    await s.connect()
    s.send('ls\n')
    const write = fake.calls.find((c) => c.method === 'ssh.write')
    expect(write?.payload).toEqual({ sessionId: 'sess-1', data: 'ls\n' })
  })

  it('drops empty input', async () => {
    install()
    const { TerminalSession } = await import('@/composables/useTerminalSession')
    const s = new TerminalSession({ hostId: 1, title: 't', cols: 80, rows: 24, onData: () => {} })
    await s.connect()
    s.send('')
    expect(fake.calls.some((c) => c.method === 'ssh.write')).toBe(false)
  })

  // The terminal recomputes its size on every layout pass; a frame per pass
  // would flood the bridge.
  it('sends a resize only when the geometry changes', async () => {
    install()
    const { TerminalSession } = await import('@/composables/useTerminalSession')
    const s = new TerminalSession({ hostId: 1, title: 't', cols: 80, rows: 24, onData: () => {} })
    await s.connect()
    s.resize(80, 24) // unchanged
    expect(fake.calls.filter((c) => c.method === 'ssh.resize')).toHaveLength(0)
    s.resize(100, 30)
    expect(fake.calls.filter((c) => c.method === 'ssh.resize')).toHaveLength(1)
  })

  it('closes the native session on close', async () => {
    install()
    const { TerminalSession } = await import('@/composables/useTerminalSession')
    const s = new TerminalSession({ hostId: 1, title: 't', cols: 80, rows: 24, onData: () => {} })
    await s.connect()
    s.close()
    await Promise.resolve()
    const close = fake.calls.find((c) => c.method === 'ssh.close')
    expect(close?.payload).toEqual({ sessionId: 'sess-1' })
  })

  // session_gone means the PTY is really dead: retrying would spin forever.
  it('stops on session_gone', async () => {
    vi.useFakeTimers()
    install()
    reply = (method) => (method === 'ssh.connect'
      ? { ok: false, result: 'gone', code: 'session_gone' }
      : { ok: true, result: null })

    const { TerminalSession } = await import('@/composables/useTerminalSession')
    const s = new TerminalSession({ hostId: 1, title: 't', cols: 80, rows: 24, onData: () => {} })
    await s.connect()
    expect(s.state.value).toBe('exited')

    const before = fake.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fake.calls.length).toBe(before)
  })

  // A wrong password is not retryable without user action, but the tab must stay
  // usable so "reconnect" works after they fix the host.
  it('does not retry an auth failure', async () => {
    vi.useFakeTimers()
    install()
    reply = (method) => (method === 'ssh.connect'
      ? { ok: false, result: 'auth fail', code: 'auth_failed' }
      : { ok: true, result: null })

    const { TerminalSession } = await import('@/composables/useTerminalSession')
    const s = new TerminalSession({ hostId: 1, title: 't', cols: 80, rows: 24, onData: () => {} })
    await s.connect()
    expect(s.state.value).toBe('error')
    expect(s.errorCode.value).toBe('auth_failed')

    const before = fake.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fake.calls.length).toBe(before)
  })
})
