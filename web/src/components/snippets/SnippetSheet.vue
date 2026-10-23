<template>
  <BottomSheet :open="open" :title="t('terminal.quickCommands')" maximized @close="emit('close')">
    <template #header>
      <ZapIcon :size="16" class="sheet-header-icon" />
      <span class="bs-title">{{ t('terminal.quickCommands') }}</span>
      <span class="sheet-header-actions">
        <button class="icon-btn" :title="t('snippets.add')" @click="openEditor()">
          <PlusIcon :size="16" />
        </button>
      </span>
    </template>

    <div v-if="list.length === 0" class="empty-state">
      <ZapIcon :size="32" class="empty-icon" />
      <p class="empty-title">{{ t('snippets.empty') }}</p>
      <p class="empty-hint">{{ t('snippets.emptyHint') }}</p>
      <button class="empty-action" @click="openEditor()">
        <PlusIcon :size="16" />
        <span>{{ t('snippets.add') }}</span>
      </button>
    </div>

    <div v-else class="snippet-list">
      <div v-for="s in list" :key="s.id" class="snippet-row" :data-snippet-id="s.id">
        <button class="snippet-send" :title="t('terminal.sendSnippet')" @click="emit('send', s.command, s.send)">
          <PlayIcon :size="14" />
        </button>
        <span class="snippet-main">
          <span class="snippet-label">
            {{ s.label }}
            <span v-if="!s.send" class="snippet-badge">{{ t('snippets.sendNow') }}</span>
          </span>
          <span class="snippet-cmd">{{ s.command }}</span>
        </span>
        <span class="list-row-actions">
          <button class="icon-btn" :title="t('common.edit')" @click="openEditor(s)">
            <PencilIcon :size="14" />
          </button>
          <button class="icon-btn danger" :title="t('common.delete')" @click="remove(s)">
            <Trash2Icon :size="14" />
          </button>
        </span>
      </div>
    </div>

    <SnippetEditorModal :open="editorOpen" :snippet="editing" :host-id="hostId" @close="editorOpen = false" @saved="onSaved" />
  </BottomSheet>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Zap as ZapIcon, Plus as PlusIcon, Play as PlayIcon,
  Pencil as PencilIcon, Trash2 as Trash2Icon,
} from 'lucide-vue-next'
import BottomSheet from '@/components/common/BottomSheet.vue'
import SnippetEditorModal from './SnippetEditorModal.vue'
import { deleteSnippet, loadSnippets, snippets, type Snippet } from '@/composables/useSnippets'
import { confirmDialog, showToast } from '@/composables/useUi'

const props = defineProps<{ open: boolean; hostId: number }>()
const emit = defineEmits<{ close: []; send: [cmd: string, send: boolean] }>()
const { t } = useI18n()

const editorOpen = ref(false)
const editing = ref<Snippet | null>(null)

/** Global snippets plus the ones scoped to this host. */
const list = computed(() => snippets.value.filter((s) => s.hostId === 0 || s.hostId === props.hostId))

onMounted(() => {
  void loadSnippets().catch(() => showToast(t('common.error'), 'error'))
})

function openEditor(s?: Snippet) {
  editing.value = s ?? null
  editorOpen.value = true
}

function onSaved() {
  editorOpen.value = false
}

async function remove(s: Snippet) {
  const ok = await confirmDialog({
    title: t('common.delete'),
    message: t('snippets.deleteConfirm', { label: s.label }),
    confirmLabel: t('common.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    await deleteSnippet(s.id)
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
  }
}
</script>

<style scoped>
.sheet-header-icon {
  color: var(--accent-color);
}

.sheet-header-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.snippet-list {
  padding-bottom: var(--space-6);
}

.snippet-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 45%, transparent);
}

.snippet-send {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid color-mix(in srgb, var(--accent-color) 45%, transparent);
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent-color) 10%, transparent);
  color: var(--accent-color);
  cursor: pointer;
}

.snippet-send:active {
  transform: scale(0.94);
}

.snippet-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.snippet-label {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-size-md);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.snippet-badge {
  flex-shrink: 0;
  padding: 0 var(--space-2);
  border-radius: var(--radius-xs);
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-size: var(--font-size-2xs);
  line-height: 14px;
}

.snippet-cmd {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
