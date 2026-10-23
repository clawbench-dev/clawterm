import { ref, type Ref } from 'vue'

/**
 * Termius-style touch gestures for the terminal area.
 *
 * Three modes, cycled from the toolbar:
 *
 *   browse    — one-finger vertical drag scrolls the output; taps/selection go
 *               to the browser. This is the default because it is the least
 *               surprising: the terminal behaves like any scrollable page.
 *   gesture   — swipes send arrow keys (with hold-to-repeat), two-finger
 *               vertical swipe sends PgUp/PgDn, double-tap sends Tab, pinch
 *               changes the font size.
 *   selection — the terminal becomes a text-selection surface: drag paints a
 *               cell range, and the caller shows a copy bar for it.
 *
 * Gestures are bound to the terminal container element only, never the whole
 * page: a swipe that starts on the key bar or a drawer must not move the
 * cursor.
 */

export type TerminalMode = 'browse' | 'gesture' | 'selection'

const MODE_ORDER: TerminalMode[] = ['browse', 'gesture', 'selection']

/** Convert an absolute touch Y coordinate to a viewport row (0..rows-1). */
export function clientYToViewportRow(
  clientY: number,
  containerTop: number,
  cellHeight: number,
  viewportRows: number,
): number {
  if (cellHeight <= 0 || viewportRows <= 0) return 0
  const row = Math.floor((clientY - containerTop) / cellHeight)
  return Math.max(0, Math.min(viewportRows - 1, row))
}

/** Convert an absolute touch X coordinate to a viewport column (0..cols-1). */
export function clientXToViewportCol(
  clientX: number,
  containerLeft: number,
  cellWidth: number,
  viewportCols: number,
): number {
  if (cellWidth <= 0 || viewportCols <= 0) return 0
  const col = Math.floor((clientX - containerLeft) / cellWidth)
  return Math.max(0, Math.min(viewportCols - 1, col))
}

/**
 * Turn an anchor/current viewport cell pair into the arguments for xterm's
 * `select(col, row, length)`.
 *
 * `select` is exclusive of the end cell, so the length adds 1. The result is
 * normalized earlier-first, because a drag can run backwards (bottom-right to
 * top-left) and xterm needs a forward range either way.
 */
export function selectionCellsToSelect(
  anchorCol: number,
  anchorRow: number,
  currentCol: number,
  currentRow: number,
  viewportY: number,
  cols: number,
): { col: number; row: number; length: number } {
  const aRow = viewportY + anchorRow
  const cRow = viewportY + currentRow
  const forward = cRow > aRow || (cRow === aRow && currentCol >= anchorCol)
  const sRow = forward ? aRow : cRow
  const sCol = forward ? anchorCol : currentCol
  const eRow = forward ? cRow : aRow
  const eCol = forward ? currentCol : anchorCol
  const length = (eRow - sRow) * cols - sCol + eCol + 1
  return { col: sCol, row: sRow, length }
}

export interface GestureCallbacks {
  sendArrowUp: () => void
  sendArrowDown: () => void
  sendArrowLeft: () => void
  sendArrowRight: () => void
  sendPageUp: () => void
  sendPageDown: () => void
  sendTab: () => void
  /** Pinch: delta in "steps" (positive = zoom in). */
  onPinchZoom?: (steps: number) => void
  /** Short-lived badge showing which gesture fired. */
  onGestureHint?: (symbol: string) => void
  /** Browse mode: vertical drag delta in px, to be applied as scrollback. */
  onTouchScroll?: (deltaY: number) => void
  getCellHeight?: () => number
  getCellWidth?: () => number
  onSelectionStart?: (col: number, row: number) => void
  onSelectionExtend?: (anchorCol: number, anchorRow: number, currentCol: number, currentRow: number) => void
  onSelectionEnd?: () => void
}

type Direction = 'up' | 'down' | 'left' | 'right'
type TwoFingerMode = 'pending' | 'pinch' | 'swipe'

const SWIPE_THRESHOLD = 30
const TWO_FINGER_SWIPE_THRESHOLD = 30
const PINCH_THRESHOLD = 10
const REPEAT_INITIAL_DELAY = 500
const REPEAT_INTERVAL = 150
const DOUBLE_TAP_MS = 300
const TAP_THRESHOLD = 10

const DIRECTION_SYMBOLS: Record<Direction, string> = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
}

export function useTerminalGestures(elementRef: Ref<HTMLElement | null>, callbacks: GestureCallbacks) {
  const mode = ref<TerminalMode>('browse')

  let commandAttached = false
  let scrollAttached = false
  let selectionAttached = false

  let touchStartX = 0
  let touchStartY = 0
  let isActive = false

  let scrollStartX = 0
  let scrollStartY = 0
  let scrollLastY = 0
  let scrollActive = false
  let scrollTracking = false

  let currentDirection: Direction | null = null
  let repeatTimer: ReturnType<typeof setTimeout> | null = null
  let repeatInterval: ReturnType<typeof setInterval> | null = null

  let initialPinchDistance = 0
  let lastPinchDistance = 0
  let accumulatedPinchDelta = 0
  let twoFingerStartCenterX = 0
  let twoFingerStartCenterY = 0
  let twoFingerStart1X = 0
  let twoFingerStart1Y = 0
  let twoFingerStart2X = 0
  let twoFingerStart2Y = 0
  let twoFingerMode: TwoFingerMode = 'pending'

  let lastTapTime = 0
  let lastTapX = 0
  let lastTapY = 0

  let selectionActive = false
  let selectionAnchorCol = -1
  let selectionAnchorRow = -1

  function distance(t1: Touch, t2: Touch): number {
    const dx = t1.clientX - t2.clientX
    const dy = t1.clientY - t2.clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  function center(t1: Touch, t2: Touch) {
    return { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 }
  }

  function sendArrow(dir: Direction) {
    switch (dir) {
      case 'up': callbacks.sendArrowUp(); break
      case 'down': callbacks.sendArrowDown(); break
      case 'left': callbacks.sendArrowLeft(); break
      case 'right': callbacks.sendArrowRight(); break
    }
    callbacks.onGestureHint?.(DIRECTION_SYMBOLS[dir])
  }

  function startRepeat(dir: Direction) {
    stopRepeat()
    repeatTimer = setTimeout(() => {
      repeatInterval = setInterval(() => sendArrow(dir), REPEAT_INTERVAL)
    }, REPEAT_INITIAL_DELAY)
  }

  function stopRepeat() {
    if (repeatTimer) {
      clearTimeout(repeatTimer)
      repeatTimer = null
    }
    if (repeatInterval) {
      clearInterval(repeatInterval)
      repeatInterval = null
    }
  }

  function resetGestureState() {
    stopRepeat()
    isActive = false
    currentDirection = null
    initialPinchDistance = 0
    lastPinchDistance = 0
    accumulatedPinchDelta = 0
    twoFingerMode = 'pending'
  }

  function resetScrollState() {
    scrollStartX = 0
    scrollStartY = 0
    scrollLastY = 0
    scrollActive = false
    scrollTracking = false
  }

  function detectDirection(dx: number, dy: number): Direction | null {
    const absDx = Math.abs(dx)
    const absDy = Math.abs(dy)
    if (absDx < SWIPE_THRESHOLD && absDy < SWIPE_THRESHOLD) return null
    if (absDx > absDy) return dx > 0 ? 'right' : 'left'
    return dy > 0 ? 'down' : 'up'
  }

  function preventNative(e: TouchEvent) {
    if (e.cancelable) e.preventDefault()
  }

  // ── gesture mode ───────────────────────────────────────────────────────────

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length === 2) {
      // A second finger cancels any one-finger gesture in flight: the user is
      // clearly not swiping an arrow key.
      preventNative(e)
      initialPinchDistance = distance(e.touches[0], e.touches[1])
      lastPinchDistance = initialPinchDistance
      accumulatedPinchDelta = 0
      const c = center(e.touches[0], e.touches[1])
      twoFingerStartCenterX = c.x
      twoFingerStartCenterY = c.y
      twoFingerStart1X = e.touches[0].clientX
      twoFingerStart1Y = e.touches[0].clientY
      twoFingerStart2X = e.touches[1].clientX
      twoFingerStart2Y = e.touches[1].clientY
      twoFingerMode = 'pending'
      isActive = false
      stopRepeat()
      currentDirection = null
      return
    }
    if (e.touches.length !== 1) return

    touchStartX = e.touches[0].clientX
    touchStartY = e.touches[0].clientY
    isActive = true
    currentDirection = null
  }

  function onTouchMove(e: TouchEvent) {
    if (e.touches.length === 2 && initialPinchDistance > 0) {
      preventNative(e)
      const c = center(e.touches[0], e.touches[1])
      const centerDx = c.x - twoFingerStartCenterX
      const centerDy = c.y - twoFingerStartCenterY
      const current = distance(e.touches[0], e.touches[1])
      const fromStart = current - initialPinchDistance
      const step = current - lastPinchDistance
      const t1Dx = e.touches[0].clientX - twoFingerStart1X
      const t1Dy = e.touches[0].clientY - twoFingerStart1Y
      const t2Dx = e.touches[1].clientX - twoFingerStart2X
      const t2Dy = e.touches[1].clientY - twoFingerStart2Y
      const sameVertical = Math.sign(t1Dy) === Math.sign(t2Dy)
      const bothMovedVertically = Math.abs(t1Dy) >= TWO_FINGER_SWIPE_THRESHOLD
        && Math.abs(t2Dy) >= TWO_FINGER_SWIPE_THRESHOLD
      const mostlyVertical = Math.abs(centerDy) > Math.abs(centerDx)
        && Math.abs(t1Dy) > Math.abs(t1Dx) && Math.abs(t2Dy) > Math.abs(t2Dx)

      // Decide ONCE per gesture whether this is a pinch or a page swipe: the
      // two conflict (both change the finger distance), and re-deciding on every
      // move makes a swipe that drifts in distance fire zoom mid-gesture.
      if (twoFingerMode === 'pending') {
        if (Math.abs(fromStart) >= PINCH_THRESHOLD) {
          twoFingerMode = 'pinch'
        } else if (Math.abs(centerDy) >= TWO_FINGER_SWIPE_THRESHOLD
          && sameVertical && bothMovedVertically && mostlyVertical) {
          twoFingerMode = 'swipe'
          if (centerDy < 0) {
            callbacks.sendPageUp()
            callbacks.onGestureHint?.('⇞')
          } else {
            callbacks.sendPageDown()
            callbacks.onGestureHint?.('⇟')
          }
          return
        }
      }

      if (twoFingerMode === 'pinch') {
        accumulatedPinchDelta += step
        lastPinchDistance = current
        if (Math.abs(accumulatedPinchDelta) >= PINCH_THRESHOLD) {
          const steps = Math.trunc(accumulatedPinchDelta / PINCH_THRESHOLD)
          callbacks.onPinchZoom?.(steps)
          accumulatedPinchDelta -= steps * PINCH_THRESHOLD
        }
      }
      return
    }

    if (!isActive || e.touches.length !== 1) return

    const touch = e.touches[0]
    const dx = touch.clientX - touchStartX
    const dy = touch.clientY - touchStartY
    const dir = detectDirection(dx, dy)

    // Suppress native selection only once the movement is clearly a gesture.
    // Before the threshold, a long press must still be able to start a native
    // text selection — that is the only way to copy on platforms where the
    // selection mode is not in use.
    if (dir || currentDirection) preventNative(e)

    if (dir && dir !== currentDirection) {
      currentDirection = dir
      sendArrow(dir)
      startRepeat(dir)
    }
  }

  function onTouchEnd(e: TouchEvent) {
    if (e.touches.length < 2) {
      initialPinchDistance = 0
      lastPinchDistance = 0
      twoFingerMode = 'pending'
    }
    stopRepeat()
    if (!isActive) return

    const wasDirection = currentDirection
    currentDirection = null
    isActive = false

    // Already handled by hold-to-repeat; do not also fire a swipe.
    if (wasDirection) {
      preventNative(e)
      return
    }

    const touch = e.changedTouches[0]
    const dx = touch.clientX - touchStartX
    const dy = touch.clientY - touchStartY
    const dir = detectDirection(dx, dy)
    if (dir) {
      preventNative(e)
      sendArrow(dir)
      return
    }
    if (Math.abs(dx) <= TAP_THRESHOLD && Math.abs(dy) <= TAP_THRESHOLD) {
      const now = Date.now()
      const isDoubleTap = now - lastTapTime < DOUBLE_TAP_MS
        && Math.abs(touch.clientX - lastTapX) < TAP_THRESHOLD * 2
        && Math.abs(touch.clientY - lastTapY) < TAP_THRESHOLD * 2
      if (isDoubleTap) {
        preventNative(e)
        callbacks.sendTab()
        callbacks.onGestureHint?.('⇥')
        // Reset so a third tap starts a new pair instead of firing again.
        lastTapTime = 0
      } else {
        lastTapTime = now
        lastTapX = touch.clientX
        lastTapY = touch.clientY
      }
    }
  }

  function onTouchCancel() {
    resetGestureState()
  }

  // ── browse mode (scroll) ───────────────────────────────────────────────────

  function onScrollStart(e: TouchEvent) {
    if (e.touches.length !== 1) {
      resetScrollState()
      return
    }
    scrollStartX = e.touches[0].clientX
    scrollStartY = e.touches[0].clientY
    scrollLastY = e.touches[0].clientY
    scrollActive = false
    scrollTracking = true
  }

  function onScrollMove(e: TouchEvent) {
    if (e.touches.length !== 1 || !callbacks.onTouchScroll) {
      resetScrollState()
      return
    }
    if (!scrollTracking) return

    const touch = e.touches[0]
    const dx = touch.clientX - scrollStartX
    const dy = touch.clientY - scrollStartY
    // Only a vertical-dominant drag scrolls; a horizontal one is left to the
    // page (nothing else consumes it here, but stealing it would block a future
    // horizontal gesture).
    if (!scrollActive) {
      if (Math.abs(dy) < TAP_THRESHOLD || Math.abs(dy) <= Math.abs(dx)) return
      scrollActive = true
    }
    preventNative(e)
    const delta = touch.clientY - scrollLastY
    if (delta !== 0) {
      callbacks.onTouchScroll(delta)
      scrollLastY = touch.clientY
    }
  }

  function onScrollEnd(e: TouchEvent) {
    if (scrollActive) preventNative(e)
    resetScrollState()
  }

  // ── selection mode ─────────────────────────────────────────────────────────

  function cellFor(clientX: number, clientY: number) {
    const el = elementRef.value
    if (!el) return { col: 0, row: 0 }
    const rect = el.getBoundingClientRect()
    const cellH = callbacks.getCellHeight?.() ?? 0
    const cellW = callbacks.getCellWidth?.() ?? 0
    const rows = cellH > 0 ? Math.max(1, Math.floor(rect.height / cellH)) : 1
    const cols = cellW > 0 ? Math.max(1, Math.floor(rect.width / cellW)) : 1
    return {
      col: clientXToViewportCol(clientX, rect.left, cellW, cols),
      row: clientYToViewportRow(clientY, rect.top, cellH, rows),
    }
  }

  function onSelStart(e: TouchEvent) {
    if (e.touches.length !== 1) return
    preventNative(e)
    const cell = cellFor(e.touches[0].clientX, e.touches[0].clientY)
    selectionAnchorCol = cell.col
    selectionAnchorRow = cell.row
    selectionActive = true
    callbacks.onSelectionStart?.(cell.col, cell.row)
  }

  function onSelMove(e: TouchEvent) {
    if (e.touches.length !== 1 || !selectionActive) return
    preventNative(e)
    const cell = cellFor(e.touches[0].clientX, e.touches[0].clientY)
    callbacks.onSelectionExtend?.(selectionAnchorCol, selectionAnchorRow, cell.col, cell.row)
  }

  function onSelEnd(e: TouchEvent) {
    const wasActive = selectionActive
    selectionActive = false
    selectionAnchorCol = -1
    selectionAnchorRow = -1
    if (wasActive) {
      preventNative(e)
      callbacks.onSelectionEnd?.()
    }
  }

  function onSelCancel() {
    selectionActive = false
    selectionAnchorCol = -1
    selectionAnchorRow = -1
  }

  // ── listener lifecycle ─────────────────────────────────────────────────────

  function attachCommand() {
    const el = elementRef.value
    if (commandAttached || !el) return
    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: false })
    el.addEventListener('touchcancel', onTouchCancel, { passive: false })
    commandAttached = true
  }

  function detachCommand() {
    const el = elementRef.value
    if (!commandAttached || !el) return
    stopRepeat()
    el.removeEventListener('touchstart', onTouchStart)
    el.removeEventListener('touchmove', onTouchMove)
    el.removeEventListener('touchend', onTouchEnd)
    el.removeEventListener('touchcancel', onTouchCancel)
    commandAttached = false
  }

  function attachScroll() {
    const el = elementRef.value
    if (scrollAttached || !el || !callbacks.onTouchScroll) return
    el.addEventListener('touchstart', onScrollStart, { passive: false })
    el.addEventListener('touchmove', onScrollMove, { passive: false })
    el.addEventListener('touchend', onScrollEnd, { passive: false })
    el.addEventListener('touchcancel', onScrollEnd, { passive: false })
    scrollAttached = true
  }

  function detachScroll() {
    const el = elementRef.value
    if (!scrollAttached || !el) return
    el.removeEventListener('touchstart', onScrollStart)
    el.removeEventListener('touchmove', onScrollMove)
    el.removeEventListener('touchend', onScrollEnd)
    el.removeEventListener('touchcancel', onScrollEnd)
    scrollAttached = false
    resetScrollState()
  }

  function attachSelection() {
    const el = elementRef.value
    if (selectionAttached || !el) return
    el.addEventListener('touchstart', onSelStart, { passive: false })
    el.addEventListener('touchmove', onSelMove, { passive: false })
    el.addEventListener('touchend', onSelEnd, { passive: false })
    el.addEventListener('touchcancel', onSelCancel, { passive: false })
    selectionAttached = true
  }

  function detachSelection() {
    const el = elementRef.value
    if (!selectionAttached || !el) return
    el.removeEventListener('touchstart', onSelStart)
    el.removeEventListener('touchmove', onSelMove)
    el.removeEventListener('touchend', onSelEnd)
    el.removeEventListener('touchcancel', onSelCancel)
    selectionAttached = false
  }

  /**
   * Apply the current mode's listeners and `touch-action`.
   *
   * `touch-action` is what actually stops the browser from stealing the
   * gesture: listeners alone are too late once the compositor has started a
   * scroll. `manipulation` keeps pinch-zoom available to the page but disables
   * double-tap zoom; `none` is required for a drag-to-select surface.
   */
  function applyState() {
    const el = elementRef.value
    detachCommand()
    detachScroll()
    detachSelection()

    if (mode.value === 'gesture') {
      attachCommand()
      if (el) el.style.touchAction = 'manipulation'
    } else if (mode.value === 'browse') {
      attachScroll()
      if (el) el.style.touchAction = 'auto'
    } else {
      attachSelection()
      if (el) el.style.touchAction = 'none'
    }
  }

  function setMode(next: TerminalMode) {
    if (next === mode.value) return
    mode.value = next
    resetGestureState()
    resetScrollState()
    lastTapTime = 0
    selectionActive = false
    selectionAnchorCol = -1
    selectionAnchorRow = -1
    applyState()
  }

  function cycleMode() {
    const idx = MODE_ORDER.indexOf(mode.value)
    setMode(MODE_ORDER[(idx + 1) % MODE_ORDER.length])
  }

  /** Rebind after the container element is replaced (tab switch). */
  function attach() {
    detachCommand()
    detachScroll()
    detachSelection()
    applyState()
  }

  function detach() {
    detachCommand()
    detachScroll()
    detachSelection()
    const el = elementRef.value
    if (el) el.style.touchAction = ''
  }

  return { mode, setMode, cycleMode, attach, detach }
}
