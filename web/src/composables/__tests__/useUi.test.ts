import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetExitConfirm,
  _resetHandlers,
  canNavigateBack,
  handleBackNavigation,
  PRIORITY_OVERLAY,
  PRIORITY_PAGE,
  registerBackHandler,
  requestExitConfirm,
} from '../useUi'

beforeEach(() => {
  _resetHandlers()
  _resetExitConfirm()
})

describe('back navigation', () => {
  it('runs the highest-priority handler first', () => {
    const order: string[] = []
    registerBackHandler({ id: 'page', canGoBack: () => true, goBack: () => order.push('page'), priority: PRIORITY_PAGE })
    registerBackHandler({ id: 'overlay', canGoBack: () => true, goBack: () => order.push('overlay'), priority: PRIORITY_OVERLAY })

    expect(handleBackNavigation()).toBe(true)
    expect(order).toEqual(['overlay'])
  })

  // Same priority means "two overlays are open"; the one opened LAST is the one
  // on top, so it must consume the press. Getting this backwards closes a
  // drawer that the user is not looking at.
  it('prefers the most recently registered handler at equal priority', () => {
    const order: string[] = []
    registerBackHandler({ id: 'a', canGoBack: () => true, goBack: () => order.push('a'), priority: PRIORITY_OVERLAY })
    registerBackHandler({ id: 'b', canGoBack: () => true, goBack: () => order.push('b'), priority: PRIORITY_OVERLAY })

    handleBackNavigation()
    expect(order).toEqual(['b'])
  })

  it('skips handlers that cannot go back', () => {
    const order: string[] = []
    registerBackHandler({ id: 'top', canGoBack: () => false, goBack: () => order.push('top'), priority: PRIORITY_OVERLAY })
    registerBackHandler({ id: 'lower', canGoBack: () => true, goBack: () => order.push('lower'), priority: PRIORITY_PAGE })

    expect(handleBackNavigation()).toBe(true)
    expect(order).toEqual(['lower'])
  })

  it('reports nothing handled when every handler declines', () => {
    registerBackHandler({ id: 'x', canGoBack: () => false, goBack: () => {}, priority: PRIORITY_PAGE })
    expect(handleBackNavigation()).toBe(false)
    expect(canNavigateBack()).toBe(false)
  })

  it('honours the minimum priority filter', () => {
    registerBackHandler({ id: 'page', canGoBack: () => true, goBack: () => {}, priority: PRIORITY_PAGE })
    expect(handleBackNavigation(PRIORITY_OVERLAY)).toBe(false)
    expect(canNavigateBack(PRIORITY_OVERLAY)).toBe(false)
  })

  it('stops calling a handler once it unregisters', () => {
    let called = 0
    const off = registerBackHandler({
      id: 'x', canGoBack: () => true, goBack: () => { called++ }, priority: PRIORITY_PAGE,
    })
    handleBackNavigation()
    off()
    expect(handleBackNavigation()).toBe(false)
    expect(called).toBe(1)
  })
})

describe('double-back-to-exit', () => {
  it('does not confirm on the first press', () => {
    expect(requestExitConfirm()).toBe(false)
  })

  it('confirms on a second press inside the window', () => {
    requestExitConfirm()
    expect(requestExitConfirm()).toBe(true)
  })

  // After a confirmed exit the state must reset, or the NEXT single press would
  // immediately exit again.
  it('resets after a confirmed exit', () => {
    requestExitConfirm()
    expect(requestExitConfirm()).toBe(true)
    expect(requestExitConfirm()).toBe(false)
  })

  it('does not confirm after the window expires', () => {
    vi.useFakeTimers()
    try {
      requestExitConfirm()
      vi.advanceTimersByTime(2100)
      expect(requestExitConfirm()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
