<template>
  <div class="panel">
    <div class="panel-toolbar">
      <div class="search-wrap">
        <SearchIcon :size="14" class="search-icon" />
        <input v-model="search" class="search-input" type="search" :placeholder="t('common.search')" />
      </div>
      <button class="toolbar-btn primary" :title="t('snippets.add')" data-action="add-snippet" @click="openEditor()">
        <PlusIcon :size="16" />
      </button>
    </div>

    <div class="panel-scroll">
      <div v-if="filtered.length === 0" class="empty-state">
        <ZapIcon :size="34" class="empty-icon" />
        <p class="empty-title">{{ t('snippets.empty') }}</p>
        <p class="empty-hint">{{ t('snippets.emptyHint') }}</p>
        <button class="empty-action" @click="openEditor()">
          <PlusIcon :size="16" />
          <span>{{ t('snippets.add') }}</span>
        </button>
      </div>

      <VueDraggable
        v-else
        v-model="draggable"
        handle=".drag-handle"
        :animation="150"
        @end="onDragEnd"
      >
        <div v-for="s in draggable" :key="s.id" class="list-row" :data-snippet-id="s.id">
          <span class="drag-handle" :title="t('snippets.dragHint')">⠿</span>
          <span class="list-row-main">
            <span class="list-row-title">{{ s.label }}</span>
            <span class="list-row-sub">{{ s.command }}</span>
          </span>
          <span class="list-row-actions">
            <span v-if="s.hostId" class="scope-chip">{{ hostName(s.hostId) }}</span>
            <span v-else class="scope-chip">{{ t('snippets.hostScopeAll') }}</span>
            <button class="icon-btn" :title="t('common.edit')" @click="openEditor(s)">
              <PencilIcon :size="14" />
            </button>
            <button class="icon-btn danger" :title="t('common.delete')" @click="remove(s)">
              <Trash2Icon :size="14" />
            </button>
          </span>
        </div>
      </VueDraggable>
    </div>

    <SnippetEditorModal :open="editorOpen" :snippet="editing" :host-id="0" @close="editorOpen = false" @saved="onSaved" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Search as SearchIcon, Plus as PlusIcon, Zap as ZapIcon,
  Pencil as PencilIcon, Trash2 as Trash2Icon,
} from 'lucide-vue-next'
import { VueDraggable } from 'vue-draggable-plus'
import SnippetEditorModal from './SnippetEditorModal.vue'
import { deleteSnippet, loadSnippets, reorderSnippets, snippets, type Snippet } from '@/composables/useSnippets'
import { hostById, loadHosts } from '@/composables/useHosts'
import { confirmDialog, showToast } from '@/composables/useUi'

const { t } = useI18n()
const search = ref('')
const editorOpen = ref(false)
const editing = ref<Snippet | null>(null)

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return q
    ? snippets.value.filter((s) => `${s.label} ${s.command}`.toLowerCase().includes(q))
    : snippets.value
})

/**
 * Local working copy for the drag list. VueDraggable mutates the array it is
 * bound to, and mutating the store's array during a drag would make the list
 * fight the animation when a reorder request fails.
 */
const draggable = ref<Snippet[]>([])

onMounted(async () => {
  try {
    await Promise.all([loadSnippets(true), loadHosts()])
    draggable.value = [...snippets.value]
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
  }
})

function hostName(id: number): string {
  return hostById(id)?.name ?? `#${id}`
}

function openEditor(s?: Snippet) {
  editing.value = s ?? null
  editorOpen.value = true
}

function onSaved() {
  editorOpen.value = false
  draggable.value = [...snippets.value]
}

async function onDragEnd() {
  const ids = draggable.value.map((s) => s.id)
  try {
    await reorderSnippets(ids)
  } catch (err) {
    // Restore the server's order: leaving the list in the dragged order would
    // silently disagree with what the next load returns.
    showToast(err instanceof Error ? err.message : String(err), 'error')
    await loadSnippets(true)
    draggable.value = [...snippets.value]
  }
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
    draggable.value = draggable.value.filter((x) => x.id !== s.id)
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
  }
}
</script>

<style scoped>
.drag-handle {
  flex-shrink: 0;
  width: 16px;
  color: var(--text-hint);
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.scope-chip {
  flex-shrink: 0;
  padding: 0 var(--space-3);
  border-radius: var(--radius-xs);
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-size: var(--font-size-2xs);
  line-height: 16px;
  white-space: nowrap;
}
</style>
