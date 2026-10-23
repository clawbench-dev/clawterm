import { describe, expect, it } from 'vitest'
import {
  backgroundLuminance,
  isDarkTerminalTheme,
  parseHexColor,
  SORTED_TERMINAL_THEME_IDS,
  TERMINAL_THEME_BACKGROUNDS,
  TERMINAL_THEME_IDS,
  TERMINAL_THEME_AUTO,
} from '../terminalThemes'

describe('terminal palette data', () => {
  it('has a unique id per palette', () => {
    expect(new Set(TERMINAL_THEME_IDS).size).toBe(TERMINAL_THEME_IDS.length)
  })

  // 'auto' is not a palette: it means "derive from the app theme", so it must
  // never appear in the data list or the picker would offer it twice.
  it('does not include auto among the palettes', () => {
    expect(TERMINAL_THEME_IDS).not.toContain(TERMINAL_THEME_AUTO)
  })

  // The sort list drives the picker; dropping or duplicating an id makes a
  // scheme unreachable.
  it('sorts every palette exactly once', () => {
    expect(SORTED_TERMINAL_THEME_IDS.length).toBe(TERMINAL_THEME_IDS.length)
    expect(new Set(SORTED_TERMINAL_THEME_IDS).size).toBe(TERMINAL_THEME_IDS.length)
    expect([...SORTED_TERMINAL_THEME_IDS].sort()).toEqual([...TERMINAL_THEME_IDS].sort())
  })

  // Light-to-dark is what makes the list scannable; a reversed sort would put
  // every dark scheme above the light ones.
  it('orders by descending luminance for the ones that have a background', () => {
    const withBg = SORTED_TERMINAL_THEME_IDS.filter((id) => TERMINAL_THEME_BACKGROUNDS[id] != null)
    for (let i = 1; i < withBg.length; i++) {
      const prev = backgroundLuminance(TERMINAL_THEME_BACKGROUNDS[withBg[i - 1]]!)
      const cur = backgroundLuminance(TERMINAL_THEME_BACKGROUNDS[withBg[i]]!)
      expect(cur, `${withBg[i]} should not be lighter than ${withBg[i - 1]}`).toBeLessThanOrEqual(prev)
    }
  })

  // Background-less palettes inherit the terminal default, so they belong at the
  // end rather than interleaved (their luminance would all read as 0).
  it('puts the background-less palettes last', () => {
    const firstWithout = SORTED_TERMINAL_THEME_IDS.findIndex((id) => TERMINAL_THEME_BACKGROUNDS[id] == null)
    if (firstWithout === -1) return
    for (let i = firstWithout; i < SORTED_TERMINAL_THEME_IDS.length; i++) {
      expect(TERMINAL_THEME_BACKGROUNDS[SORTED_TERMINAL_THEME_IDS[i]], SORTED_TERMINAL_THEME_IDS[i]).toBeNull()
    }
  })

  it('has a background entry for every id', () => {
    for (const id of TERMINAL_THEME_IDS) {
      expect(TERMINAL_THEME_BACKGROUNDS, `missing background for ${id}`).toHaveProperty(id)
    }
  })
})

describe('parseHexColor', () => {
  it('parses 6-digit hex', () => {
    expect(parseHexColor('#1d2021')).toEqual([29, 32, 33])
  })

  it('expands 3-digit hex', () => {
    expect(parseHexColor('#fff')).toEqual([255, 255, 255])
  })

  it('rejects malformed input', () => {
    expect(parseHexColor('rgb(1,2,3)')).toBeNull()
    expect(parseHexColor('#12345')).toBeNull()
    expect(parseHexColor('#gggggg')).toBeNull()
  })
})

describe('isDarkTerminalTheme', () => {
  it('classifies a known dark palette as dark', () => {
    expect(isDarkTerminalTheme('Dracula')).toBe(true)
  })

  it('classifies a known light palette as light', () => {
    expect(isDarkTerminalTheme('Solarized_Light')).toBe(false)
  })

  // A palette without a background inherits the terminal default, which is the
  // app theme's; the answer must not throw.
  it('falls back for a palette with no background', () => {
    expect(typeof isDarkTerminalTheme('default')).toBe('boolean')
  })
})
