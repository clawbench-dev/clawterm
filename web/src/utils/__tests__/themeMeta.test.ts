import { describe, expect, it } from 'vitest'
import { DARK_DEFAULT, isDarkTheme, LIGHT_DEFAULT, resolveTheme, THEME_IDS, THEMES, themeMeta } from '../themeMeta'

describe('theme registry', () => {
  // THEME_IDS is derived from THEMES, so a mismatch means someone hand-edited
  // one of them. The picker and the CSS blocks must agree exactly.
  it('has a unique id per theme', () => {
    expect(new Set(THEME_IDS).size).toBe(THEME_IDS.length)
  })

  it('classifies every theme as dark or light, never neither', () => {
    const dark = THEME_IDS.filter(isDarkTheme)
    const light = THEME_IDS.filter((id) => !isDarkTheme(id))
    expect(dark.length + light.length).toBe(THEME_IDS.length)
    expect(dark.length).toBeGreaterThan(0)
    expect(light.length).toBeGreaterThan(0)
  })

  // Every theme needs the three swatch colours: a row without them renders as a
  // blank circle in the picker.
  it('gives every theme a complete preview', () => {
    for (const t of THEMES) {
      expect(t.preview.bg, t.id).toMatch(/^#[0-9a-f]{6}$/i)
      expect(t.preview.text, t.id).toMatch(/^#[0-9a-f]{6}$/i)
      expect(t.preview.accent, t.id).toMatch(/^#[0-9a-f]{6}$/i)
      expect(t.statusBar, t.id).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('looks up by id and reports unknown ids', () => {
    expect(themeMeta('dracula')?.dark).toBe(true)
    expect(themeMeta('nope')).toBeUndefined()
  })

  it('resolves the two defaults consistently', () => {
    expect(isDarkTheme(DARK_DEFAULT)).toBe(true)
    expect(isDarkTheme(LIGHT_DEFAULT)).toBe(false)
  })
})

describe('resolveTheme', () => {
  // 'auto' must never survive resolution: the CSS blocks are keyed by concrete
  // ids, and an unresolved 'auto' would leave the document unstyled.
  it('never returns auto', () => {
    expect(resolveTheme('auto')).not.toBe('auto')
  })

  it('keeps a concrete known id', () => {
    expect(resolveTheme('monokai')).toBe('monokai')
  })

  // A stale id from an older build must not leave the app with no theme.
  it('falls back for an unknown id', () => {
    expect(resolveTheme('some-removed-theme')).toBe(DARK_DEFAULT)
  })

  it('follows prefers-color-scheme for auto', () => {
    const original = window.matchMedia
    try {
      // @ts-expect-error — a minimal stub is all the resolver reads.
      window.matchMedia = () => ({ matches: true })
      expect(resolveTheme('auto')).toBe(DARK_DEFAULT)
      // @ts-expect-error — same stub, opposite answer.
      window.matchMedia = () => ({ matches: false })
      expect(resolveTheme('auto')).toBe(LIGHT_DEFAULT)
    } finally {
      window.matchMedia = original
    }
  })
})
