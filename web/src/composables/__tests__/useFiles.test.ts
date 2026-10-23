import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatSize, formatTime, looksTextual } from '../useFiles'

describe('formatSize', () => {
  // 1024-based, matching what `ls -h` shows — a mixed convention makes the
  // number disagree with the shell the user is looking at.
  it('formats bytes, KB, MB and GB', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatSize(10 * 1024 * 1024)).toBe('10 MB')
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  // Below 10 units one decimal is useful; above it the decimal is noise that
  // makes the column jitter.
  it('drops the decimal at ten units and above', () => {
    expect(formatSize(9 * 1024)).toBe('9.0 KB')
    expect(formatSize(10 * 1024)).toBe('10 KB')
  })
})

describe('formatTime', () => {
  it('returns an empty string for a zero timestamp', () => {
    expect(formatTime(0)).toBe('')
  })

  it('shows month/day and time for the current year', () => {
    const now = new Date()
    const d = new Date(now.getFullYear(), 2, 5, 9, 7)
    expect(formatTime(d.getTime())).toBe('03/05 09:07')
  })

  // A file older than a year shows the year instead of a time: the time of day
  // is meaningless at that distance and the year is the useful fact.
  it('shows the year for older entries', () => {
    const d = new Date(2001, 0, 2, 3, 4)
    expect(formatTime(d.getTime())).toBe('2001/01/02')
  })
})

describe('looksTextual', () => {
  // A NUL byte is the single reliable binary signal available without a MIME
  // type, which SFTP does not provide.
  it('treats content with a NUL byte as binary', () => {
    expect(looksTextual('data.bin', 'abc\u0000def')).toBe(false)
  })

  it('accepts known text extensions', () => {
    for (const name of ['a.txt', 'b.md', 'c.go', 'd.json', 'e.sh', 'f.conf']) {
      expect(looksTextual(name, 'plain'), name).toBe(true)
    }
  })

  it('accepts extensionless names like Makefile and Dockerfile', () => {
    expect(looksTextual('Makefile', 'all:')).toBe(true)
    expect(looksTextual('LICENSE', 'MIT')).toBe(true)
  })

  // An unknown extension on clean text is still shown: an allowlist would make
  // .service / .repo / .timer files unopenable.
  it('accepts an unknown extension when the content is clean', () => {
    expect(looksTextual('x.weird', 'hello')).toBe(true)
    expect(looksTextual('app.service', '[Unit]')).toBe(true)
  })

  // A denylist, not an allowlist: known binaries are refused even though their
  // bytes may contain no NUL in the fetched prefix.
  it('rejects known binary extensions', () => {
    for (const name of ['a.png', 'b.zip', 'c.pdf', 'd.mp4', 'e.so', 'f.woff2']) {
      expect(looksTextual(name, 'not really text'), name).toBe(false)
    }
  })

  it('is case-insensitive about the extension', () => {
    expect(looksTextual('README.MD', '# title')).toBe(true)
  })
})
