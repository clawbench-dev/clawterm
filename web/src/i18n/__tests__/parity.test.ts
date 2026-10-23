import { describe, expect, it } from 'vitest'
import zh from '../locales/zh'
import en from '../locales/en'

/**
 * Collect every dotted key in a message tree.
 */
function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') out.push(...flatten(v as Record<string, unknown>, key))
    else out.push(key)
  }
  return out
}

describe('i18n parity', () => {
  // A key present in one locale and missing from the other renders as the raw
  // key for those users — the app looks broken, and nothing else catches it.
  it('defines exactly the same keys in zh and en', () => {
    const zk = flatten(zh as unknown as Record<string, unknown>).sort()
    const ek = flatten(en as unknown as Record<string, unknown>).sort()
    expect(ek).toEqual(zk)
  })

  it('has no empty messages', () => {
    for (const [name, tree] of [['zh', zh], ['en', en]] as const) {
      const walk = (o: Record<string, unknown>, p = '') => {
        for (const [k, v] of Object.entries(o)) {
          const key = p ? `${p}.${k}` : k
          if (v && typeof v === 'object') walk(v as Record<string, unknown>, key)
          else expect(String(v).trim(), `${name}:${key} is empty`).not.toBe('')
        }
      }
      walk(tree as unknown as Record<string, unknown>)
    }
  })

  // vue-i18n uses `|` as its plural separator and throws at RENDER time (the
  // component disappears), so a literal pipe must be written as `{'|'}`.
  // This caught the key bar vanishing entirely.
  it('never contains a bare pipe in a message', () => {
    const check = (o: Record<string, unknown>, name: string, p = '') => {
      for (const [k, v] of Object.entries(o)) {
        const key = `${name}:${p ? `${p}.` : ''}${k}`
        if (v && typeof v === 'object') {
          check(v as Record<string, unknown>, name, `${p ? `${p}.` : ''}${k}`)
          continue
        }
        const s = String(v)
        if (!s.includes('|')) continue
        // The escaped form is `{'|'}`; anything else is a plural separator.
        expect(s.includes("{'|'}"), `${key} has an unescaped pipe: ${s}`).toBe(true)
      }
    }
    check(zh as unknown as Record<string, unknown>, 'zh')
    check(en as unknown as Record<string, unknown>, 'en')
  })

  // Every interpolation placeholder must exist in both languages, or the
  // message renders with a literal `{n}`.
  it('uses the same placeholders in both languages', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    const walk = (a: Record<string, unknown>, b: Record<string, unknown>, p = '') => {
      for (const [k, av] of Object.entries(a)) {
        const bv = b[k]
        const key = p ? `${p}.${k}` : k
        if (av && typeof av === 'object') {
          walk(av as Record<string, unknown>, bv as Record<string, unknown>, key)
          continue
        }
        expect(placeholders(String(bv)), `${key} placeholders differ`).toEqual(placeholders(String(av)))
      }
    }
    walk(zh as unknown as Record<string, unknown>, en as unknown as Record<string, unknown>)
  })
})
