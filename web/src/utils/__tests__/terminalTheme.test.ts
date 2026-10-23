import { describe, expect, it } from 'vitest'
import { buildXtermTheme, mixHex, terminalFontStack, TERMINAL_FONTS } from '../terminalTheme'
import { isDarkTheme, THEME_IDS } from '../themeMeta'

describe('mixHex', () => {
  it('returns white at amount 1 toward white', () => {
    expect(mixHex('#000000', 'white', 1)).toBe('#ffffff')
  })

  it('returns black at amount 1 toward black', () => {
    expect(mixHex('#ffffff', 'black', 1)).toBe('#000000')
  })

  it('leaves the colour unchanged at amount 0', () => {
    expect(mixHex('#336699', 'white', 0)).toBe('#336699')
  })

  // A non-hex input (a CSS variable that resolved to `rgb(...)` or a var()
  // expression) must pass through untouched rather than become "#NaNNaNNaN".
  it('passes through values it cannot parse', () => {
    expect(mixHex('rgb(1,2,3)', 'white', 0.5)).toBe('rgb(1,2,3)')
    expect(mixHex('var(--x)', 'white', 0.5)).toBe('var(--x)')
  })
})

describe('buildXtermTheme', () => {
  // Every theme must produce a complete palette: a missing slot makes xterm
  // render those cells in the browser default (usually invisible).
  it('produces every slot for every theme', () => {
    for (const id of THEME_IDS) {
      const t = buildXtermTheme(id)
      const slots = [
        'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground',
        'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
        'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
        'brightMagenta', 'brightCyan', 'brightWhite',
      ] as const
      for (const slot of slots) {
        expect(t[slot], `${id} is missing ${slot}`).toBeTruthy()
      }
    }
  })

  // The palette is derived from the APP theme, so a light theme must not get a
  // dark terminal background (and vice versa) — that was the bug this guards.
  it('keeps light themes light and dark themes dark', () => {
    for (const id of THEME_IDS) {
      const t = buildXtermTheme(id)
      const bg = (t.background ?? '').trim()
      if (!bg.startsWith('#')) continue // fallback value, nothing to assert
      const n = parseInt(bg.slice(1), 16)
      const luminance = ((n >> 16) & 0xff) * 0.299 + ((n >> 8) & 0xff) * 0.587 + (n & 0xff) * 0.114
      if (isDarkTheme(id)) {
        expect(luminance, `${id} should have a dark background`).toBeLessThan(128)
      } else {
        expect(luminance, `${id} should have a light background`).toBeGreaterThan(128)
      }
    }
  })
})

describe('terminalFontStack', () => {
  it('resolves every offered font id', () => {
    for (const id of Object.keys(TERMINAL_FONTS)) {
      expect(terminalFontStack(id)).toBe(TERMINAL_FONTS[id])
    }
  })

  // An unknown id (a stale localStorage value from an older build) must fall
  // back rather than set `fontFamily: undefined`, which xterm renders as a
  // serif font with broken cell metrics.
  it('falls back to the default for an unknown id', () => {
    expect(terminalFontStack('nope')).toBe(TERMINAL_FONTS.default)
  })
})
