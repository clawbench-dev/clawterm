<template>
  <div class="panel">
    <div class="panel-toolbar">
      <div class="search-wrap">
        <SearchIcon :size="14" class="search-icon" />
        <input
          v-model="search"
          class="search-input"
          type="search"
          :placeholder="t('hosts.searchPlaceholder')"
          data-field="host-search"
        />
      </div>
      <button class="toolbar-btn primary" data-action="add-host" :title="t('hosts.addHost')" @click="openEditor()">
        <PlusIcon :size="16" />
      </button>
    </div>

    <div class="panel-scroll">
      <LoadingIndicator v-if="loading && hosts.length === 0" :label="t('common.loading')" />
      <div v-else-if="hosts.length === 0" class="empty-state">
        <ServerIcon :size="36" class="empty-icon" />
        <p class="empty-title">{{ t('hosts.empty') }}</p>
        <p class="empty-hint">{{ t('hosts.emptyHint') }}</p>
        <button class="empty-action" @click="openEditor()">
          <PlusIcon :size="16" />
          <span>{{ t('hosts.addHost') }}</span>
        </button>
      </div>
      <div v-else-if="grouped.length === 0" class="empty-state">
        <p class="empty-title">{{ t('hosts.noMatches') }}</p>
      </div>

      <template v-else>
        <section v-for="[group, list] in grouped" :key="group || '__ungrouped'" class="host-group">
          <h2 v-if="group" class="host-group-title">{{ group }}</h2>
          <button
            v-for="h in list"
            :key="h.id"
            class="host-row"
            :data-host-id="h.id"
            @click="connect(h)"
          >
            <span class="host-avatar" :style="avatarStyle(h)">
              {{ initials(h.name) }}
            </span>
            <span class="host-main">
              <span class="host-name">{{ h.name }}</span>
              <span class="host-addr">{{ h.username }}@{{ h.address }}:{{ h.port }}</span>
            </span>
            <span class="host-meta">
              <span v-if="h.authType === 'key'" class="host-tag">
                <KeyIcon :size="10" />
              </span>
              <span class="host-last">{{ lastUsed(h) }}</span>
            </span>
            <button class="host-more" :title="t('common.more')" @click.stop="openMenu($event, h)">
              <MoreVerticalIcon :size="14" />
            </button>
          </button>
        </section>
      </template>
    </div>

    <PopupMenu v-model:show="menuOpen" :target-element="menuAnchor" anchor="right" :max-width="180" :menu-items-count="5">
      <button class="menu-item" @click="menuEdit">
        <PencilIcon :size="14" /> {{ t('hosts.editHost') }}
      </button>
      <button class="menu-item" @click="menuTest">
        <ActivityIcon :size="14" /> {{ t('hosts.test') }}
      </button>
      <button class="menu-item" @click="menuDuplicate">
        <CopyIcon :size="14" /> {{ t('hosts.duplicate') }}
      </button>
      <button class="menu-item danger" @click="menuDelete">
        <Trash2Icon :size="14" /> {{ t('common.delete') }}
      </button>
    </PopupMenu>

    <HostEditorSheet
      :open="editorOpen"
      :host="editing"
      :prefill="prefill"
      @close="editorOpen = false"
      @saved="onSaved"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Search as SearchIcon,
  Plus as PlusIcon,
  Server as ServerIcon,
  MoreVertical as MoreVerticalIcon,
  Pencil as PencilIcon,
  Activity as ActivityIcon,
  Copy as CopyIcon,
  Trash2 as Trash2Icon,
  Key as KeyIcon,
} from 'lucide-vue-next'
import LoadingIndicator from '@/components/common/LoadingIndicator.vue'
import PopupMenu from '@/components/common/PopupMenu.vue'
import HostEditorSheet from './HostEditorSheet.vue'
import { useHosts, deleteHost, testHost, createHost, type Host } from '@/composables/useHosts'
import { showToast, confirmDialog } from '@/composables/useUi'
import { openTab, selectTab } from '@/composables/useTerminalTabs'
import { switchTab } from '@/composables/useNavigation'

const { t } = useI18n()
const { hosts, loading, search, grouped, loadHosts } = useHosts()

const editorOpen = ref(false)
const editing = ref<Host | null>(null)
const prefill = ref<Host | null>(null)

const menuOpen = ref(false)
const menuAnchor = ref<HTMLElement | null>(null)
const menuHost = ref<Host | null>(null)

onMounted(() => {
  void loadHosts(true).catch(() => showToast(t('common.error'), 'error'))
})

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

/**
 * Avatar tint. A per-host colour is a user choice; without one the hue is
 * derived from the id so a list of hosts stays visually distinguishable without
 * asking the user to pick twelve colours.
 */
function avatarStyle(h: Host) {
  const hue = h.color || `hsl(${(h.id * 47) % 360} 42% 45%)`
  return {
    background: h.color ? `color-mix(in srgb, ${h.color} 20%, transparent)` : `color-mix(in srgb, ${hue} 18%, transparent)`,
    color: h.color || hue,
    borderColor: `color-mix(in srgb, ${h.color || hue} 35%, transparent)`,
  }
}

function lastUsed(h: Host): string {
  if (!h.lastUsedAt) return t('hosts.never')
  const d = new Date(h.lastUsedAt)
  const diff = Date.now() - h.lastUsedAt
  if (diff < 60_000) return t('common.seconds', { n: Math.max(1, Math.round(diff / 1000)) })
  if (diff < 3_600_000) return t('common.minutes', { n: Math.round(diff / 60_000) })
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function connect(h: Host) {
  try {
    const tab = openTab(h.id)
    selectTab(tab.id)
    switchTab('terminal')
  } catch {
    showToast(t('terminal.tabLimit', { n: 12 }), 'error')
  }
}

function openEditor(host?: Host) {
  editing.value = host ?? null
  prefill.value = null
  editorOpen.value = true
}

function openMenu(e: MouseEvent, h: Host) {
  menuAnchor.value = e.currentTarget as HTMLElement
  menuHost.value = h
  menuOpen.value = true
}

function menuEdit() {
  if (menuHost.value) openEditor(menuHost.value)
}

async function menuTest() {
  const h = menuHost.value
  if (!h) return
  showToast(t('hosts.testing'), 'loading', 30_000)
  try {
    const res = await testHost(h.id)
    showToast(t('hosts.testOk', { ms: res.latency }), 'success')
    if (res.notice) showToast(res.notice, 'info', 5000)
  } catch (err) {
    showToast(`${t('hosts.testFail')}: ${err instanceof Error ? err.message : String(err)}`, 'error', 6000)
  }
}

async function menuDuplicate() {
  const h = menuHost.value
  if (!h) return
  try {
    // Secrets are not copied: the copy is a template the user fills in. Copying
    // them would silently double the blast radius of one leaked credential.
    const copy = await createHost({
      name: `${h.name} (copy)`,
      address: h.address,
      port: h.port,
      username: h.username,
      authType: h.authType,
      keyPath: h.keyPath,
      password: '',
      passphrase: '',
      color: h.color,
      group: h.group,
    })
    showToast(t('hosts.saved'), 'success')
    openEditor(copy)
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
  }
}

async function menuDelete() {
  const h = menuHost.value
  if (!h) return
  const ok = await confirmDialog({
    title: t('hosts.deleteConfirmTitle'),
    message: t('hosts.deleteConfirm', { name: h.name }),
    confirmLabel: t('common.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    await deleteHost(h.id)
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
  }
}

function onSaved() {
  editorOpen.value = false
  showToast(t('hosts.saved'), 'success')
}
</script>

<style scoped>
.host-group {
  display: flex;
  flex-direction: column;
}

.host-group-title {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: var(--space-4) var(--space-6) var(--space-2);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--text-muted);
  background: var(--bg-primary);
}

.host-row {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  width: 100%;
  padding: var(--space-4) var(--space-6);
  border: none;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast);
}

.host-row:active {
  background: var(--bg-tertiary);
}

@media (hover: hover) {
  .host-row:hover {
    background: var(--bg-secondary);
  }
}

.host-avatar {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-bold);
  font-variant-numeric: tabular-nums;
}

.host-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.host-name {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host-addr {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host-meta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--text-hint);
}

.host-tag {
  display: inline-flex;
  color: var(--text-muted);
}

.host-last {
  font-size: var(--font-size-2xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.host-more {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  margin-left: var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.host-more:active {
  background: var(--bg-tertiary);
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

.menu-item.danger {
  color: var(--color-red);
}
</style>
