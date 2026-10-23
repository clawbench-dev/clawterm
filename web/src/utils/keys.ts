/**
 * Terminal key sequences.
 *
 * ## Why application-cursor mode
 *
 * Arrows are sent as `ESC O x` (application cursor keys), which is what modern
 * shells and full-screen programs negotiate. The CSI form (`ESC [ x`) is
 * silently ignored by zsh's and vim's normal mode, which reads as "the arrow key
 * does nothing".
 *
 * ## Where these are used
 *
 * Only the on-screen key bar and the gesture recogniser. Real keystrokes from a
 * physical or soft keyboard go to xterm's own textarea and are encoded by xterm
 * itself — re-encoding them here would double-escape them.
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
  if (ctrl && /^[a-zA-Z@[\]\\^_]$/.test(ch)) {
    out = String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f)
  }
  if (alt) out = '\x1b' + out
  return out
}
