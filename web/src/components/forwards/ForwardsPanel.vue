<template>
  <div class="panel">
    <div class="panel-toolbar">
      <span class="panel-title">{{ t('forwards.title') }}</span>
      <button class="toolbar-btn primary" :title="t('forwards.add')" data-action="add-forward" @click="editorOpen = true">
        <PlusIcon :size="16" />
      </button>
      <button class="toolbar-btn" :title="t('common.refresh')" @click="refresh">
        <RefreshIcon :size="15" />
      </button>
    </div>

    <div class="panel-scroll">
      <LoadingIndicator v-if="loading && forwards.length === 0" :label="t('common.loading')" />
      <div v-else-if="forwards.length === 0" class="empty-state">
        <ArrowLeftRightIcon :size="34" class="empty-icon" />
        <p class="empty-title">{{ t('forwards.empty') }}</p>
        <p class="empty-hint">{{ t('forwards.emptyHint') }}</p>
        <button class="empty-action" @click="editorOpen = true">
          <PlusIcon :size="16" />
          <span>{{ t('forwards.add') }}</span>
        </button>
      </div>

      <div v-for="f in forwards" v-else :key="`${f.hostId}:${f.localPort}`" class="forward-row" :data-port="f.localPort">
        <span class="forward-state" :class="{ on: f.running }" :title="f.running ? t('forwards.running') : t('forwards.stopped')" />
        <span class="forward-main">
          <span class="forward-route">
            <code>127.0.0.1:{{ f.localPort }}</code>
            <ArrowRightIcon :size="11" class="route-arrow" />
            <code>{{ f.remoteHost }}:{{ f.remotePort }}</code>
          </span>
          <span class="forward-meta">
            {{ f.hostName }}
            <template v-if="f.running && f.connections > 0"> · {{ t('forwards.connections', { n: f.connections }) }}</template>
            <template v-if="f.autoStart"> · auto</template>
          </span>
          <span v-if="f.error" class="forward-error">{{ f.error }}</span>
        </span>
        <span class="list-row-actions">
          <button
            v-if="f.running"
            class="icon-btn"
            :title="t('forwards.openLocal')"
            @click="openLocal(f.localPort)"
          >
            <ExternalLinkIcon :size="14" />
          </button>
          <button
            class="icon-btn"
            :title="f.running ? t('forwards.stop') : t('forwards.start')"
            @click="toggle(f)"
          >
            <SquareIcon v-if="f.running" :size="14" />
            <PlayIcon v-else :size="14" />
          </button>
          <button v-if="!f.running" class="icon-btn danger" :title="t('common.delete')" @click="remove(f)">
            <Trash2Icon :size="14" />
          </button>
        </span>
      </div>
    </div>

    <ForwardEditorSheet :open="editorOpen" @close="editorOpen = false" @saved="onSaved" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Plus as PlusIcon, RefreshCw as RefreshIcon, ArrowLeftRight as ArrowLeftRightIcon,
  ArrowRight as ArrowRightIcon, Play as PlayIcon, Square as SquareIcon,
  Trash2 as Trash2Icon, ExternalLink as ExternalLinkIcon,
} from 'lucide-vue-next'
import LoadingIndicator from '@/components/common/LoadingIndicator.vue'
import ForwardEditorSheet from './ForwardEditorSheet.vue'
import { loadForwards, startForward, stopForward, forwards, forwardsLoading as loading, type ForwardView } from '@/composables/useForwards'
import { loadHosts } from '@/composables/useHosts'
import { showToast } from '@/composables/useUi'

const { t } = useI18n()
const editorOpen = ref(false)

onMounted(() => {
  void Promise.all([loadForwards(true), loadHosts()]).catch((err) => {
    showToast(err instanceof Error ? err.message : String(err), 'error')
  })
})

function refresh() {
  void loadForwards(true).catch((err) => {
    showToast(err instanceof Error ? err.message : String(err), 'error')
  })
}

function onSaved() {
  editorOpen.value = false
  refresh()
}

async function toggle(f: ForwardView) {
  try {
    if (f.running) {
      await stopForward(f.localPort)
      showToast(t('forwards.stopped_toast'), 'info')
    } else {
      await startForward({
        hostId: f.hostId,
        localPort: f.localPort,
        remoteHost: f.remoteHost,
        remotePort: f.remotePort,
        autoStart: f.autoStart,
      })
      showToast(t('forwards.started'), 'success')
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error', 5000)
  }
}

async function remove(f: ForwardView) {
  try {
    // A stopped rule lives only in the database, so deleting it is the same
    // endpoint with nothing to unbind — the server tolerates that.
    await stopForward(f.localPort)
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
  }
}

function openLocal(port: number) {
  // Loopback only: the forward binds 127.0.0.1, and using "localhost" avoids a
  // DNS round trip that can resolve to ::1 and miss the IPv4 listener.
  window.open(`http://127.0.0.1:${port}/`, '_blank', 'noopener,noreferrer')
}
</script>

<style scoped>
.panel-title {
  flex: 1;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.forward-row {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  padding: var(--space-4) var(--space-6);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 45%, transparent);
}

.forward-state {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-hint);
}

.forward-state.on {
  background: var(--color-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-success) 20%, transparent);
}

.forward-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.forward-route {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.forward-route code {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  background: var(--bg-tertiary);
  padding: 1px var(--space-3);
  border-radius: var(--radius-xs);
}

.route-arrow {
  flex-shrink: 0;
  color: var(--text-muted);
}

.forward-meta {
  font-size: var(--font-size-2xs);
  color: var(--text-muted);
}

.forward-error {
  font-size: var(--font-size-2xs);
  color: var(--color-red);
  word-break: break-word;
}
</style>
