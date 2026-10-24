/**
 * The native bridge protocol.
 *
 * ## Why one generic method instead of one per operation
 *
 * `@JavascriptInterface` methods are looked up by NAME from JavaScript, so every
 * additional one is another string that must match on both sides, another entry
 * in the ProGuard keep list, and another thing that fails silently when renamed.
 * One `invoke(requestId, method, payload)` entry point collapses all of that:
 * the method names live in ONE TypeScript union, the Java side is a single
 * `switch`, and an unknown name fails with a clear error instead of an opaque
 * "Java exception was raised".
 *
 * ## Shape
 *
 *   JS  → native : ClawTermNative.invoke(requestId, method, payloadJson)
 *   native → JS : window.__clawtermNativeResolve(requestId, ok, resultJson)
 *   native → JS : window.__clawtermNativeEvent(type, payloadJson)
 *
 * Everything is JSON strings: passing objects across the WebView bridge relies
 * on the bridge's own marshalling, which differs between WebView versions and
 * silently turns numbers into strings on some of them.
 */

/** A request that expects a reply. */
export type Method =
  // ── local storage (no network, no server) ──
  | 'db.hosts.list'
  | 'db.hosts.create'
  | 'db.hosts.update'
  | 'db.hosts.delete'
  | 'db.hosts.touch'
  | 'db.snippets.list'
  | 'db.snippets.create'
  | 'db.snippets.update'
  | 'db.snippets.delete'
  | 'db.snippets.reorder'
  | 'db.settings.get'
  | 'db.settings.set'
  // ── local access password (a device gate, not an account) ──
  | 'auth.status'
  | 'auth.setup'
  | 'auth.verify'
  | 'auth.change'
  | 'auth.lock'
  // ── ssh ──
  | 'ssh.test'
  | 'ssh.connect'
  | 'ssh.write'
  | 'ssh.resize'
  | 'ssh.close'
  | 'ssh.sessions'
  | 'ssh.acceptHostKey'
  // ── sftp ──
  | 'sftp.list'
  | 'sftp.read'
  | 'sftp.download'
  // ── misc ──
  | 'app.info'

/** Events pushed from native without a reply. */
export type EventType =
  /** Raw PTY bytes, base64 (a terminal stream is binary-safe). */
  | 'terminal.data'
  | 'terminal.exit'
  /** Connection state change: connecting / connected / reconnecting / error. */
  | 'terminal.state'

export interface BridgeRequest {
  method: Method
  payload?: unknown
}

export interface NativeEvent {
  type: EventType
  payload: Record<string, unknown>
}

/** Error shape thrown by the bridge, mirroring the old API layer's ApiError. */
export interface BridgeError {
  message: string
  code?: string
  details?: Record<string, unknown>
}
