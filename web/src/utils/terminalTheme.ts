import type { ITheme } from '@xterm/xterm'
import { isDarkTheme } from '@/utils/themeMeta'

/**
 * Build an xterm palette from the app's own CSS custom properties.
 *
 * Deriving the colours instead of shipping a second 36-entry table means the
 * terminal can never drift from the app theme: every theme already defines the
 * semantic colours this needs, and they are the *theme author's* choice rather
 * than a generic ANSI guess.
 *
 * The ANSI slots that have no semantic equivalent in the app palette (bright
 * variants, magenta/cyan) are mixed from the ones that do, so they stay in the
 * same family under every theme.
 */

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** Mix a hex colour toward white or black by `amount` (0..1). */
export function mixHex(hex: string, toward: 'white' | 'black', amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const target = toward === 'white' ? 255 : 0
  const mix = (c: number) => Math.round(c + (target - c) * amount)
  const r = mix((n >> 16) & 0xff)
  const g = mix((n >> 8) & 0xff)
  const b = mix(n & 0xff)
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

export function buildXtermTheme(themeId: string): ITheme {
  const dark = isDarkTheme(themeId)
  const bg = readVar('--bg-primary', dark ? '#1d2021' : '#ffffff')
  const fg = readVar('--text-primary', dark ? '#ebdbb2' : '#1f2328')
  const accent = readVar('--accent-color', '#4a90d9')
  const red = readVar('--color-red', '#ef4444')
  const green = readVar('--color-green', '#22c55e')
  const yellow = readVar('--color-yellow', '#eab308')
  const blue = readVar('--color-info', accent)
  const magenta = readVar('--color-purple', '#a855f7')
  const cyan = readVar('--color-info', '#22d3ee')
  const muted = readVar('--text-muted', dark ? '#928374' : '#6e7781')
  const selection = readVar('--selection-bg', dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.14)')

  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: selection,
    // ANSI 0-7
    black: dark ? mixHex(bg, 'white', 0.16) : mixHex(fg, 'white', 0.55),
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: dark ? fg : mixHex(fg, 'white', 0.25),
    // ANSI 8-15 (bright)
    brightBlack: muted,
    brightRed: mixHex(red, 'white', dark ? 0.2 : 0.05),
    brightGreen: mixHex(green, 'white', dark ? 0.2 : 0.05),
    brightYellow: mixHex(yellow, 'white', dark ? 0.2 : 0.05),
    brightBlue: mixHex(blue, 'white', dark ? 0.2 : 0.05),
    brightMagenta: mixHex(magenta, 'white', dark ? 0.2 : 0.05),
    brightCyan: mixHex(cyan, 'white', dark ? 0.2 : 0.05),
    brightWhite: dark ? mixHex(fg, 'white', 0.4) : fg,
  }
}

/**
 * Font stacks offered in settings. `default` resolves to the platform's mono
 * stack, which on Android is Roboto Mono and on desktop the first installed
 * candidate — no font download, no first-paint reflow.
 */
export const TERMINAL_FONTS: Record<string, string> = {
  default: "'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  jetbrains: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
  firacode: "'Fira Code', 'SF Mono', Menlo, monospace",
  cascadia: "'Cascadia Code', 'SF Mono', Menlo, monospace",
  sourcecode: "'Source Code Pro', 'SF Mono', Menlo, monospace",
  ibmplex: "'IBM Plex Mono', 'SF Mono', Menlo, monospace",
}

export function terminalFontStack(id: string): string {
  return TERMINAL_FONTS[id] ?? TERMINAL_FONTS.default
}
