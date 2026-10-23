<template>
  <ModalDialog :open="open" :title="isEdit ? t('snippets.edit') : t('snippets.add')" @close="emit('close')">
    <form class="form" @submit.prevent="save">
      <div class="form-row">
        <label class="form-label">{{ t('snippets.label') }}</label>
        <input v-model="form.label" class="form-input" :class="{ invalid: errors.label }" :placeholder="t('snippets.labelPlaceholder')" data-field="snippet-label" />
        <span v-if="errors.label" class="form-error">{{ errors.label }}</span>
      </div>

      <div class="form-row">
        <label class="form-label">{{ t('snippets.command') }}</label>
        <textarea
          v-model="form.command"
          class="form-textarea"
          :class="{ invalid: errors.command }"
          rows="3"
          :placeholder="t('snippets.commandPlaceholder')"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          data-field="snippet-command"
        />
        <span v-if="errors.command" class="form-error">{{ errors.command }}</span>
      </div>

      <div class="form-row">
        <label class="form-label">{{ t('snippets.hostScope') }}</label>
        <select v-model.number="form.hostId" class="form-select">
          <option :value="0">{{ t('snippets.hostScopeAll') }}</option>
          <option v-for="h in hosts" :key="h.id" :value="h.id">{{ h.name }}</option>
        </select>
      </div>

      <div class="form-row inline">
        <div>
          <div class="form-label">{{ t('snippets.sendNow') }}</div>
          <div class="form-hint">{{ t('snippets.sendNowHint') }}</div>
        </div>
        <label class="switch">
          <input v-model="form.send" type="checkbox" />
          <span class="switch-track" />
          <span class="switch-thumb" />
        </label>
      </div>

      <p v-if="saveError" class="form-error">{{ saveError }}</p>
    </form>

    <template #footer>
      <button class="fbtn" type="button" @click="emit('close')">{{ t('common.cancel') }}</button>
      <button class="fbtn fbtn-primary" type="button" :disabled="saving" @click="save">{{ t('common.save') }}</button>
    </template>
  </ModalDialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ModalDialog from '@/components/common/ModalDialog.vue'
import { hosts } from '@/composables/useHosts'
import { createSnippet, updateSnippet, type Snippet } from '@/composables/useSnippets'

const props = defineProps<{
  open: boolean
  snippet: Snippet | null
  /** Default scope when creating from a terminal. */
  hostId: number
}>()

const emit = defineEmits<{ close: []; saved: [] }>()
const { t } = useI18n()

const isEdit = computed(() => props.snippet !== null)
const saving = ref(false)
const saveError = ref('')
const errors = reactive<{ label?: string; command?: string }>({})

const form = reactive({ label: '', command: '', hostId: 0, send: true })

watch(
  () => [props.open, props.snippet, props.hostId] as const,
  ([open, sn, hostId]) => {
    if (!open) return
    saveError.value = ''
    delete errors.label
    delete errors.command
    if (sn) {
      Object.assign(form, { label: sn.label, command: sn.command, hostId: sn.hostId, send: sn.send })
    } else {
      // Default to the host the terminal is on: a snippet written while working
      // on one server is almost always about that server.
      Object.assign(form, { label: '', command: '', hostId: hostId || 0, send: true })
    }
  },
  { immediate: true },
)

async function save() {
  if (saving.value) return
  delete errors.label
  delete errors.command
  if (!form.label.trim()) errors.label = t('hosts.required')
  if (!form.command.trim()) errors.command = t('hosts.required')
  if (errors.label || errors.command) return

  saving.value = true
  saveError.value = ''
  try {
    const payload = {
      label: form.label.trim(),
      command: form.command,
      hostId: form.hostId,
      send: form.send,
    }
    if (props.snippet) await updateSnippet(props.snippet.id, payload)
    else await createSnippet(payload)
    emit('saved')
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>
