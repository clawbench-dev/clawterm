import { computed, ref } from 'vue'
import { applyModifiers } from '@/utils/keys'

/**
 * Ctrl/Alt state for the on-screen key bar.
 *
 * Three states, because two is not enough: Ctrl is mostly used for ONE
 * keystroke (^C, ^D, ^L), but some work (emacs, tmux) needs it to stay on.
 *
 *   inactive --tap--> once --tap--> inactive
 *   inactive --long press--> locked --tap--> inactive
 *
 * A plain toggle was the original design and it silently left Ctrl on after a
 * single ^C, so the next typed letters became control codes.
 *
 * Extracted from the panel so the transitions can be tested without mounting
 * xterm (which needs a real canvas and layout).
 */
export type ModState = 'inactive' | 'once' | 'locked'
export type Modifier = 'ctrl' | 'alt'

export const LONG_PRESS_MS = 420

export function useModifiers() {
  const state = ref<Record<Modifier, ModState>>({ ctrl: 'inactive', alt: 'inactive' })

  /** True while the modifier would be applied to the next keystroke. */
  const active = computed(() => state.value.ctrl !== 'inactive' || state.value.alt !== 'inactive')

  function tap(which: Modifier) {
    state.value[which] = state.value[which] === 'inactive' ? 'once' : 'inactive'
  }

  /** Long press: lock, or release if it was already locked. */
  function lock(which: Modifier) {
    state.value[which] = state.value[which] === 'locked' ? 'inactive' : 'locked'
  }

  /**
   * Transform one keystroke and spend any one-shot modifiers.
   *
   * Callers must use the RETURN VALUE: applying the modifiers twice would
   * double-prefix Alt with ESC.
   */
  function consume(data: string): string {
    const ctrl = state.value.ctrl !== 'inactive'
    const alt = state.value.alt !== 'inactive'
    const out = ctrl || alt ? applyModifiers(data, ctrl, alt) : data
    if (state.value.ctrl === 'once') state.value.ctrl = 'inactive'
    if (state.value.alt === 'once') state.value.alt = 'inactive'
    return out
  }

  function clear() {
    state.value = { ctrl: 'inactive', alt: 'inactive' }
  }

  return { state, active, tap, lock, consume, clear }
}
