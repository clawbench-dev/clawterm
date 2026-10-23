import { ref, computed } from 'vue'

/**
 * Back-navigation registry.
 *
 * Both the Android hardware back button (dispatched as a DOM event by the
 * native shell) and the web edge-swipe gesture funnel into this one dispatcher.
 * Handlers are ranked by explicit priority, then by registration order — mount
 * order is not a reliable proxy for paint order, and getting that wrong once
 * meant the back gesture closed the wrong layer.
 */

export const BACK_PRESS_EVENT = 'clawterm-back-press'

export interface BackHandler {
  id: string
  canGoBack: () => boolean
  goBack: () => void
  priority: number
}

/** Overlays (dialogs, drawers, menus) must win over page-level navigation. */
export const PRIORITY_OVERLAY = 1000
/** Drill-down pages (a folder, a settings sub-page). */
export const PRIORITY_PAGE = 100

const handlers: BackHandler[] = []

/** @internal test helper */
export function _resetHandlers() {
  handlers.length = 0
}

export function registerBackHandler(h: BackHandler): () => void {
  handlers.push(h)
  return () => {
    const i = handlers.indexOf(h)
    if (i !== -1) handlers.splice(i, 1)
  }
}

/** Run the highest-priority handler that can go back. Returns true if one ran. */
export function handleBackNavigation(minPriority = 0): boolean {
  const sorted = handlers
    .filter((h) => h.priority >= minPriority)
    .map((h, idx) => ({ h, idx }))
    // Same priority → the most recently registered wins, which reproduces
    // "the thing that was opened last" for same-tier overlays.
    .sort((a, b) => b.h.priority - a.h.priority || b.idx - a.idx)
  for (const { h } of sorted) {
    if (h.canGoBack()) {
      h.goBack()
      return true
    }
  }
  return false
}

export function canNavigateBack(minPriority = 0): boolean {
  return handlers.some((h) => h.priority >= minPriority && h.canGoBack())
}

// ── Double-back-to-exit ──────────────────────────────────────────────────────

const EXIT_WINDOW_MS = 2000
let lastExitAt = 0

/**
 * True when this is the second back press inside the window. The first press
 * returns false so the caller can show a "press again to exit" hint — exiting
 * on a single stray press is the classic way to lose someone's place.
 */
export function requestExitConfirm(): boolean {
  const now = Date.now()
  if (now - lastExitAt < EXIT_WINDOW_MS) {
    lastExitAt = 0
    return true
  }
  lastExitAt = now
  return false
}

/** @internal test helper */
export function _resetExitConfirm() {
  lastExitAt = 0
}

// ── Bridge to the native shell ───────────────────────────────────────────────

declare global {
  interface Window {
    /** Set by the Android shell before dispatching the event. */
    __clawtermBackHandled?: boolean
    __clawtermExitRequested?: boolean
  }
}

/**
 * Install the document listener that answers the native back press.
 *
 * The handler must answer SYNCHRONOUSLY: the shell reads the flag immediately
 * after dispatching and finishes the activity when it is not set. An async
 * handler would therefore always "fail to handle" and close the app.
 */
export function installBackPressBridge() {
  const onPress = (e: Event) => {
    if (handleBackNavigation()) {
      window.__clawtermBackHandled = true
      e.preventDefault()
      return
    }
    window.__clawtermBackHandled = false
    if (requestExitConfirm()) {
      window.__clawtermExitRequested = true
    }
  }
  document.addEventListener(BACK_PRESS_EVENT, onPress)
  return () => document.removeEventListener(BACK_PRESS_EVENT, onPress)
}

// ── Edge swipe (web) ─────────────────────────────────────────────────────────

/**
 * Swipe-in-from-the-left-edge to go back, mirroring the platform gesture.
 *
 * Only the LEFT edge counts: the right edge is where drawers live, and a
 * two-sided trigger made opening a drawer occasionally navigate instead.
 * The gesture is committed on release past a threshold rather than on movement
 * so a scroll that starts near the edge does not navigate.
 */
export function installEdgeSwipeBack(el: HTMLElement = document.body) {
  let startX = 0
  let startY = 0
  let tracking = false
  const EDGE = 24
  const THRESHOLD = 60

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return
    const t = e.touches[0]
    tracking = t.clientX <= EDGE
    startX = t.clientX
    startY = t.clientY
  }
  const onEnd = (e: TouchEvent) => {
    if (!tracking) return
    tracking = false
    const t = e.changedTouches[0]
    const dx = t.clientX - startX
    const dy = Math.abs(t.clientY - startY)
    // Horizontal intent: a vertical drag from the edge is a scroll, not a back.
    if (dx > THRESHOLD && dy < 50) {
      if (!handleBackNavigation()) requestExitConfirm()
    }
  }
  el.addEventListener('touchstart', onStart, { passive: true })
  el.addEventListener('touchend', onEnd, { passive: true })
  return () => {
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchend', onEnd)
  }
}

// ── Drawer stacking ──────────────────────────────────────────────────────────

/**
 * Open-order stack for drawers.
 *
 * Every drawer teleports to <body> at the same z-index tier, so the browser
 * orders them by DOM position — which Teleport fixes at MOUNT time, not open
 * time. A drawer mounted early but opened later would paint underneath the one
 * that opened it. Each open drawer therefore claims the next slot and derives
 * its z-index from it.
 *
 * This must be module state: code at the top of `<script setup>` runs once per
 * INSTANCE, so a stack declared there would be per-drawer and every slot 0.
 */
let drawerSeq = 0
const drawerStack: number[] = []
export const MAX_DRAWER_OFFSET = 40

/** @internal test helper */
export function _resetDrawerStack() {
  drawerSeq = 0
  drawerStack.length = 0
}

export function nextDrawerId(): number {
  return ++drawerSeq
}

export function pushDrawer(seq: number) {
  if (!drawerStack.includes(seq)) drawerStack.push(seq)
}

export function removeDrawer(seq: number) {
  const i = drawerStack.indexOf(seq)
  if (i !== -1) drawerStack.splice(i, 1)
}

/** Reactive z-offset for a drawer instance. */
export function drawerZOffset(seq: number) {
  return computed(() => Math.min(Math.max(drawerStack.indexOf(seq), 0), MAX_DRAWER_OFFSET))
}

// ── UI state composables ─────────────────────────────────────────────────────

export type ToastType = 'success' | 'error' | 'info' | 'loading'

interface ToastState {
  visible: boolean
  message: string
  type: ToastType
}

const toastState = ref<ToastState>({ visible: false, message: '', type: 'info' })
let toastTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Show a transient message. A second call replaces the first rather than
 * queueing: two stacked toasts on a phone cover the header.
 */
export function showToast(message: string, type: ToastType = 'info', duration = 2600) {
  if (toastTimer) clearTimeout(toastTimer)
  toastState.value = { visible: true, message, type }
  toastTimer = setTimeout(() => {
    toastState.value = { ...toastState.value, visible: false }
    toastTimer = null
  }, duration)
}

export function dismissToast() {
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = null
  toastState.value = { ...toastState.value, visible: false }
}

export function useToast() {
  return { toast: toastState, showToast, dismissToast }
}

export interface ConfirmState {
  visible: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  danger: boolean
  resolve: ((ok: boolean) => void) | null
}

const confirmState = ref<ConfirmState>({
  visible: false,
  title: '',
  message: '',
  confirmLabel: '',
  cancelLabel: '',
  danger: false,
  resolve: null,
})

/**
 * Promise-based confirmation dialog.
 *
 * A promise rather than a callback so the call site reads as a straight line
 * and cannot forget to handle the cancel branch.
 */
export function confirmDialog(opts: {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.value = {
      visible: true,
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? '',
      cancelLabel: opts.cancelLabel ?? '',
      danger: opts.danger ?? false,
      resolve,
    }
  })
}

export function resolveConfirm(ok: boolean) {
  const fn = confirmState.value.resolve
  confirmState.value = { ...confirmState.value, visible: false, resolve: null }
  if (fn) fn(ok)
}

export function useConfirm() {
  return { confirm: confirmState, resolveConfirm }
}

// ── Keyboard / viewport ──────────────────────────────────────────────────────

/**
 * Height of the on-screen keyboard, in px.
 *
 * On Android WebView with `adjustResize` the layout viewport shrinks and the
 * value is 0 by construction. On mobile browsers only the VISUAL viewport
 * shrinks, so the difference has to be compensated in CSS or a fixed-bottom
 * dock ends up behind the keyboard.
 *
 * The threshold matters: a desktop scrollbar is 15px and a pinch-zoomed page
 * can report 160px of "difference", neither of which is a keyboard. Without it
 * the dock would collapse on a desktop with classic scrollbars.
 */
export const KEYBOARD_MIN_PX = 120

const keyboardHeight = ref(0)
const isAdjustResize = ref(false)

/** Baseline of the largest layout height seen (Android reports 0 early on). */
let maxLayoutHeight = 0

export function useSoftKeyboard() {
  return { keyboardHeight, isAdjustResize }
}

export function installKeyboardWatcher() {
  const vv = window.visualViewport
  const read = () => {
    const layoutH = window.innerHeight
    if (layoutH > maxLayoutHeight) maxLayoutHeight = layoutH
    if (!vv) {
      keyboardHeight.value = 0
      return
    }
    const shrink = maxLayoutHeight - (vv.height + vv.offsetTop)
    // A shrunken LAYOUT height means adjustResize is doing the work; the visual
    // gap is then an artefact of the same resize and must not be compensated
    // twice.
    const layoutShrunk = layoutH < maxLayoutHeight - KEYBOARD_MIN_PX
    isAdjustResize.value = layoutShrunk
    if (layoutShrunk) {
      keyboardHeight.value = 0
      return
    }
    keyboardHeight.value = shrink > KEYBOARD_MIN_PX ? shrink : 0
  }
  read()
  window.addEventListener('resize', read)
  if (vv) {
    vv.addEventListener('resize', read)
    vv.addEventListener('scroll', read)
  }
  return () => {
    window.removeEventListener('resize', read)
    if (vv) {
      vv.removeEventListener('resize', read)
      vv.removeEventListener('scroll', read)
    }
  }
}

// ── Terminal focus (drives the app shell) ────────────────────────────────────

/**
 * Whether the terminal currently owns the keyboard.
 *
 * The shell uses this to hide its own dock while the terminal is being typed
 * into: on a mobile browser the fixed layout keeps full height, so the dock
 * would sit behind the IME. It is NOT derived from the keyboard height — on
 * Android the WebView runs adjustResize, the layout shrinks, and the computed
 * height is 0 by construction, which would hide the dock never and the key bar
 * always.
 */
const terminalFocused = ref(false)

export function setTerminalFocus(v: boolean) {
  terminalFocused.value = v
}

export function useTerminalFocus() {
  return { terminalFocused }
}

// ── Media query helpers ──────────────────────────────────────────────────────

/** Wide-screen (two-column) threshold in CSS px. */
export const WIDE_SCREEN_MIN_WIDTH = 960

const viewportWidth = ref(typeof window === 'undefined' ? 0 : window.innerWidth)

export function useWideScreen() {
  const isWideScreen = computed(() => viewportWidth.value >= WIDE_SCREEN_MIN_WIDTH)
  return { isWideScreen, viewportWidth }
}

export function installViewportWatcher() {
  const read = () => {
    viewportWidth.value = window.innerWidth
  }
  read()
  window.addEventListener('resize', read)
  window.addEventListener('orientationchange', read)
  return () => {
    window.removeEventListener('resize', read)
    window.removeEventListener('orientationchange', read)
  }
}

// Keep a single watcher alive for the app's lifetime; the composable above is
// pure state, so installing here is what makes `isWideScreen` live.
let watchersInstalled = false
export function installUiWatchers() {
  if (watchersInstalled) return
  watchersInstalled = true
  installViewportWatcher()
  installKeyboardWatcher()
}

/** React to the app being foregrounded (Android WebView calls this). */
const foregroundHooks: (() => void)[] = []
export function onAppForeground(fn: () => void) {
  foregroundHooks.push(fn)
  return () => {
    const i = foregroundHooks.indexOf(fn)
    if (i !== -1) foregroundHooks.splice(i, 1)
  }
}
export function emitAppForeground() {
  for (const fn of foregroundHooks) fn()
}

// A page restored from the back/forward cache was frozen: sockets may have died
// silently while the page was not running, so treat it as a resume.
if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) emitAppForeground()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') emitAppForeground()
  })
  // The native shell calls this on resume; install unconditionally so the
  // hook exists even when the shell loads the page before it is ready.
  ;(window as unknown as Record<string, unknown>).__clawtermResume = emitAppForeground
}

