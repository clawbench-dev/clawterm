<template>
  <div class="app-container" :class="{ 'keyboard-open': keyboardOpen }">
    <header class="header">
      <button class="header-logo-btn" type="button" :title="t('settings.title')" @click="openSettings">
        <TerminalSquare :size="16" />
      </button>

      <div class="header-context">
        <span class="header-label">{{ t(`nav.${activeTab}`) }}</span>
        <span v-if="contextLabel" class="header-context-name">{{ contextLabel }}</span>
      </div>

      <div class="header-actions">
        <button class="header-btn" :title="t('settings.theme')" data-action="theme" @click="themeOpen = true">
          <PaletteIcon :size="16" />
        </button>
        <button class="header-btn" :title="t('settings.title')" data-action="settings" @click="openSettings">
          <SettingsIcon :size="16" />
        </button>
      </div>
    </header>

    <main class="main-content" :class="{ 'wide-screen': isWideScreen }">
      <!-- Wide-screen vertical dock (VS Code activity-bar shape) -->
      <div v-if="isWideScreen" class="wide-dock">
        <div class="wide-dock-center">
          <button
            v-for="tab in TABS"
            :key="tab.id"
            class="dock-btn"
            :data-tab="tab.id"
            :class="{ active: activeTab === tab.id }"
            :title="t(`nav.${tab.id}`)"
            @click="switchTab(tab.id)"
          >
            <component :is="tab.icon" />
          </button>
        </div>
      </div>

      <!-- Wide screens get a persistent session rail next to the dock: with
           room for it, hunting for a host or a tab through a drawer is pure
           friction. Narrow screens keep the dock-only layout. -->
      <SessionSidebar
        v-if="isWideScreen"
        @connect="connectHost"
        @select-tab="selectTabAndShow"
        @close-tab="requestCloseTab"
        @add-host="openHostEditor"
      />

      <div class="content-area">
        <KeepAlive>
          <component :is="currentPanel" :key="activeTab" />
        </KeepAlive>
      </div>
    </main>

    <!-- Bottom dock (narrow). Hidden while the soft keyboard is open: the fixed
         shell keeps full height on a mobile browser, so the dock would sit
         behind the IME. -->
    <div v-if="!isWideScreen && !keyboardOpen" class="bottom-dock-wrapper">
      <div class="bottom-dock">
        <div class="dock-center">
          <div class="dock-active-indicator" :style="indicatorStyle"></div>
          <button
            v-for="(tab, i) in TABS"
            :key="tab.id"
            :ref="(el) => setDockRef(el as HTMLElement | null, i)"
            class="dock-btn"
            :data-tab="tab.id"
            :class="{ active: activeTab === tab.id }"
            :title="t(`nav.${tab.id}`)"
            @click="switchTab(tab.id)"
          >
            <component :is="tab.icon" />
            <span v-if="tab.id === 'terminal' && runningCount > 0" class="dock-badge dock-badge-count count-badge">{{ runningCount }}</span>
          </button>
        </div>
      </div>
      <div class="dock-safe-area"></div>
    </div>

    <HostEditorSheet :open="hostEditorOpen" :host="null" :prefill="null" @close="hostEditorOpen = false" @saved="hostEditorOpen = false" />
    <ThemeSheet :open="themeOpen" @close="themeOpen = false" />
    <ToastHost />
    <ConfirmHost />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  TerminalSquare,
  Palette as PaletteIcon,
  Settings as SettingsIcon,
  Server,
  SquareTerminal,
  FolderTree,
  Zap,
  Settings,
} from 'lucide-vue-next'
import ThemeSheet from '@/components/common/ThemeSheet.vue'
import ToastHost from '@/components/common/ToastHost.vue'
import ConfirmHost from '@/components/common/ConfirmHost.vue'
import HostsPanel from '@/components/hosts/HostsPanel.vue'
import TerminalPanel from '@/components/terminal/TerminalPanel.vue'
import FilesPanel from '@/components/files/FilesPanel.vue'
import SnippetsPanel from '@/components/snippets/SnippetsPanel.vue'
import SettingsPanel from '@/components/settings/SettingsPanel.vue'
import SessionSidebar from '@/components/hosts/SessionSidebar.vue'
import HostEditorSheet from '@/components/hosts/HostEditorSheet.vue'
import { installBackPressBridge, installEdgeSwipeBack, installUiWatchers, useTerminalFocus, useWideScreen } from '@/composables/useUi'
import { activeTab as navTab, switchTab as navSwitch, type TabId } from '@/composables/useNavigation'
import { activeTab as currentTerminalTab, closeTab, openTab, runningCount, selectTab, tabs as allTabs } from '@/composables/useTerminalTabs'
import { hostById } from '@/composables/useHosts'
import { confirmDialog, showToast } from '@/composables/useUi'
import { settings } from '@/composables/useSettings'

const TABS: { id: TabId; icon: unknown }[] = [
  { id: 'hosts', icon: Server },
  { id: 'terminal', icon: SquareTerminal },
  { id: 'files', icon: FolderTree },
  { id: 'snippets', icon: Zap },
  { id: 'settings', icon: Settings },
]

const PANELS = {
  hosts: HostsPanel,
  terminal: TerminalPanel,
  files: FilesPanel,
  snippets: SnippetsPanel,
  settings: SettingsPanel,
} as const

const { t } = useI18n()
const { isWideScreen } = useWideScreen()
const activeTab = navTab
const switchTab = navSwitch
const { terminalFocused } = useTerminalFocus()

const themeOpen = ref(false)

// The dock hides while the terminal owns the keyboard: on a mobile browser the
// fixed shell keeps full height, so the dock would be covered by the IME. Any
// other tab hides it whenever a text field is focused, which the terminal is
// the only source of here.
const keyboardOpen = computed(() => terminalFocused.value)

const currentPanel = computed(() => PANELS[activeTab.value])

/** Sub-title in the header: the active host, for the host-scoped tabs. */
const contextLabel = computed(() => {
  if (activeTab.value !== 'terminal' && activeTab.value !== 'files') return ''
  const tab = currentTerminalTab.value
  if (!tab) return ''
  const h = hostById(tab.hostId)
  return h ? h.name : ''
})

// ── Dock indicator ──────────────────────────────────────────────────────────

const dockRefs = shallowRef<(HTMLElement | null)[]>([])
const indicatorStyle = ref<Record<string, string>>({})

function setDockRef(el: HTMLElement | null, i: number) {
  if (!dockRefs.value[i] && el) dockRefs.value[i] = el
}

/**
 * Slide the indicator to the active button.
 *
 * Measured from live geometry rather than an assumed step: the buttons are
 * centred in a `fit-content` row, so their x depends on the row's width, which
 * changes with the number of tabs and the font.
 */
function updateIndicator() {
  const idx = TABS.findIndex((tab) => tab.id === activeTab.value)
  const el = dockRefs.value[idx]
  const first = dockRefs.value[0]
  if (!el || !first) return
  const dx = el.offsetLeft - first.offsetLeft
  indicatorStyle.value = { transform: `translateX(${dx}px)` }
}

watch(activeTab, () => nextTick(updateIndicator))
watch(isWideScreen, () => nextTick(updateIndicator))

// ── Tab switching ───────────────────────────────────────────────────────────

function openSettings() {
  switchTab('settings')
}

// ── Sidebar actions ─────────────────────────────────────────────────────────

const hostEditorOpen = ref(false)

function openHostEditor() {
  hostEditorOpen.value = true
}

function connectHost(hostId: number) {
  try {
    // Reuse a live tab for this host rather than stacking a second SSH session
    // on the same server: the sidebar click means "show me that shell".
    const existing = tabsForHost(hostId)
    const tab = existing ?? openTab(hostId)
    selectTab(tab.id)
    switchTab('terminal')
  } catch {
    showToast(t('terminal.tabLimit', { n: 12 }), 'error')
  }
}

function tabsForHost(hostId: number) {
  return allTabs.value.find((x) => x.hostId === hostId && x.state === 'connected')
}

function selectTabAndShow(id: string) {
  selectTab(id)
  switchTab('terminal')
}

async function requestCloseTab(id: string) {
  const tab = allTabs.value.find((x) => x.id === id)
  if (tab && settings.confirmClose && tab.state === 'connected') {
    const ok = await confirmDialog({
      title: t('terminal.closeTab'),
      message: t('terminal.closeConfirm'),
      confirmLabel: t('terminal.closeTab'),
      danger: true,
    })
    if (!ok) return
  }
  closeTab(id)
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

let uninstallBack: (() => void) | null = null
let uninstallSwipe: (() => void) | null = null

onMounted(() => {
  installUiWatchers()
  uninstallBack = installBackPressBridge()
  uninstallSwipe = installEdgeSwipeBack()

  nextTick(updateIndicator)
  window.addEventListener('resize', updateIndicator)
})

onBeforeUnmount(() => {
  uninstallBack?.()
  uninstallSwipe?.()
  window.removeEventListener('resize', updateIndicator)
})
</script>

<style scoped>
.header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: calc(var(--header-height) + var(--header-safe-area-top));
  padding-top: var(--header-safe-area-top);
  padding-left: var(--space-3);
  padding-right: var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-4);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  z-index: var(--z-header);
  overflow: hidden;
}

.header-logo-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--accent-color);
  cursor: pointer;
}

.header-context {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  overflow: hidden;
}

.header-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  white-space: nowrap;
}

.header-context-name {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.header-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--duration-fast), color var(--duration-fast);
}

.header-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.content-area {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* The vertical dock reuses the bottom dock's button language (34px round
   buttons, accent-tinted active state) so the two layouts read as one app. */
.wide-dock {
  flex-shrink: 0;
  width: 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--bg-primary);
  border-right: 1px solid var(--border-color);
  padding-top: var(--space-6);
}

.wide-dock-center {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-6);
  overflow-y: auto;
  scrollbar-width: none;
}

.wide-dock-center::-webkit-scrollbar {
  display: none;
}

.wide-dock .dock-btn.active {
  color: var(--accent-color);
  background: color-mix(in srgb, var(--accent-color) 12%, transparent);
}

.wide-dock .dock-btn svg {
  width: 20px;
  height: 20px;
}

/* Terminal keeps the dock visible while the keyboard is open (the panel needs
   the space), so it shrinks instead of hiding. */
.app-container.keyboard-open .bottom-dock-wrapper {
  display: none;
}

.bottom-dock-wrapper {
  flex-shrink: 0;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.bottom-dock {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-3) var(--space-4);
  background: var(--bg-primary);
  border-top: 1px solid color-mix(in srgb, var(--border-color) 40%, transparent);
}

.dock-safe-area {
  height: env(safe-area-inset-bottom, 0px);
}

.dock-center {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-6);
  margin-inline: auto;
  width: fit-content;
}

.dock-active-indicator {
  position: absolute;
  left: 0;
  top: 50%;
  margin-top: -17px;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--accent-color);
  /* Slight overshoot then settle: the "water drop" feel the app uses. */
  transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
  z-index: 0;
  pointer-events: none;
}

.dock-btn {
  position: relative;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.25s, transform var(--duration-base);
  z-index: 1;
}

.dock-btn:active {
  transform: scale(0.92);
}

.dock-btn.active,
.dock-btn.active:hover {
  color: #fff;
}

.dock-btn svg {
  width: 16px;
  height: 16px;
}

/* Badge geometry comes from the shared .count-badge; only the dot reset and the
   corner offset are local. The pill radius must be re-declared because this
   scoped selector outranks the global class. */
.dock-badge {
  position: absolute;
  top: -4px;
  right: -6px;
  border-radius: var(--radius-full);
  background: var(--accent-color);
  color: #fff;
  font-weight: var(--font-weight-bold);
  z-index: 2;
  pointer-events: none;
}
</style>
