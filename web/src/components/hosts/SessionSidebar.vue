<template>
  <aside class="sidebar">
    <div class="sidebar-section">
      <div class="sidebar-head">
        <span class="sidebar-title">{{ t('hosts.title') }}</span>
        <button class="sidebar-add" :title="t('hosts.addHost')" data-action="sidebar-add-host" @click="emit('add-host')">
          <PlusIcon :size="14" />
        </button>
      </div>
      <div class="sidebar-list">
        <button
          v-for="h in hosts"
          :key="h.id"
          class="sidebar-host"
          :data-sidebar-host="h.id"
          :title="`${h.username}@${h.address}:${h.port}`"
          @click="emit('connect', h.id)"
        >
          <span class="sidebar-dot" :style="{ background: h.color || accentFor(h.id) }" />
          <span class="sidebar-name">{{ h.name }}</span>
          <span v-if="connectedHosts.has(h.id)" class="sidebar-live" :title="t('hosts.connected')" />
        </button>
        <p v-if="hosts.length === 0" class="sidebar-empty">{{ t('hosts.empty') }}</p>
      </div>
    </div>

    <div class="sidebar-section grow">
      <div class="sidebar-head">
        <span class="sidebar-title">{{ t('terminal.title') }}</span>
        <span class="sidebar-count">{{ tabs.length }}</span>
      </div>
      <div class="sidebar-list">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="sidebar-tab"
          :class="{ active: tab.id === activeTabId }"
          :data-sidebar-tab="tab.id"
          @click="emit('select-tab', tab.id)"
        >
          <span class="sidebar-dot" :class="`state-${tab.state}`" />
          <span class="sidebar-name">{{ tab.title }}</span>
          <span class="sidebar-close" @click.stop="emit('close-tab', tab.id)">
            <XIcon :size="11" />
          </span>
        </button>
        <p v-if="tabs.length === 0" class="sidebar-empty">{{ t('terminal.noSessions') }}</p>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus as PlusIcon, X as XIcon } from 'lucide-vue-next'
import { hosts } from '@/composables/useHosts'
import { activeTabId, tabs } from '@/composables/useTerminalTabs'

const emit = defineEmits<{
  connect: [hostId: number]
  'select-tab': [tabId: string]
  'close-tab': [tabId: string]
  'add-host': []
}>()

const { t } = useI18n()

/**
 * Hosts that currently have a live terminal.
 *
 * Derived rather than stored: a host "is connected" exactly when one of its
 * tabs is, and a second copy of that fact would go stale the moment a shell
 * exits on its own.
 */
const connectedHosts = computed(() => {
  const set = new Set<number>()
  for (const tab of tabs.value) {
    if (tab.state === 'connected') set.add(tab.hostId)
  }
  return set
})

function accentFor(id: number): string {
  return `hsl(${(id * 47) % 360} 55% 55%)`
}
</script>

<style scoped>
.sidebar {
  flex-shrink: 0;
  width: 232px;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-color);
  overflow: hidden;
}

.sidebar-section {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.sidebar-section.grow {
  flex: 1;
  border-top: 1px solid var(--border-color);
}

.sidebar-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5) var(--space-2);
}

.sidebar-title {
  flex: 1;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--text-muted);
}

.sidebar-count {
  font-size: var(--font-size-2xs);
  color: var(--text-hint);
  font-variant-numeric: tabular-nums;
}

.sidebar-add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.sidebar-add:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.sidebar-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: var(--space-4);
}

.sidebar-host,
.sidebar-tab {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
  padding: var(--space-3) var(--space-5);
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.sidebar-host:hover,
.sidebar-tab:hover {
  background: var(--bg-tertiary);
}

.sidebar-tab.active {
  background: color-mix(in srgb, var(--accent-color) 12%, transparent);
  color: var(--accent-color);
}

.sidebar-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-hint);
}

.sidebar-dot.state-connected {
  background: var(--color-success);
}

.sidebar-dot.state-connecting,
.sidebar-dot.state-reconnecting {
  background: var(--color-yellow);
}

.sidebar-dot.state-error,
.sidebar-dot.state-exited {
  background: var(--color-red);
}

.sidebar-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A filled ring for "this host has a live shell" — distinct from the tab's own
   state dot, which sits one row below in the terminal section. */
.sidebar-live {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  border: 1.5px solid var(--color-success);
  background: color-mix(in srgb, var(--color-success) 40%, transparent);
}

.sidebar-close {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  opacity: 0;
  transition: opacity var(--duration-fast), background var(--duration-fast);
}

.sidebar-tab:hover .sidebar-close,
.sidebar-tab.active .sidebar-close {
  opacity: 1;
}

.sidebar-close:hover {
  background: var(--bg-primary);
  color: var(--text-primary);
}

.sidebar-empty {
  padding: var(--space-3) var(--space-5);
  font-size: var(--font-size-xs);
  color: var(--text-hint);
}
</style>
