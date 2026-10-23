import { describe, expect, it } from 'vitest'
import { applyModifiers, KEY_SEQUENCES, terminalWsUrl } from '../terminalProtocol'

describe('terminalWsUrl', () => {
  it('builds a new-session url with the host', () => {
    const url = terminalWsUrl({ hostId: 7, cols: 100, rows: 30, title: 'prod' })
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/api/terminal/ws')
    expect(parsed.searchParams.get('hostId')).toBe('7')
    expect(parsed.searchParams.get('cols')).toBe('100')
    expect(parsed.searchParams.get('rows')).toBe('30')
    expect(parsed.searchParams.get('title')).toBe('prod')
    expect(parsed.searchParams.has('session')).toBe(false)
  })

  // Re-attach must send the session id and NOT a host id: sending both would
  // make the server open a brand-new PTY instead of returning the old one.
  it('builds a re-attach url with only the session id', () => {
    const url = terminalWsUrl({ sessionId: 'abc123', cols: 80, rows: 24 })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('session')).toBe('abc123')
    expect(parsed.searchParams.has('hostId')).toBe(false)
  })

  it('uses ws on http and wss on https', () => {
    expect(terminalWsUrl({ hostId: 1, cols: 80, rows: 24 }).startsWith('ws://')).toBe(true)
  })

  it('encodes a title with spaces', () => {
    const url = terminalWsUrl({ hostId: 1, cols: 80, rows: 24, title: 'my server' })
    expect(url).toContain('title=my+server')
  })
})

describe('KEY_SEQUENCES', () => {
  // The application-cursor form (`ESC O x`) is what zsh/vim negotiate; sending
  // the CSI form (`ESC [ x`) silently does nothing in their normal mode.
  it('uses application-cursor sequences for arrows', () => {
    expect(KEY_SEQUENCES.up).toBe('\x1bOA')
    expect(KEY_SEQUENCES.down).toBe('\x1bOB')
    expect(KEY_SEQUENCES.right).toBe('\x1bOC')
    expect(KEY_SEQUENCES.left).toBe('\x1bOD')
  })

  it('uses the standard control codes for ctrl keys', () => {
    expect(KEY_SEQUENCES.ctrlC).toBe('\x03')
    expect(KEY_SEQUENCES.ctrlD).toBe('\x04')
    expect(KEY_SEQUENCES.ctrlL).toBe('\x0c')
  })

  it('uses DEL (not BS) for backspace, which readline expects', () => {
    expect(KEY_SEQUENCES.backspace).toBe('\x7f')
  })
})

describe('applyModifiers', () => {
  it('passes text through when no modifier is held', () => {
    expect(applyModifiers('a', false, false)).toBe('a')
  })

  it('maps ctrl+letter to the ASCII control code', () => {
    expect(applyModifiers('c', true, false)).toBe('\x03')
    expect(applyModifiers('C', true, false)).toBe('\x03')
    expect(applyModifiers('d', true, false)).toBe('\x04')
    expect(applyModifiers('a', true, false)).toBe('\x01')
  })

  it('prefixes alt with ESC', () => {
    expect(applyModifiers('b', false, true)).toBe('\x1bb')
  })

  it('combines ctrl and alt', () => {
    expect(applyModifiers('c', true, true)).toBe('\x1b\x03')
  })

  // Ctrl on a character with no control code must not silently produce
  // garbage: leaving it unchanged is what a terminal emulator does.
  it('leaves non-letters unchanged under ctrl', () => {
    expect(applyModifiers('1', true, false)).toBe('1')
    expect(applyModifiers('中', true, false)).toBe('中')
  })
})
