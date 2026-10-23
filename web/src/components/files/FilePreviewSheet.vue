<template>
  <BottomSheet :open="open" :title="baseName" maximized @close="emit('close')">
    <div v-if="loading" class="preview-loading">
      <LoadingIndicator :label="t('common.loading')" />
    </div>

    <div v-else-if="error" class="preview-error">
      <p class="empty-title">{{ t('common.error') }}</p>
      <p class="empty-hint">{{ error }}</p>
      <button class="empty-action" @click="load">{{ t('common.retry') }}</button>
    </div>

    <template v-else-if="content">
      <div v-if="!isText" class="preview-binary">
        <FileIcon :size="34" class="empty-icon" />
        <p class="empty-title">{{ t('files.binary') }}</p>
        <button class="empty-action" @click="download">
          <DownloadIcon :size="15" />
          <span>{{ t('files.download') }}</span>
        </button>
      </div>

      <template v-else>
        <div class="preview-meta">
          <span class="meta-size">{{ formatSize(content.size) }}</span>
          <span v-if="content.truncated" class="meta-truncated">{{ t('files.truncated') }}</span>
        </div>
        <!-- Plain <pre>, not a highlighter: a preview must show the bytes as
             they are. Line numbers are rendered as a gutter so a long file stays
             scannable without a full editor. -->
        <div class="preview-code">
          <pre class="code-gutter" aria-hidden="true">{{ gutter }}</pre>
          <pre class="code-body">{{ content.content }}</pre>
        </div>
      </template>
    </template>

    <template #footer>
      <button class="fbtn" @click="emit('close')">{{ t('common.close') }}</button>
      <button class="fbtn fbtn-primary" @click="download">
        <DownloadIcon :size="14" />
        <span>{{ t('files.download') }}</span>
      </button>
    </template>
  </BottomSheet>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Download as DownloadIcon, File as FileIcon } from 'lucide-vue-next'
import BottomSheet from '@/components/common/BottomSheet.vue'
import LoadingIndicator from '@/components/common/LoadingIndicator.vue'
import { downloadUrl, formatSize, looksTextual, readFile, type FileContent } from '@/composables/useFiles'

const props = defineProps<{ open: boolean; hostId: number; path: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const loading = ref(false)
const error = ref('')
const content = ref<FileContent | null>(null)

const baseName = computed(() => props.path.split('/').filter(Boolean).pop() ?? props.path)

const isText = computed(() => {
  if (!content.value) return false
  return looksTextual(baseName.value, content.value.content)
})

/** Line-number gutter, computed from the visible text only. */
const gutter = computed(() => {
  const text = content.value?.content ?? ''
  // A trailing newline should not add a phantom last line number.
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n').length : text.split('\n').length
  const out: string[] = []
  for (let i = 1; i <= Math.max(lines, 1); i++) out.push(String(i))
  return out.join('\n')
})

async function load() {
  if (!props.open || !props.path) return
  loading.value = true
  error.value = ''
  content.value = null
  try {
    content.value = await readFile(props.hostId, props.path)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

watch(() => [props.open, props.path, props.hostId], () => {
  if (props.open) void load()
}, { immediate: true })

function download() {
  const a = document.createElement('a')
  a.href = downloadUrl(props.hostId, props.path)
  a.download = baseName.value
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
</script>

<style scoped>
.preview-loading,
.preview-error {
  padding: var(--space-8);
}

.preview-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  text-align: center;
}

.preview-binary {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-5);
  padding: var(--space-10) var(--space-8);
  text-align: center;
}

.preview-meta {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--border-color);
  font-size: var(--font-size-2xs);
  color: var(--text-muted);
}

.meta-truncated {
  color: var(--color-yellow);
}

.preview-code {
  display: flex;
  align-items: flex-start;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: 1.55;
  overflow-x: auto;
}

.code-gutter {
  flex-shrink: 0;
  padding: var(--space-4) var(--space-3);
  border-right: 1px solid var(--border-color);
  color: var(--text-hint);
  text-align: right;
  user-select: none;
  font-variant-numeric: tabular-nums;
  background: var(--bg-primary);
  position: sticky;
  left: 0;
}

.code-body {
  flex: 1;
  min-width: 0;
  padding: var(--space-4) var(--space-5);
  color: var(--text-primary);
  white-space: pre;
}
</style>
