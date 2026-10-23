import { call } from './bridge'

/**
 * Typed wrappers over the bridge.
 *
 * The rest of the app imports these instead of raw `call('db.hosts.list')`
 * strings: a typo in a method name becomes a compile error rather than a
 * runtime "unknown method" from the host.
 */

export interface Host {
  id: number
  name: string
  address: string
  port: number
  username: string
  authType: 'password' | 'key' | 'agent'
  keyPath: string
  hasPassword: boolean
  hasPassphrase: boolean
  color: string
  group: string
  lastUsedAt: number
  createdAt: string
  updatedAt: string
}

export interface HostPayload {
  name: string
  address: string
  port: number
  username: string
  authType: 'password' | 'key' | 'agent'
  keyPath: string
  password: string
  passphrase: string
  color: string
  group: string
}

export interface Snippet {
  id: number
  label: string
  command: string
  hostId: number
  send: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface SnippetPayload {
  label: string
  command: string
  hostId: number
  send: boolean
}

export interface ForwardRule {
  id: number
  hostId: number
  localPort: number
  remoteHost: string
  remotePort: number
  autoStart: boolean
  running: boolean
  error?: string
  connections: number
}

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  isLink: boolean
  size: number
  mode: string
  modTime: number
}

export interface DirListing {
  path: string
  entries: FileEntry[]
}

export interface FileContent {
  path: string
  size: number
  truncated: boolean
  /** Base64 for binary, plain text for text. `isBinary` says which. */
  content: string
  isBinary: boolean
}

export interface TestResult {
  ok: boolean
  latency: number
  notice: string
  addr: string
}

export interface AuthStatus {
  authenticated: boolean
  needsSetup: boolean
}

export interface AppInfo {
  version: string
  platform: string
  sdk: number
}

/** Errors the host reports with a stable code. */
export const ErrorCode = {
  hostKeyChanged: 'host_key_changed',
  authFailed: 'auth_failed',
  connectionRefused: 'connection_refused',
  timeout: 'timeout',
  hostNotFound: 'host_not_found',
  dialFailed: 'dial_failed',
  sessionGone: 'session_gone',
  sessionLimit: 'session_limit',
  sessionBusy: 'session_busy',
  wrongPassword: 'wrong_password',
  notFound: 'not_found',
} as const

// ── auth ────────────────────────────────────────────────────────────────────

export const authStatus = () => call<AuthStatus>('auth.status')
export const authSetup = (password: string) => call<void>('auth.setup', { password })
export const authVerify = (password: string) => call<void>('auth.verify', { password })
export const authChange = (oldPassword: string, newPassword: string) =>
  call<void>('auth.change', { oldPassword, newPassword })
export const authLock = () => call<void>('auth.lock')

// ── hosts ───────────────────────────────────────────────────────────────────

export const listHosts = () => call<Host[]>('db.hosts.list')
export const createHost = (p: HostPayload) => call<Host>('db.hosts.create', p)
export const updateHost = (id: number, p: HostPayload) => call<Host>('db.hosts.update', { id, ...p })
export const deleteHost = (id: number) => call<void>('db.hosts.delete', { id })
export const testHost = (id: number) => call<TestResult>('ssh.test', { id })
export const acceptHostKey = (id: number) => call<void>('ssh.acceptHostKey', { id })

// ── snippets ────────────────────────────────────────────────────────────────

export const listSnippets = (hostId = 0) => call<Snippet[]>('db.snippets.list', { hostId })
export const createSnippet = (p: SnippetPayload) => call<Snippet>('db.snippets.create', p)
export const updateSnippet = (id: number, p: SnippetPayload) =>
  call<void>('db.snippets.update', { id, ...p })
export const deleteSnippet = (id: number) => call<void>('db.snippets.delete', { id })
export const reorderSnippets = (ids: number[]) => call<void>('db.snippets.reorder', { ids })

// ── forwards ────────────────────────────────────────────────────────────────

export const listForwards = () => call<ForwardRule[]>('forward.list')
export const startForward = (p: {
  hostId: number
  localPort: number
  remoteHost: string
  remotePort: number
  autoStart: boolean
}) => call<ForwardRule>('forward.start', p)
export const stopForward = (localPort: number) => call<void>('forward.stop', { localPort })

// ── sftp ────────────────────────────────────────────────────────────────────

export const listDir = (hostId: number, path: string) =>
  call<DirListing>('sftp.list', { hostId, path })
export const readFile = (hostId: number, path: string) =>
  call<FileContent>('sftp.read', { hostId, path })
/** Returns the saved local path after the system picker confirms the download. */
export const downloadFile = (hostId: number, path: string) =>
  call<{ saved: boolean; path?: string }>('sftp.download', { hostId, path })

// ── ssh sessions ────────────────────────────────────────────────────────────

export interface SessionInfo {
  id: string
  hostId: number
  title: string
  state: string
  exited: boolean
  code: number
}

export const listSessions = () => call<SessionInfo[]>('ssh.sessions')
export const connectSession = (p: {
  hostId: number
  cols: number
  rows: number
  title: string
  /** Present when re-attaching to a session that already exists. */
  sessionId?: string
}) => call<{ sessionId: string }>('ssh.connect', p)
export const writeSession = (sessionId: string, data: string) =>
  call<void>('ssh.write', { sessionId, data })
export const resizeSession = (sessionId: string, cols: number, rows: number) =>
  call<void>('ssh.resize', { sessionId, cols, rows })
export const closeSession = (sessionId: string) => call<void>('ssh.close', { sessionId })

// ── app ─────────────────────────────────────────────────────────────────────

export const appInfo = () => call<AppInfo>('app.info')
