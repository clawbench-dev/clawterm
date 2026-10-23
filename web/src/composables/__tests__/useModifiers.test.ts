import { describe, expect, it } from 'vitest'
import { useModifiers } from '../useModifiers'

describe('useModifiers', () => {
  it('starts inactive', () => {
    const m = useModifiers()
    expect(m.state.value).toEqual({ ctrl: 'inactive', alt: 'inactive' })
    expect(m.active.value).toBe(false)
  })

  it('tap arms a one-shot modifier', () => {
    const m = useModifiers()
    m.tap('ctrl')
    expect(m.state.value.ctrl).toBe('once')
    expect(m.active.value).toBe(true)
  })

  // Tapping again must DISARM, not escalate: a user who taps Ctrl by mistake
  // needs one tap to get out.
  it('tapping again disarms', () => {
    const m = useModifiers()
    m.tap('ctrl')
    m.tap('ctrl')
    expect(m.state.value.ctrl).toBe('inactive')
  })

  it('long press locks', () => {
    const m = useModifiers()
    m.lock('ctrl')
    expect(m.state.value.ctrl).toBe('locked')
  })

  it('long press on a locked modifier releases it', () => {
    const m = useModifiers()
    m.lock('ctrl')
    m.lock('ctrl')
    expect(m.state.value.ctrl).toBe('inactive')
  })

  // This is the bug the three-state machine exists to prevent: after ^C the
  // modifier must be spent, or every following letter becomes a control code.
  it('spends a one-shot modifier after one keystroke', () => {
    const m = useModifiers()
    m.tap('ctrl')
    expect(m.consume('c')).toBe('\x03')
    expect(m.state.value.ctrl).toBe('inactive')
    // The next keystroke is plain text.
    expect(m.consume('a')).toBe('a')
  })

  it('keeps a locked modifier applied across keystrokes', () => {
    const m = useModifiers()
    m.lock('ctrl')
    expect(m.consume('c')).toBe('\x03')
    expect(m.consume('d')).toBe('\x04')
    expect(m.state.value.ctrl).toBe('locked')
  })

  it('combines ctrl and alt', () => {
    const m = useModifiers()
    m.lock('ctrl')
    m.lock('alt')
    expect(m.consume('c')).toBe('\x1b\x03')
  })

  // Ctrl is locked (still on) while Alt is one-shot, so the first keystroke
  // carries BOTH: Ctrl+b (\x02) with an ESC prefix. Alt is then spent while Ctrl
  // survives, which is the asymmetry this test pins.
  it('spends a one-shot alt but keeps a locked ctrl', () => {
    const m = useModifiers()
    m.lock('ctrl')
    m.tap('alt')
    expect(m.consume('b')).toBe('\x1b\x02')
    expect(m.state.value.alt).toBe('inactive')
    expect(m.state.value.ctrl).toBe('locked')
    // Ctrl survives, so the next key is still a control code.
    expect(m.consume('c')).toBe('\x03')
  })

  it('passes text through untouched when nothing is armed', () => {
    const m = useModifiers()
    expect(m.consume('hello')).toBe('hello')
  })

  it('clear resets both modifiers', () => {
    const m = useModifiers()
    m.lock('ctrl')
    m.tap('alt')
    m.clear()
    expect(m.state.value).toEqual({ ctrl: 'inactive', alt: 'inactive' })
  })

  // The state object is reactive: a component reading it must see the change,
  // which is what makes the key bar highlight follow the tap.
  it('mutates the same reactive object so readers see the change', () => {
    const m = useModifiers()
    const before = m.state.value
    m.tap('ctrl')
    expect(m.state.value).toBe(before)
    expect(m.state.value.ctrl).toBe('once')
  })
})
