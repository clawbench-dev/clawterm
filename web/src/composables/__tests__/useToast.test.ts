import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissToast, showToast, useToast } from '../useUi'

const { toast } = useToast()

beforeEach(() => {
  dismissToast()
  vi.useRealTimers()
})

describe('showToast', () => {
  it('shows a message with a type', () => {
    showToast('saved', 'success')
    expect(toast.value).toMatchObject({ visible: true, message: 'saved', type: 'success' })
  })

  it('auto-dismisses after the duration', () => {
    vi.useFakeTimers()
    showToast('x', 'info', 1000)
    vi.advanceTimersByTime(999)
    expect(toast.value.visible).toBe(true)
    vi.advanceTimersByTime(1)
    expect(toast.value.visible).toBe(false)
  })

  /**
   * `duration: 0` must mean "stay until replaced", not "expire immediately".
   *
   * Passing 0 to setTimeout fires on the next tick, so a loading toast would
   * vanish in a flash — and the download flow relies on it staying up until the
   * result toast overwrites it.
   */
  it('treats duration 0 as sticky', () => {
    vi.useFakeTimers()
    showToast('downloading', 'loading', 0)
    vi.advanceTimersByTime(60_000)
    expect(toast.value.visible).toBe(true)
    expect(toast.value.message).toBe('downloading')
  })

  it('replaces a sticky toast when the result arrives', () => {
    vi.useFakeTimers()
    showToast('downloading', 'loading', 0)
    showToast('saved', 'success', 2000)
    expect(toast.value).toMatchObject({ visible: true, message: 'saved', type: 'success' })
    // And the new one still auto-dismisses.
    vi.advanceTimersByTime(2000)
    expect(toast.value.visible).toBe(false)
  })

  // Two stacked toasts on a phone cover the header, so the second replaces the
  // first rather than queueing behind it.
  it('replaces rather than queues', () => {
    showToast('first')
    showToast('second')
    expect(toast.value.message).toBe('second')
  })

  // The old timer must not fire against the new toast: that would dismiss the
  // replacement early.
  it('clears the previous timer on replacement', () => {
    vi.useFakeTimers()
    showToast('first', 'info', 500)
    vi.advanceTimersByTime(400)
    showToast('second', 'info', 5000)
    vi.advanceTimersByTime(200)
    expect(toast.value.visible).toBe(true)
    expect(toast.value.message).toBe('second')
  })

  it('dismiss clears the toast', () => {
    showToast('x')
    dismissToast()
    expect(toast.value.visible).toBe(false)
  })

  // A sticky toast has no timer; dismissing it must not throw.
  it('dismiss works on a sticky toast', () => {
    showToast('sticky', 'loading', 0)
    expect(() => dismissToast()).not.toThrow()
    expect(toast.value.visible).toBe(false)
  })
})
