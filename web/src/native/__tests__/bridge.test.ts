import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _pendingIds,
  _resetBridgeForTests,
  _settleForTests,
  available,
  call,
  installBridgeCallbacks,
  NativeError,
  on,
} from '../bridge'

interface FakeNative {
  invoke: (id: string, method: string, payload: string) => void
  calls: { id: string; method: string; payload: string }[]
}

/** Install a bridge that records calls and replies on demand. */
function installFake(): FakeNative {
  const fake: FakeNative = {
    calls: [],
    invoke(id, method, payload) {
      fake.calls.push({ id, method, payload })
    },
  }
  ;(window as unknown as Record<string, unknown>).ClawTermNative = fake
  installBridgeCallbacks()
  return fake
}

beforeEach(() => {
  _resetBridgeForTests()
  delete (window as unknown as Record<string, unknown>).ClawTermNative
  vi.useRealTimers()
})

describe('available', () => {
  it('is false in a plain browser', () => {
    expect(available()).toBe(false)
  })

  it('is true once the host exposes invoke', () => {
    installFake()
    expect(available()).toBe(true)
  })
})

describe('call', () => {
  // A missing bridge must reject immediately, not hang: the UI shows a
  // "this build needs the app shell" message instead of a spinner.
  it('rejects when there is no bridge', async () => {
    await expect(call('app.info')).rejects.toMatchObject({ code: 'no_bridge' })
  })

  it('sends the method and a JSON payload', async () => {
    const fake = installFake()
    void call('db.hosts.update', { id: 7, name: 'x' })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].method).toBe('db.hosts.update')
    expect(JSON.parse(fake.calls[0].payload)).toEqual({ id: 7, name: 'x' })
  })

  // A number must stay a number: the WebView bridge marshals objects
  // differently across versions, which is why everything is a JSON string.
  it('keeps numeric types through the payload', async () => {
    const fake = installFake()
    void call('ssh.resize', { cols: 100, rows: 30 })
    const parsed = JSON.parse(fake.calls[0].payload)
    expect(parsed.cols).toBe(100)
    expect(typeof parsed.rows).toBe('number')
  })

  it('resolves with the parsed reply', async () => {
    const fake = installFake()
    const p = call<{ id: number }>('db.hosts.create', {})
    _settleForTests(fake.calls[0].id, true, JSON.stringify({ id: 42 }))
    await expect(p).resolves.toEqual({ id: 42 })
  })

  it('resolves null for an empty reply', async () => {
    const fake = installFake()
    const p = call('auth.lock')
    _settleForTests(fake.calls[0].id, true, 'null')
    await expect(p).resolves.toBeNull()
  })

  // The host reports a failure with a code; the caller branches on the code and
  // shows the message only as a fallback.
  it('rejects with the message and code from a failed reply', async () => {
    const fake = installFake()
    const p = call('ssh.connect', {})
    _settleForTests(fake.calls[0].id, false,
      JSON.stringify({ message: 'wrong password', code: 'wrong_password' }))
    const err = await p.catch((e) => e as NativeError)
    expect(err).toBeInstanceOf(NativeError)
    expect(err.message).toBe('wrong password')
    expect(err.code).toBe('wrong_password')
  })

  // A non-JSON error body is still a message; losing it would leave the user
  // with "unknown error".
  it('keeps a non-JSON error body as the message', async () => {
    const fake = installFake()
    const p = call('ssh.test', {})
    _settleForTests(fake.calls[0].id, false, 'boom')
    const err = await p.catch((e) => e as NativeError)
    expect(err.message).toBe('boom')
  })

  // Two concurrent calls must not settle each other's promises. This is the
  // classic bridge bug and it only shows up under concurrency.
  it('correlates concurrent requests independently', async () => {
    const fake = installFake()
    const a = call<{ v: string }>('db.hosts.list')
    const b = call<{ v: string }>('db.snippets.list')
    expect(fake.calls).toHaveLength(2)
    // Reply to the SECOND one first.
    _settleForTests(fake.calls[1].id, true, JSON.stringify({ v: 'snippets' }))
    _settleForTests(fake.calls[0].id, true, JSON.stringify({ v: 'hosts' }))
    await expect(a).resolves.toEqual({ v: 'hosts' })
    await expect(b).resolves.toEqual({ v: 'snippets' })
  })

  it('drops a late reply after the request timed out', async () => {
    vi.useFakeTimers()
    const fake = installFake()
    const p = call('app.info')
    const err = p.catch((e) => e as NativeError)
    vi.advanceTimersByTime(21_000)
    expect((await err).code).toBe('timeout')
    expect(_pendingIds()).toHaveLength(0)

    // A reply arriving now must not throw or resolve anything.
    expect(() => _settleForTests(fake.calls[0].id, true, '{}')).not.toThrow()
  })

  it('rejects immediately when the bridge itself throws', async () => {
    ;(window as unknown as Record<string, unknown>).ClawTermNative = {
      invoke() { throw new Error('bridge exploded') },
    }
    installBridgeCallbacks()
    const err = await call('app.info').catch((e) => e as NativeError)
    expect(err.code).toBe('bridge_throw')
  })
})

describe('on', () => {
  function emit(type: string, payload: unknown) {
    ;(window as unknown as Record<string, unknown>).__clawtermNativeEvent?.(type, JSON.stringify(payload))
  }

  it('delivers events to subscribers', () => {
    installFake()
    const seen: unknown[] = []
    on('terminal.data', (p) => seen.push(p))
    emit('terminal.data', { sessionId: 's1', data: 'abc' })
    expect(seen).toEqual([{ sessionId: 's1', data: 'abc' }])
  })

  it('stops after unsubscribe', () => {
    installFake()
    const seen: unknown[] = []
    const off = on('terminal.exit', (p) => seen.push(p))
    off()
    emit('terminal.exit', { sessionId: 's1', code: 0 })
    expect(seen).toHaveLength(0)
  })

  // A throwing listener must not stop the others: a terminal stream is
  // broadcast to every open view, and one bad view would kill the rest.
  it('isolates a throwing listener', () => {
    installFake()
    const seen: string[] = []
    on('terminal.data', () => { throw new Error('bad listener') })
    on('terminal.data', () => seen.push('ok'))
    emit('terminal.data', { sessionId: 's', data: '' })
    expect(seen).toEqual(['ok'])
  })

  it('ignores an event with no subscribers', () => {
    installFake()
    expect(() => emit('terminal.data', { sessionId: 'x' })).not.toThrow()
  })

  it('ignores an unparsable payload', () => {
    installFake()
    const seen: unknown[] = []
    on('terminal.data', (p) => seen.push(p))
    ;(window as unknown as Record<string, unknown>).__clawtermNativeEvent?.('terminal.data', 'not json')
    expect(seen).toHaveLength(0)
  })
})
