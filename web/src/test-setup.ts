/**
 * Vitest setup: jsdom lacks a few browser APIs the app touches at module load.
 * Each stub here is a real gap, not a convenience — a missing one throws at
 * import time and takes the whole test file with it.
 */

import { vi } from 'vitest'

// matchMedia is read by the theme resolver and by the reduced-motion checks.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  })
}

// localStorage exists in jsdom but is shared across tests in one file; the
// settings module reads it at import time.
if (!globalThis.localStorage) {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size },
    },
  })
}

// ResizeObserver is used by the terminal panel and several sheets. jsdom has no
// implementation; a no-op class is enough because the tests assert on state,
// not on layout.
if (!('ResizeObserver' in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { writable: true, value: RO })
}

// IntersectionObserver is used by the popup menu's anchor-visibility check.
if (!('IntersectionObserver' in globalThis)) {
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', { writable: true, value: IO })
}

// visualViewport drives the keyboard watcher; jsdom omits it entirely, and the
// watcher must degrade to "no keyboard" rather than crash.
if (!('visualViewport' in window)) {
  Object.defineProperty(window, 'visualViewport', {
    writable: true,
    value: {
      height: (window as Window).innerHeight,
      offsetTop: 0,
      scale: 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })
}

// navigator.vibrate is called by the key bar; jsdom has no vibrator.
if (!navigator.vibrate) {
  Object.defineProperty(navigator, 'vibrate', { writable: true, value: () => true })
}
