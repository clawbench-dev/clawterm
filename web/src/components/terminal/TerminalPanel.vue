<template>
  <div class="terminal-panel" :class="{ 'keyboard-up': keyboardHeight > 0 }">
    <!-- Tab bar -->
    <div class="term-tab-bar">
      <div ref="tabListRef" class="term-tab-list">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="term-tab"
          :class="{ active: tab.id === activeTabId }"
          :data-session-id="tab.sessionId"
          @click="selectTab(tab.id)"
          @dblclick="startRename(tab.id)"
        >
          <span class="term-tab-dot" :class="stateClass(tab)" />
          <span class="term-tab-title" :title="tab.title">{{ tab.title }}</span>
          <span v-if="tab.hasUnread && tab.id !== activeTabId" class="term-tab-unread" />
          <span class="term-tab-close" :title="t('terminal.closeTab')" @click.stop="requestClose(tab.id)">
            <XIcon :size="11" />
          </span>
        </button>
      </div>
      <button
        class="term-tab-add"
        :disabled="tabs.length >= MAX_TABS"
        :title="tabs.length >= MAX_TABS ? t('terminal.tabLimit', { n: MAX_TABS }) : t('terminal.newTab')"
        data-action="new-tab"
        @click="openNewTab"
      >
        <PlusIcon :size="15" />
      </button>
      <button
        class="term-tab-add"
        :title="t('terminal.quickCommands')"
        data-action="quick-commands"
        @click="snippetsOpen = true"
      >
        <ZapIcon :size="15" />
      </button>
      <button
        class="term-tab-add"
        :class="{ active: searchOpen }"
        :title="t('terminal.search')"
        data-action="terminal-search"
        @click="toggleSearch"
      >
        <SearchIcon :size="15" />
      </button>
    </div>

    <!-- In-terminal search. xterm keeps the matches, so this only has to drive
         the addon and keep the input focused. -->
    <div v-if="searchOpen" class="term-search">
      <SearchIcon :size="13" class="term-search-icon" />
      <input
        ref="searchInputRef"
        v-model="searchTerm"
        class="term-search-input"
        type="search"
        :placeholder="t('terminal.searchPlaceholder')"
        data-field="terminal-search"
        @input="runSearch"
        @keydown.enter.prevent="searchStep(($event.shiftKey) ? -1 : 1)"
        @keydown.esc.prevent="closeSearch"
      />
      <span class="term-search-count">{{ searchResult }}</span>
      <button class="term-search-btn" :title="t('terminal.searchPrev')" @click="searchStep(-1)">
        <ChevronUpIcon :size="14" />
      </button>
      <button class="term-search-btn" :title="t('terminal.searchNext')" @click="searchStep(1)">
        <ChevronDownIcon :size="14" />
      </button>
      <button class="term-search-btn" :title="t('terminal.searchClose')" @click="closeSearch">
        <XIcon :size="14" />
      </button>
    </div>

    <!-- Empty state -->
    <div v-if="tabs.length === 0" class="empty-state">
      <SquareTerminalIcon :size="40" class="empty-icon" />
      <p class="empty-title">{{ t('terminal.noSessions') }}</p>
      <p class="empty-hint">{{ t('terminal.noSessionsHint') }}</p>
      <button class="empty-action" @click="openNewTab">
        <PlusIcon :size="16" />
        <span>{{ t('terminal.newTab') }}</span>
      </button>
    </div>

    <!-- One host element per tab, kept alive and moved between slots. xterm
         instances live in the tab store, so switching tabs never destroys the
         buffer or the running TUI. -->
    <div v-else class="term-body">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        :ref="(el) => setTabHost(tab.id, el as HTMLElement | null)"
        class="term-host"
        :class="{ active: tab.id === activeTabId }"
      />

      <!-- Status overlays sit above the active terminal only. -->
      <div v-if="activeTab && activeTab.state !== 'connected'" class="term-status">
        <div v-if="activeTab.state === 'connecting'" class="status-card">
          <LoadingIndicator size="sm" inline />
          <span>{{ t('terminal.connecting', { host: activeTab.title }) }}</span>
        </div>
        <div v-else-if="activeTab.state === 'reconnecting'" class="status-card">
          <LoadingIndicator size="sm" inline />
          <span>{{ t('terminal.reconnecting') }}</span>
        </div>
        <div v-else-if="activeTab.state === 'exited'" class="status-card">
          <span class="status-text">{{ t('terminal.exited', { code: activeTab.exitCode }) }}</span>
          <button class="fbtn fbtn-primary" @click="restartTab(activeTab.id)">{{ t('terminal.restart') }}</button>
        </div>
        <div v-else-if="activeTab.state === 'error'" class="status-card error">
          <span class="status-text">{{ errorText(activeTab) }}</span>
          <div class="status-actions">
            <button class="fbtn" @click="copyError(activeTab.error)">{{ t('common.copy') }}</button>
            <button class="fbtn fbtn-primary" @click="restartTab(activeTab.id)">{{ t('terminal.reconnect') }}</button>
          </div>
        </div>
      </div>

      <!-- Key bar: Esc/Tab/Ctrl/Alt plus arrows.
           Visibility is driven by FOCUS, not by a measured keyboard height: on
           Android the WebView runs adjustResize, the layout viewport shrinks and
           the computed keyboard height is 0 by design — a height check would
           hide the bar on exactly the platform that needs it most. -->
      <div v-if="showKeyBar && termFocused" class="key-bar">
        <button class="key" tabindex="-1" @pointerdown.prevent @click="sendKey('esc')">{{ t('terminal.keys.esc') }}</button>
        <button class="key" tabindex="-1" @pointerdown.prevent @click="sendKey('tab')">{{ t('terminal.keys.tab') }}</button>
        <!-- Tap = one-shot (applies to the next key only), long-press = locked.
             A plain toggle is wrong for the common case: Ctrl is used for one
             keystroke at a time (^C, ^D), and a sticky modifier that silently
             stays on makes the following keystrokes control codes. -->
        <button
          class="key"
          tabindex="-1"
          :class="ctrlStateClass"
          @pointerdown.prevent
          @click="tapModifier('ctrl')"
          @contextmenu.prevent
          @touchstart.passive="startLongPress('ctrl')"
          @touchend.passive="cancelLongPress"
          @touchcancel.passive="cancelLongPress"
        >{{ t('terminal.keys.ctrl') }}</button>
        <button
          class="key"
          tabindex="-1"
          :class="altStateClass"
          @pointerdown.prevent
          @click="tapModifier('alt')"
          @contextmenu.prevent
          @touchstart.passive="startLongPress('alt')"
          @touchend.passive="cancelLongPress"
          @touchcancel.passive="cancelLongPress"
        >{{ t('terminal.keys.alt') }}</button>
        <button class="key" tabindex="-1" @pointerdown.prevent @click="sendKey('up')">{{ t('terminal.keys.up') }}</button>
        <button class="key" tabindex="-1" @pointerdown.prevent @click="sendKey('down')">{{ t('terminal.keys.down') }}</button>
        <button class="key" tabindex="-1" @pointerdown.prevent @click="sendKey('left')">{{ t('terminal.keys.left') }}</button>
        <button class="key" tabindex="-1" @pointerdown.prevent @click="sendKey('right')">{{ t('terminal.keys.right') }}</button>
        <button class="key" tabindex="-1" @pointerdown.prevent @click="sendKey('home')">{{ t('terminal.keys.home') }}</button>
        <button class="key" tabindex="-1" @pointerdown.prevent @click="sendKey('end')">{{ t('terminal.keys.end') }}</button>
        <button class="key" tabindex="-1" @pointerdown.prevent @click="sendKey('pgup')">{{ t('terminal.keys.pgup') }}</button>
        <button class="key" tabindex="-1" @pointerdown.prevent @click="sendKey('pgdn')">{{ t('terminal.keys.pgdn') }}</button>
        <button class="key" tabindex="-1" @pointerdown.prevent @click="sendChar('|')">{{ t('terminal.keys.pipe') }}</button>
        <button class="key" tabindex="-1" @pointerdown.prevent @click="sendChar('-')">{{ t('terminal.keys.dash') }}</button>
        <button class="key" tabindex="-1" @pointerdown.prevent @click="sendChar('/')">{{ t('terminal.keys.slash') }}</button>
        <button class="key" tabindex="-1" @pointerdown.prevent @click="sendChar('~')">{{ t('terminal.keys.tilde') }}</button>
      </div>

      <SnippetSheet :open="snippetsOpen" :host-id="activeTab?.hostId ?? 0" @close="snippetsOpen = false" @send="sendSnippet" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  X as XIcon, Plus as PlusIcon, Zap as ZapIcon, SquareTerminal as SquareTerminalIcon,
  Search as SearchIcon, ChevronUp as ChevronUpIcon, ChevronDown as ChevronDownIcon,
} from 'lucide-vue-next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import LoadingIndicator from '@/components/common/LoadingIndicator.vue'
import SnippetSheet from '@/components/snippets/SnippetSheet.vue'
import {
  MAX_TABS, activeTab as activeTabRef, activeTabId, tabs,
  attachTerminal, closeTab, detachTerminal, openTab, renameTab, resizeTab, selectTab, sendInput,
} from '@/composables/useTerminalTabs'
import { hosts } from '@/composables/useHosts'
import { settings, effectiveTheme } from '@/composables/useSettings'
import { KEY_SEQUENCES } from '@/utils/terminalProtocol'
import { LONG_PRESS_MS, useModifiers } from '@/composables/useModifiers'
import { buildXtermTheme, mixHex, terminalFontStack } from '@/utils/terminalTheme'
import { confirmDialog, setTerminalFocus, showToast, useSoftKeyboard } from '@/composables/useUi'

const { t } = useI18n()
const { keyboardHeight } = useSoftKeyboard()

const activeTab = activeTabRef
const tabListRef = ref<HTMLElement | null>(null)
const snippetsOpen = ref(false)

// Ctrl/Alt live in a composable so the state machine (tap = one-shot, long
// press = locked) can be tested without mounting xterm.
const modifiers = useModifiers()

const ctrlStateClass = computed(() => ({
  locked: modifiers.state.value.ctrl === 'locked',
  once: modifiers.state.value.ctrl === 'once',
}))
const altStateClass = computed(() => ({
  locked: modifiers.state.value.alt === 'locked',
  once: modifiers.state.value.alt === 'once',
}))

let longPressTimer: ReturnType<typeof setTimeout> | null = null
/** Set by the long-press timer so the synthetic click that follows does not
 *  immediately downgrade the lock back to a one-shot. */
let longPressFired = false

function startLongPress(which: 'ctrl' | 'alt') {
  longPressFired = false
  cancelLongPressTimer()
  longPressTimer = setTimeout(() => {
    longPressFired = true
    modifiers.lock(which)
    if (settings.haptic) navigator.vibrate?.(14)
  }, LONG_PRESS_MS)
}

function cancelLongPressTimer() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function cancelLongPress() {
  cancelLongPressTimer()
}

function tapModifier(which: 'ctrl' | 'alt') {
  if (longPressFired) {
    longPressFired = false
    return
  }
  cancelLongPressTimer()
  modifiers.tap(which)
  if (settings.haptic) navigator.vibrate?.(8)
}

/** True while the terminal's hidden textarea has focus (= keyboard is up). */
const termFocused = ref(false)

const showKeyBar = computed(() => settings.showKeyBar)

// One xterm per tab. Kept in a plain Map (not reactive): Vue must not walk a
// terminal's object graph.
const terms = new Map<string, { term: Terminal; fit: FitAddon; search: SearchAddon; dispose: () => void }>()

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Match decoration colours.
 *
 * The addon paints BACKGROUNDS only (it has no foreground option), so the text
 * colour is whatever the program emitted. A solid accent background therefore
 * makes a match unreadable — the first version did exactly that, and the match
 * vanished behind an orange block on a dark terminal.
 *
 * The fix is to keep every highlight low-saturation by mixing the accent toward
 * the terminal background: light text stays legible on a muted tint in dark
 * themes, dark text on a pale one in light themes, and the active match is still
 * distinguishable because it is mixed less far.
 *
 * Colours must be plain `#RRGGBB` — the addon rejects alpha.
 */
function searchOptions(): Parameters<SearchAddon['findNext']>[1] {
  const theme = buildXtermTheme(effectiveTheme())
  const accent = theme.cursor || '#fe8019'
  return {
    caseSensitive: false,
    decorations: {
      matchBackground: mixHex(accent, 'black', 0.55),
      matchOverviewRuler: accent,
      activeMatchBackground: mixHex(accent, 'black', 0.2),
      activeMatchColorOverviewRuler: accent,
    },
  }
}
const searchOpen = ref(false)
const searchTerm = ref('')
const searchResult = ref('')
const searchInputRef = ref<HTMLInputElement | null>(null)

function toggleSearch() {
  if (searchOpen.value) closeSearch()
  else {
    searchOpen.value = true
    nextTick(() => searchInputRef.value?.focus())
  }
}

function closeSearch() {
  searchOpen.value = false
  searchResult.value = ''
  // Clear the highlight, otherwise the last match stays highlighted forever.
  const rec = terms.get(activeTabId.value)
  rec?.search.clearDecorations()
  rec?.term.focus()
}

/**
 * Run the search and report the match position.
 *
 * `onDidChangeResults` is the only way to know "3 of 12": the addon returns a
 * boolean from findNext, which cannot distinguish a first match from a wrap.
 */
function runSearch() {
  const rec = terms.get(activeTabId.value)
  if (!rec) return
  if (!searchTerm.value) {
    searchResult.value = ''
    rec.search.clearDecorations()
    return
  }
  rec.search.findNext(searchTerm.value, { ...searchOptions(), incremental: true })
}

function searchStep(direction: 1 | -1) {
  const rec = terms.get(activeTabId.value)
  if (!rec || !searchTerm.value) return
  const opts = { ...searchOptions(), incremental: false }
  if (direction === 1) rec.search.findNext(searchTerm.value, opts)
  else rec.search.findPrevious(searchTerm.value, opts)
}

/** Double-click a tab to rename it; Enter commits, Escape abandons. */
function startRename(tabId: string) {
  const tab = tabs.value.find((x) => x.id === tabId)
  if (!tab) return
  const next = window.prompt(t('terminal.renameTab'), tab.title)
  if (next === null) return
  const trimmed = next.trim()
  if (trimmed) renameTab(tabId, trimmed)
}

// Host elements registered by the template. Attaching happens when both the
// element and the terminal exist, in either order.
const hostEls = new Map<string, HTMLElement>()

function stateClass(tab: { state: string }) {
  return `is-${tab.state}`
}

function errorText(tab: { errorCode: string; error: string }): string {
  switch (tab.errorCode) {
    case 'auth_failed': return t('terminal.authFailed')
    case 'connection_refused': return `${t('terminal.connectFailed')}: ${t('terminal.refused')}`
    case 'timeout': return `${t('terminal.connectFailed')}: ${t('terminal.timeout')}`
    case 'host_not_found': return `${t('terminal.connectFailed')}: ${t('terminal.hostNotFound')}`
    case 'connect_failed': return `${t('terminal.connectFailed')}: ${tab.error}`
    case 'shell_failed': return `${t('terminal.connectFailed')}: ${tab.error}`
    case 'host_key_changed': return t('terminal.hostKeyChanged')
    case 'session_gone': return t('terminal.sessionGone')
    case 'session_busy': return tab.error
    default: return tab.error || t('terminal.connectFailed')
  }
}

/**
 * Create the xterm instance for a tab.
 *
 * `convertEol` stays off: the remote PTY sends its own CRLF and rewriting them
 * breaks full-screen programs. `scrollback` is generous because a phone user
 * scrolls far back looking for output that already scrolled past.
 */
function ensureTerm(tabId: string): { term: Terminal; fit: FitAddon; search: SearchAddon; dispose: () => void } | null {
  const existing = terms.get(tabId)
  if (existing) return existing

  const term = new Terminal({
    fontSize: settings.terminalFontSize,
    fontFamily: terminalFontStack(settings.terminalFont),
    theme: buildXtermTheme(effectiveTheme()),
    cursorBlink: settings.cursorBlink,
    scrollback: 5000,
    allowProposedApi: true,
    // The mobile keyboard is a real input method; xterm's own hidden textarea
    // receives its composition events correctly, so no custom input handling.
    macOptionIsMeta: true,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const search = new SearchAddon()
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon((_e, uri) => {
    window.open(uri, '_blank', 'noopener,noreferrer')
  }))
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    searchResult.value = resultCount === 0
      ? t('terminal.noMatches')
      : `${resultIndex + 1}/${resultCount}`
  })

  term.onData((data) => {
    // consume() applies the modifiers and spends any one-shot ones.
    sendInput(tabId, modifiers.consume(data))
  })

  term.onResize(({ cols, rows }) => resizeTab(tabId, cols, rows))

  term.onSelectionChange(() => {
    if (!settings.copyOnSelect) return
    const sel = term.getSelection()
    if (sel) void navigator.clipboard?.writeText(sel).catch(() => { /* not permitted */ })
  })

  // Paste is a context action on mobile (no Ctrl+V); handled by the tab menu and
  // the hardware keyboard shortcut that xterm already maps.

  const dispose = () => {
    term.dispose()
  }

  const rec = { term, fit, search, dispose }
  terms.set(tabId, rec)
  return rec
}

/**
 * Bind a tab's terminal to its DOM host.
 *
 * xterm renders into its own child element, which can only have one parent:
 * moving tabs therefore means re-opening the terminal into the new host
 * element, not moving nodes. `open()` is idempotent enough for this — it
 * re-parents the existing renderer.
 */
function setTabHost(tabId: string, el: HTMLElement | null) {
  if (!el) return
  hostEls.set(tabId, el)
  const rec = ensureTerm(tabId)
  if (!rec) return
  // Each tab keeps its OWN host element for its whole life (the v-for is keyed
  // by tab id), so the terminal is opened exactly once and never re-parented —
  // re-opening would rebuild the renderer and lose the canvas state.
  if (!rec.term.element) {
    rec.term.open(el)
    // Wire focus AFTER open: xterm creates its hidden textarea inside open(),
    // so the same listeners attached at construction time would bind to null
    // and the key bar would never appear.
    wireTerminalFocus(rec.term)
    // Register the output sink only once the renderer exists. xterm drops
    // writes made before open() — and the PTY's banner often arrives while the
    // tab is still being created, which is exactly how the first screenful
    // went missing.
    attachTerminal(tabId, rec.term, (data) => rec.term.write(data))
  }
  if (tabId === activeTabId.value) {
    nextTick(() => requestAnimationFrame(fitActive))
  }
}

/**
 * Track "the terminal owns the keyboard".
 *
 * xterm renders into a hidden textarea; its focus is the only signal that works
 * across Android WebView, mobile browsers and a desktop window. A blur caused by
 * tapping a key-bar button must NOT collapse the bar, so the clear is deferred
 * one tick and cancelled when focus is still inside the terminal pane.
 */
function wireTerminalFocus(term: Terminal) {
  const ta = term.textarea
  if (!ta || (ta as unknown as { __wired?: boolean }).__wired) return
  ;(ta as unknown as { __wired?: boolean }).__wired = true
  ta.addEventListener('focus', () => {
    termFocused.value = true
    setTerminalFocus(true)
  })
  ta.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement?.closest('.term-body')) return
      termFocused.value = false
      setTerminalFocus(false)
    }, 0)
  })
}

function fitActive() {
  const id = activeTabId.value
  const rec = terms.get(id)
  if (!rec) return
  try {
    rec.fit.fit()
  } catch {
    // fit throws when the host has zero size (tab hidden mid-layout); the next
    // resize observer pass will succeed.
  }
}

// Refit when the active tab changes, the viewport resizes, or the keyboard
// opens (both change the available rows).
watch(activeTabId, () => nextTick(() => requestAnimationFrame(fitActive)))
watch(keyboardHeight, () => nextTick(() => requestAnimationFrame(fitActive)))

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  const root = document.querySelector('.term-body') as HTMLElement | null
  if (root && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => fitActive())
    resizeObserver.observe(root)
  }
  window.addEventListener('resize', fitActive)
  // First tab: if a host exists, open one so the panel is not empty on arrival.
  if (tabs.value.length === 0 && hosts.value.length > 0) {
    // Do not auto-open on first visit: a phone user who taps "Terminal" without
    // picking a host should see the empty state, not a connection they did not
    // ask for.
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', fitActive)
})

// Theme changes must repaint every open terminal, including background tabs:
// xterm keeps its own palette and does not read CSS variables.
watch(effectiveTheme, (id) => {
  const theme = buildXtermTheme(id)
  for (const { term } of terms.values()) term.options.theme = theme
})

watch(() => settings.terminalFontSize, (v) => {
  for (const { term, fit } of terms.values()) {
    term.options.fontSize = v
    try { fit.fit() } catch { /* hidden tab */ }
  }
})

watch(() => settings.terminalFont, (v) => {
  const stack = terminalFontStack(v)
  for (const { term } of terms.values()) term.options.fontFamily = stack
})

watch(() => settings.cursorBlink, (v) => {
  for (const { term } of terms.values()) term.options.cursorBlink = v
})

// ── Actions ────────────────────────────────────────────────────────────────

function openNewTab() {
  const candidates = hosts.value.filter((h) => !tabs.value.some((tb) => tb.hostId === h.id))
  const host = candidates[0] ?? hosts.value[0]
  if (!host) {
    showToast(t('hosts.emptyHint'), 'info')
    return
  }
  const cols = 80
  const rows = 24
  try {
    const tab = openTab(host.id, cols, rows)
    selectTab(tab.id)
  } catch {
    showToast(t('terminal.tabLimit', { n: MAX_TABS }), 'error')
  }
}

async function requestClose(tabId: string) {
  const tab = tabs.value.find((x) => x.id === tabId)
  if (!tab) return
  if (settings.confirmClose && tab.state === 'connected') {
    const ok = await confirmDialog({
      title: t('terminal.closeTab'),
      message: t('terminal.closeConfirm'),
      confirmLabel: t('terminal.closeTab'),
      danger: true,
    })
    if (!ok) return
  }
  terms.get(tabId)?.dispose()
  terms.delete(tabId)
  detachTerminal(tabId)
  hostEls.delete(tabId)
  closeTab(tabId)
}

/**
 * Restart an exited/failed tab.
 *
 * A new session id is required: the old PTY is gone, so re-attaching would just
 * come back with `session_gone`. Reusing the tab keeps its position in the bar,
 * which is what the user expects from "restart".
 */
function restartTab(tabId: string) {
  const tab = tabs.value.find((x) => x.id === tabId)
  if (!tab) return
  terms.get(tabId)?.dispose()
  terms.delete(tabId)
  detachTerminal(tabId)
  const hostId = tab.hostId
  const idx = tabs.value.findIndex((x) => x.id === tabId)
  closeTab(tabId)
  nextTick(() => {
    try {
      const fresh = openTab(hostId)
      selectTab(fresh.id)
      // Keep the bar order stable rather than appending to the end.
      const cur = tabs.value.findIndex((x) => x.id === fresh.id)
      if (cur !== -1 && idx !== -1) {
        const arr = [...tabs.value]
        const [moved] = arr.splice(cur, 1)
        arr.splice(Math.min(idx, arr.length), 0, moved)
        tabs.value = arr
      }
    } catch {
      showToast(t('terminal.tabLimit', { n: MAX_TABS }), 'error')
    }
  })
}

function sendKey(name: keyof typeof KEY_SEQUENCES) {
  const id = activeTabId.value
  if (!id) return
  const seq = KEY_SEQUENCES[name]
  sendInput(id, seq)
}

function sendChar(ch: string) {
  const id = activeTabId.value
  if (!id) return
  sendInput(id, modifiers.consume(ch))
  if (settings.haptic) navigator.vibrate?.(8)
}

function sendSnippet(cmd: string, send: boolean) {
  const id = activeTabId.value
  if (!id) return
  sendInput(id, send ? `${cmd}\r` : cmd)
  snippetsOpen.value = false
  terms.get(id)?.term.focus()
}

async function copyError(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    showToast(t('common.copied'), 'success')
  } catch {
    showToast(text, 'error', 5000)
  }
}

// Keep the terminal focused after a tab switch so the soft keyboard stays up if
// it was already open.
watch(activeTabId, () => {
  const id = activeTabId.value
  if (!id) return
  nextTick(() => {
    // Only take focus back if it was already in the terminal: stealing focus on
    // a tab switch would pop the keyboard up for someone who was just browsing.
    if (termFocused.value) terms.get(id)?.term.focus()
  })
})

defineExpose({ fitActive })
</script>

<style scoped>
.terminal-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-primary);
  overflow: hidden;
}

/* ── Tab bar ─────────────────────────────────────────────────────────────── */

.term-tab-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  height: 34px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  overflow: hidden;
}

.term-tab-list {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
  gap: 1px;
  overflow-x: auto;
  scrollbar-width: none;
}

.term-tab-list::-webkit-scrollbar {
  display: none;
}

.term-tab {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  max-width: 168px;
  padding: 0 var(--space-4);
  border: none;
  border-radius: var(--radius-xs) var(--radius-xs) 0 0;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: background var(--duration-fast), color var(--duration-fast);
}

.term-tab.active {
  background: var(--bg-primary);
  color: var(--text-primary);
}

/* The active tab is connected to the terminal body by a 2px accent rail along
   the bottom — the same "this is the live one" language the dock uses. */
.term-tab.active::after {
  content: '';
  position: absolute;
  left: var(--space-3);
  right: var(--space-3);
  bottom: 0;
  height: 2px;
  border-radius: 2px;
  background: var(--accent-color);
}

.term-tab-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-hint);
}

.term-tab-dot.is-connected {
  background: var(--color-success);
}

.term-tab-dot.is-connecting,
.term-tab-dot.is-reconnecting {
  background: var(--color-yellow);
  animation: tab-pulse 1.2s ease-in-out infinite;
}

.term-tab-dot.is-error,
.term-tab-dot.is-exited {
  background: var(--color-red);
}

@keyframes tab-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.term-tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.term-tab-unread {
  flex-shrink: 0;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent-color);
}

.term-tab-close {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: var(--space-2);
  border-radius: var(--radius-xs);
  color: var(--text-muted);
}

.term-tab-close:active {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.term-tab-add {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.term-tab-add:disabled {
  opacity: var(--opacity-disabled);
  cursor: default;
}

.term-tab-add:active:not(:disabled) {
  background: var(--bg-tertiary);
}

.term-tab-add.active {
  color: var(--accent-color);
  background: color-mix(in srgb, var(--accent-color) 12%, transparent);
}

/* ── Search bar ─────────────────────────────────────────────────────────── */

.term-search {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.term-search-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.term-search-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xs);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 16px;
  outline: none;
}

.term-search-input:focus {
  border-color: var(--accent-color);
}

/* Fixed width so the buttons do not jump as the count grows from 1/9 to 12/34. */
.term-search-count {
  flex-shrink: 0;
  min-width: 42px;
  text-align: right;
  font-size: var(--font-size-2xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}

.term-search-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.term-search-btn:active {
  background: var(--bg-tertiary);
}

/* ── Terminal body ───────────────────────────────────────────────────────── */

.term-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

/* Every tab keeps its host element; only the active one is laid out. Using
   `display:none` (not `v-if`) is what lets xterm keep its buffer AND lets
   FitAddon measure a visible box again when the tab comes back. */
.term-host {
  display: none;
  flex: 1;
  min-height: 0;
  padding: var(--space-3) 0 0 var(--space-3);
}

.term-host.active {
  display: block;
}

/* xterm's viewport: the terminal itself owns scrolling, so the page must not
   also scroll it. */
.term-host :deep(.xterm) {
  height: 100%;
  padding: 0;
}

.term-host :deep(.xterm-viewport) {
  overscroll-behavior: contain;
  background: transparent !important;
}

.term-host :deep(.xterm-screen) {
  height: 100%;
}

/* ── Status overlay ─────────────────────────────────────────────────────── */

.term-status {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-8);
  background: color-mix(in srgb, var(--bg-primary) 82%, transparent);
  backdrop-filter: blur(2px);
  z-index: 3;
}

.status-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-5);
  max-width: 320px;
  padding: var(--space-7) var(--space-8);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--bg-secondary);
  box-shadow: var(--shadow-md);
  font-size: var(--font-size-md);
  color: var(--text-secondary);
  text-align: center;
}

.status-card.error {
  border-color: color-mix(in srgb, var(--color-red) 45%, var(--border-color));
}

.status-text {
  line-height: var(--line-height-relaxed);
  word-break: break-word;
}

.status-actions {
  display: flex;
  gap: var(--space-3);
}

/* ── Key bar ────────────────────────────────────────────────────────────── */

.key-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-3);
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  overflow-x: auto;
  scrollbar-width: none;
  /* The bar sits directly above the keyboard, which is already inset-aware. */
  padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
}

.key-bar::-webkit-scrollbar {
  display: none;
}

.key {
  flex-shrink: 0;
  min-width: 38px;
  height: 30px;
  padding: 0 var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xs);
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  cursor: pointer;
  transition: background var(--duration-fast), color var(--duration-fast), border-color var(--duration-fast);
}

.key:active {
  background: var(--bg-tertiary);
}

.key.locked {
  background: color-mix(in srgb, var(--accent-color) 20%, transparent);
  border-color: var(--accent-color);
  color: var(--accent-color);
}
</style>
