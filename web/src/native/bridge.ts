import { appLog } from '@/utils/appLog'
import type { BridgeError, Method, EventType } from './protocol'

/**
 * Client for the native bridge.
 *
 * The app is a pure client: there is no HTTP server and no WebSocket. Every
 * data operation (hosts, snippets, files, SSH) goes through the host process via
 * `window.ClawTermNative`. This module is the only place that knows that.
 *
 * ## Why a promise registry
 *
 * The bridge is request/response over a callback that native calls back into JS.
 * Requests therefore need a correlation id and a pending-promise table. Without
 * one, two concurrent calls (a terminal opening while the host list refreshes)
 * would resolve each other's promises — the classic bridge bug that only shows
 * up under load.
 *
 * ## Failure modes that must not hang the UI
 *
 *   - The host never calls back (a native crash mid-call). Every request has a
 *     timeout; on expiry the promise rejects and the table entry is dropped.
 *   - The host throws. Native reports `ok=false` with a message, which becomes a
 *     rejected promise with a stable `code`.
 *   - The bridge is missing entirely (running in a plain browser). `available()`
 *     reports false so the app can say "this build needs the app shell" instead
 *     of silently doing nothing.
 */

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

/** Rejection for a bridge-level failure (not a network error — there is none). */
export class NativeError extends Error {
  code?: string
  details?: Record<string, unknown>

  constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'NativeError'
    this.code = code
    this.details = details
  }
}

/** How long to wait for the host before giving up on a request. */
const DEFAULT_TIMEOUT_MS = 20_000
/** SFTP reads of a large file legitimately take longer. */
const SLOW_TIMEOUT_MS = 120_000
const SLOW_METHODS = new Set<string>(['sftp.read', 'sftp.download', 'ssh.connect', 'ssh.test'])

interface NativeBridge {
  invoke: (id: string, method: string, payload: string) => void
  isNativeApp?: () => boolean
  getAppVersion?: () => string
}

const pending = new Map<string, Pending>()
const listeners = new Map<EventType, Set<(payload: Record<string, unknown>) => void>>()
let seq = 0

function bridge(): NativeBridge | null {
  const b = (window as unknown as { ClawTermNative?: NativeBridge }).ClawTermNative
  return b && typeof b.invoke === 'function' ? b : null
}

/** Whether the app is running inside the native shell. */
export function available(): boolean {
  return bridge() !== null
}

/**
 * Call a native method.
 *
 * `payload` is serialised here rather than by the bridge: the WebView bridge
 * marshals objects differently across versions (numbers arrive as strings on
 * some), so JSON strings are the only shape that behaves the same everywhere.
 */
export function call<T = unknown>(method: Method, payload?: unknown): Promise<T> {
  const b = bridge()
  if (!b) {
    return Promise.reject(new NativeError('not running in the app shell', 'no_bridge'))
  }

  const id = `r${++seq}`
  const timeout = SLOW_METHODS.has(method) ? SLOW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      appLog.w('Bridge', `${method} timed out after ${timeout}ms`)
      reject(new NativeError(`${method} timed out`, 'timeout'))
    }, timeout)

    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method })

    try {
      b.invoke(id, method, JSON.stringify(payload ?? null))
    } catch (err) {
      // A throw here means the bridge itself is broken (the method is not
      // exposed, or the host object was replaced). Surface it immediately
      // rather than waiting out the timeout.
      clearTimeout(timer)
      pending.delete(id)
      reject(new NativeError(String(err), 'bridge_throw'))
    }
  })
}

/**
 * Called by the host to settle a request.
 *
 * Exposed on `window` because the bridge calls INTO the page by name; there is
 * no other channel. The function is installed at module load so a reply that
 * arrives before any call (possible when the host is fast) is not lost.
 */
function settle(requestId: string, ok: boolean, resultJson: string): void {
  const entry = pending.get(requestId)
  if (!entry) {
    // A late reply after a timeout. Dropping it is correct: the caller has
    // already moved on, and resolving now would deliver a result to nobody.
    appLog.d('Bridge', `late reply for ${requestId}`)
    return
  }
  pending.delete(requestId)
  clearTimeout(entry.timer)

  if (ok) {
    try {
      entry.resolve(resultJson ? JSON.parse(resultJson) : null)
    } catch (err) {
      entry.reject(new NativeError(`unparsable reply: ${String(err)}`, 'bad_reply'))
    }
    return
  }

  let parsed: BridgeError = { message: resultJson || 'unknown error' }
  try {
    const obj = JSON.parse(resultJson) as BridgeError
    if (obj && typeof obj.message === 'string') parsed = obj
  } catch {
    // A non-JSON error body is still a message; keep it as-is.
  }
  entry.reject(new NativeError(parsed.message, parsed.code, parsed.details))
}

/** Called by the host to push an unsolicited event. */
function emit(type: string, payloadJson: string): void {
  const set = listeners.get(type as EventType)
  if (!set || set.size === 0) return
  let payload: Record<string, unknown> = {}
  try {
    payload = payloadJson ? JSON.parse(payloadJson) : {}
  } catch {
    appLog.w('Bridge', `unparsable event payload for ${type}`)
    return
  }
  for (const fn of set) {
    try {
      fn(payload)
    } catch (err) {
      // One bad listener must not stop the others: a terminal stream is
      // broadcast to every open view.
      appLog.e('Bridge', `listener for ${type} threw`, String(err))
    }
  }
}

/** Subscribe to a native event. Returns an unsubscribe function. */
export function on(type: EventType, fn: (payload: Record<string, unknown>) => void): () => void {
  let set = listeners.get(type)
  if (!set) {
    set = new Set()
    listeners.set(type, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
  }
}

/** Install the callbacks the host invokes. Called once at startup. */
export function installBridgeCallbacks(): void {
  const w = window as unknown as Record<string, unknown>
  // Assign unconditionally: a stale callback from a previous page (bfcache) must
  // be replaced, or replies would settle promises that no longer exist.
  w.__clawtermNativeResolve = settle
  w.__clawtermNativeEvent = emit
}

/** @internal test helper */
export function _resetBridgeForTests(): void {
  for (const [, entry] of pending) clearTimeout(entry.timer)
  pending.clear()
  listeners.clear()
  seq = 0
}

/** @internal test helper: settle a request as if the host replied. */
export function _settleForTests(id: string, ok: boolean, result: string): void {
  settle(id, ok, result)
}

/** @internal test helper: the ids currently waiting for a reply. */
export function _pendingIds(): string[] {
  return [...pending.keys()]
}
