/**
 * Terminal wire protocol — mirrored in `internal/handler/terminal.go`.
 *
 * Frames are JSON text. Output is a string, not base64: the PTY emits UTF-8
 * text, and JSON escapes only the few control characters, so the wire form is
 * roughly the same size as base64 while staying readable in a packet capture
 * (which matters when debugging an escape-sequence problem).
 */

export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }

export type ServerMessage =
  | { type: 'ready'; sessionId: string; title?: string }
  | { type: 'replay'; data: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string; errcode?: string }
  | { type: 'pong' }

/** Error codes the UI branches on (anything else is shown verbatim). */
export const ErrCode = {
  sessionGone: 'session_gone',
  sessionBusy: 'session_busy',
  sessionLimit: 'session_limit',
  connectFailed: 'connect_failed',
  shellFailed: 'shell_failed',
  hostKeyChanged: 'host_key_changed',
  badRequest: 'bad_request',
  hostNotFound: 'host_not_found',
  writeFailed: 'write_failed',
} as const

/** Build the terminal WebSocket URL for a new or re-attached session. */
export function terminalWsUrl(opts: {
  hostId?: number
  sessionId?: string
  cols: number
  rows: number
  title?: string
}): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const q = new URLSearchParams()
  if (opts.sessionId) q.set('session', opts.sessionId)
  if (opts.hostId) q.set('hostId', String(opts.hostId))
  q.set('cols', String(opts.cols))
  q.set('rows', String(opts.rows))
  if (opts.title) q.set('title', opts.title)
  return `${proto}//${location.host}/api/terminal/ws?${q.toString()}`
}

/**
 * Keys the on-screen key bar can send.
 *
 * Escape sequences are the ones xterm-compatible shells expect in application
 * cursor mode (`ESC O x`), which is what most modern prompts negotiate. Sending
 * the CSI form instead makes arrow keys do nothing in zsh/vim's normal mode.
 */
export const KEY_SEQUENCES = {
  esc: '\x1b',
  tab: '\t',
  enter: '\r',
  backspace: '\x7f',
  up: '\x1bOA',
  down: '\x1bOB',
  right: '\x1bOC',
  left: '\x1bOD',
  home: '\x1bOH',
  end: '\x1bOF',
  pgup: '\x1b[5~',
  pgdn: '\x1b[6~',
  delete: '\x1b[3~',
  ctrlC: '\x03',
  ctrlD: '\x04',
  ctrlL: '\x0c',
  ctrlR: '\x12',
  ctrlZ: '\x1a',
} as const

export type KeyName = keyof typeof KEY_SEQUENCES

/**
 * Apply a one-shot Ctrl/Alt modifier to a printable character.
 *
 * Ctrl+<letter> is the ASCII control code (letter & 0x1f); Alt is an ESC
 * prefix, which is how readline receives Meta-<key>.
 */
export function applyModifiers(ch: string, ctrl: boolean, alt: boolean): string {
  let out = ch
  if (ctrl && /^[a-zA-Z@\[\]\\^_]$/.test(ch)) {
    out = String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f)
  }
  if (alt) out = '\x1b' + out
  return out
}
