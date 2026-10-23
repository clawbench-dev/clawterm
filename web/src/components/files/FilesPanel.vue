<template>
  <div class="panel">
    <!-- Host picker: the file browser is host-scoped, so the first decision is
         always which machine. A segmented strip beats a dropdown here — there
         are usually only a handful of hosts and switching is frequent. -->
    <div class="panel-toolbar files-toolbar">
      <select v-model.number="hostId" class="form-select host-select" data-field="files-host" @change="onHostChange">
        <option v-for="h in hosts" :key="h.id" :value="h.id">{{ h.name }}</option>
      </select>
      <button class="toolbar-btn" :disabled="!hostId" :title="t('files.parent')" @click="goUp">
        <ArrowUpIcon :size="15" />
      </button>
      <button class="toolbar-btn" :disabled="!hostId" :title="t('files.home')" @click="goHome">
        <HomeIcon :size="15" />
      </button>
      <button class="toolbar-btn" :disabled="!hostId" :title="t('common.refresh')" @click="refresh">
        <RefreshIcon :size="15" />
      </button>
    </div>

    <!-- Breadcrumb. Scrolls horizontally rather than wrapping so a deep path
         never pushes the list off screen. -->
    <div v-if="hostId && crumbs.length" class="breadcrumb">
      <button class="crumb" @click="navigate('/')">/</button>
      <template v-for="(c, i) in crumbs" :key="c.path">
        <span v-if="i > 0" class="crumb-sep">/</span>
        <button class="crumb" :class="{ current: i === crumbs.length - 1 }" @click="navigate(c.path)">
          {{ c.name }}
        </button>
      </template>
    </div>

    <div class="panel-scroll">
      <div v-if="!hostId" class="empty-state">
        <FolderTreeIcon :size="34" class="empty-icon" />
        <p class="empty-title">{{ t('files.noHost') }}</p>
        <p class="empty-hint">{{ t('hosts.emptyHint') }}</p>
      </div>

      <LoadingIndicator v-else-if="loading && entries.length === 0" :label="t('files.loadingDir')" />

      <div v-else-if="loadError" class="empty-state">
        <p class="empty-title">{{ t('files.loadFailed') }}</p>
        <p class="empty-hint">{{ loadError }}</p>
        <button class="empty-action" @click="refresh">{{ t('common.retry') }}</button>
      </div>

      <div v-else-if="entries.length === 0" class="empty-state">
        <p class="empty-title">{{ t('files.empty') }}</p>
      </div>

      <template v-else>
        <button
          v-for="e in visibleEntries"
          :key="e.path"
          class="file-row"
          :class="{ dir: e.isDir }"
          :data-file="e.name"
          @click="activate(e)"
        >
          <span class="file-icon">
            <FolderIcon v-if="e.isDir" :size="17" />
            <FileIcon v-else :size="17" />
            <LinkIcon v-if="e.isLink" :size="9" class="link-mark" />
          </span>
          <span class="file-name" :title="e.name">{{ e.name }}</span>
          <span class="file-size">{{ e.isDir ? '' : formatSize(e.size) }}</span>
          <span class="file-time">{{ formatTime(e.modTime) }}</span>
          <span class="file-more" @click.stop="openMenu($event, e)">
            <MoreVerticalIcon :size="14" />
          </span>
        </button>
        <p v-if="truncated" class="truncated-hint">{{ t('files.tooMany') }}</p>
      </template>
    </div>

    <PopupMenu v-model:show="menuOpen" :target-element="menuAnchor" anchor="right" :max-width="190" :menu-items-count="4">
      <button class="menu-item" @click="menuPreview">
        <EyeIcon :size="14" /> {{ t('files.preview') }}
      </button>
      <button class="menu-item" @click="menuCopyPath">
        <CopyIcon :size="14" /> {{ t('files.copyPath') }}
      </button>
      <button class="menu-item" @click="menuDownload">
        <DownloadIcon :size="14" /> {{ t('files.download') }}
      </button>
      <button class="menu-item" @click="menuOpenInTerminal">
        <SquareTerminalIcon :size="14" /> {{ t('files.openInTerminal') }}
      </button>
    </PopupMenu>

    <FilePreviewSheet :open="previewOpen" :host-id="hostId" :path="previewPath" @close="previewOpen = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowUp as ArrowUpIcon, Home as HomeIcon, RefreshCw as RefreshIcon,
  Folder as FolderIcon, File as FileIcon, Link as LinkIcon,
  MoreVertical as MoreVerticalIcon, Eye as EyeIcon, Copy as CopyIcon,
  Download as DownloadIcon, SquareTerminal as SquareTerminalIcon,
  FolderTree as FolderTreeIcon,
} from 'lucide-vue-next'
import LoadingIndicator from '@/components/common/LoadingIndicator.vue'
import PopupMenu from '@/components/common/PopupMenu.vue'
import FilePreviewSheet from './FilePreviewSheet.vue'
import { hosts, loadHosts } from '@/composables/useHosts'
import { downloadFile, formatSize, formatTime, listDir, rememberedPath, type FileEntry } from '@/composables/useFiles'
import { showToast } from '@/composables/useUi'
import { activeTab as activeTerminalTab, openTab, selectTab, sendInput, tabs } from '@/composables/useTerminalTabs'
import { switchTab } from '@/composables/useNavigation'

const { t } = useI18n()

const hostId = ref(0)
const cwd = ref('')
const entries = ref<FileEntry[]>([])
const loading = ref(false)
const loadError = ref('')
const truncated = ref(false)
const MAX_ROWS = 5000

const menuOpen = ref(false)
const menuAnchor = ref<HTMLElement | null>(null)
const menuEntry = ref<FileEntry | null>(null)

const previewOpen = ref(false)
const previewPath = ref('')

const visibleEntries = computed(() => entries.value.slice(0, MAX_ROWS))

/**
 * Breadcrumb segments from the current absolute path.
 *
 * Built from the resolved path the server returned, not from what the user
 * typed: `cd ..`-style relative navigation would otherwise produce a crumb
 * trail that does not match where they actually are.
 */
const crumbs = computed(() => {
  const p = cwd.value
  if (!p || p === '/') return []
  const parts = p.split('/').filter(Boolean)
  const out: { name: string; path: string }[] = []
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    out.push({ name: part, path: acc })
  }
  return out
})

onMounted(async () => {
  try {
    await loadHosts()
    // Prefer the host the terminal is on: someone who just SSH'd into a server
    // and switched to Files wants THAT server's filesystem, not the first entry
    // in an alphabetically unrelated list.
    const fromTerminal = activeTerminalTab.value?.hostId
    const pick = fromTerminal && hosts.value.some((h) => h.id === fromTerminal)
      ? fromTerminal
      : hosts.value[0]?.id
    if (pick) {
      hostId.value = pick
      await navigate(rememberedPath(pick))
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
  }
})

async function navigate(path: string) {
  if (!hostId.value) return
  loading.value = true
  loadError.value = ''
  try {
    const res = await listDir(hostId.value, path)
    cwd.value = res.path
    entries.value = res.entries
    truncated.value = res.entries.length > MAX_ROWS
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
    entries.value = []
  } finally {
    loading.value = false
  }
}

function refresh() {
  void navigate(cwd.value || rememberedPath(hostId.value))
}

function goUp() {
  if (!cwd.value || cwd.value === '/') return
  const parent = cwd.value.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'
  void navigate(parent)
}

function goHome() {
  void navigate('.')
}

function onHostChange() {
  cwd.value = ''
  entries.value = []
  void navigate(rememberedPath(hostId.value))
}

function activate(e: FileEntry) {
  if (e.isDir) {
    void navigate(e.path)
    return
  }
  previewPath.value = e.path
  previewOpen.value = true
}

function openMenu(ev: MouseEvent, e: FileEntry) {
  menuAnchor.value = ev.currentTarget as HTMLElement
  menuEntry.value = e
  menuOpen.value = true
}

function menuPreview() {
  const e = menuEntry.value
  if (!e || e.isDir) return
  previewPath.value = e.path
  previewOpen.value = true
}

async function menuCopyPath() {
  const e = menuEntry.value
  if (!e) return
  try {
    await navigator.clipboard.writeText(e.path)
    showToast(t('common.copied'), 'success')
  } catch {
    showToast(e.path, 'info', 5000)
  }
}

async function menuDownload() {
  const e = menuEntry.value
  if (!e || e.isDir) return
  showToast(t('files.downloading'), 'loading', 0)
  try {
    const res = await downloadFile(hostId.value, e.path)
    showToast(res.saved ? t('files.downloadDone') : t('files.downloadCancelled'),
      res.saved ? 'success' : 'info')
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error', 5000)
  }
}

/**
 * Open a terminal already sitting in this directory.
 *
 * Reuses an existing tab for the same host when there is one (a second SSH
 * session just to `cd` somewhere is wasteful), otherwise opens a new tab and
 * types the `cd`.
 */
function menuOpenInTerminal() {
  const e = menuEntry.value
  if (!e) return
  const dir = e.isDir ? e.path : e.path.replace(/\/[^/]+$/, '')
  const existing = tabs.value.find((x) => x.hostId === hostId.value && x.state === 'connected')
  if (existing) {
    selectTab(existing.id)
    switchTab('terminal')
    // Defer so the terminal is the active one before the text lands.
    setTimeout(() => sendInput(existing.id, `cd ${shellQuote(dir)}\r`), 60)
    return
  }
  try {
    const tab = openTab(hostId.value)
    selectTab(tab.id)
    switchTab('terminal')
    // A brand-new tab has to finish connecting first; 900ms covers a local
    // network round trip, and a slow link simply drops the `cd` rather than
    // typing it into a half-open session.
    setTimeout(() => sendInput(tab.id, `cd ${shellQuote(dir)}\r`), 900)
  } catch {
    showToast(t('terminal.tabLimit', { n: 12 }), 'error')
  }
}

/** Quote a path for POSIX shells. Single quotes are the only reliable form. */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}
</script>

<style scoped>
.files-toolbar {
  gap: var(--space-2);
}

.host-select {
  flex: 1;
  min-width: 0;
  height: 32px;
  min-height: 32px;
  padding: 0 var(--space-4);
  font-size: var(--font-size-md);
}

.breadcrumb {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-primary);
  overflow-x: auto;
  scrollbar-width: none;
  white-space: nowrap;
}

.breadcrumb::-webkit-scrollbar {
  display: none;
}

.crumb {
  flex-shrink: 0;
  padding: var(--space-1) var(--space-3);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  cursor: pointer;
}

.crumb.current {
  color: var(--text-primary);
  font-weight: var(--font-weight-medium);
}

.crumb:active {
  background: var(--bg-tertiary);
}

.crumb-sep {
  color: var(--text-hint);
  font-size: var(--font-size-xs);
}

.file-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
  padding: var(--space-3) var(--space-5);
  border: none;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 30%, transparent);
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.file-row:active {
  background: var(--bg-tertiary);
}

@media (hover: hover) {
  .file-row:hover {
    background: var(--bg-secondary);
  }
}

.file-icon {
  position: relative;
  flex-shrink: 0;
  display: flex;
  color: var(--text-muted);
}

.file-row.dir .file-icon {
  color: var(--accent-color);
}

.link-mark {
  position: absolute;
  right: -3px;
  bottom: -3px;
  color: var(--text-hint);
}

.file-name {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-md);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  flex-shrink: 0;
  width: 62px;
  text-align: right;
  font-size: var(--font-size-2xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.file-time {
  flex-shrink: 0;
  width: 76px;
  text-align: right;
  font-size: var(--font-size-2xs);
  color: var(--text-hint);
  font-variant-numeric: tabular-nums;
}

.file-more {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
}

.file-more:active {
  background: var(--bg-tertiary);
}

.truncated-hint {
  padding: var(--space-4) var(--space-6);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  text-align: center;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
  padding: var(--space-4) var(--space-6);
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-md);
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}

.menu-item:hover {
  background: var(--bg-tertiary);
}
</style>
