import { describe, expect, it } from 'vitest'
import { mixHex } from '../terminalTheme'

/**
 * `mixHex` backs the terminal's search-highlight colours, which are computed at
 * runtime from the active theme's accent. The addon requires plain `#RRGGBB`,
 * so anything that leaks an alpha channel or an unparsable value would silently
 * disable highlighting.
 */
describe('mixHex output format', () => {
  it('always emits a 7-character hex string for valid input', () => {
    for (const amount of [0, 0.1, 0.2, 0.55, 0.9, 1]) {
      const out = mixHex('#fe8019', 'black', amount)
      expect(out, `amount ${amount}`).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('darkens monotonically toward black', () => {
    const light = mixHex('#ffffff', 'black', 0.1)
    const dark = mixHex('#ffffff', 'black', 0.9)
    const value = (hex: string) => parseInt(hex.slice(1, 3), 16)
    expect(value(light)).toBeGreaterThan(value(dark))
  })

  // The active match must be visibly brighter than the inactive ones, which is
  // what distinguishes "the one you are on" from "the others".
  it('produces a brighter active colour than the inactive one', () => {
    const accent = '#fe8019'
    const inactive = parseInt(mixHex(accent, 'black', 0.55).slice(1, 3), 16)
    const active = parseInt(mixHex(accent, 'black', 0.2).slice(1, 3), 16)
    expect(active).toBeGreaterThan(inactive)
  })
})
