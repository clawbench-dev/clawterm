<template>
  <BottomSheet :open="open" :title="t('forwards.add')" auto @close="emit('close')">
    <form class="form" @submit.prevent="save">
      <div class="form-row">
        <label class="form-label">{{ t('forwards.host') }}</label>
        <select v-model.number="form.hostId" class="form-select" :class="{ invalid: errors.hostId }" data-field="forward-host">
          <option :value="0" disabled>{{ t('forwards.needHost') }}</option>
          <option v-for="h in hosts" :key="h.id" :value="h.id">{{ h.name }}</option>
        </select>
        <span v-if="errors.hostId" class="form-error">{{ errors.hostId }}</span>
      </div>

      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">{{ t('forwards.localPort') }}</label>
          <input v-model.number="form.localPort" class="form-input" :class="{ invalid: errors.localPort }" type="number" inputmode="numeric" min="1" max="65535" data-field="forward-local" />
          <span v-if="errors.localPort" class="form-error">{{ errors.localPort }}</span>
        </div>
        <div class="form-row">
          <label class="form-label">{{ t('forwards.remotePort') }}</label>
          <input v-model.number="form.remotePort" class="form-input" :class="{ invalid: errors.remotePort }" type="number" inputmode="numeric" min="1" max="65535" data-field="forward-remote" />
          <span v-if="errors.remotePort" class="form-error">{{ errors.remotePort }}</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label">{{ t('forwards.remoteHost') }}</label>
        <input v-model="form.remoteHost" class="form-input" placeholder="127.0.0.1" autocapitalize="none" autocorrect="off" spellcheck="false" data-field="forward-remote-host" />
        <span class="form-hint">{{ t('forwards.hint', { local: form.localPort || '…', remote: `${form.remoteHost || '127.0.0.1'}:${form.remotePort || '…'}` }) }}</span>
      </div>

      <div class="form-row inline">
        <div>
          <div class="form-label">{{ t('forwards.autoStart') }}</div>
        </div>
        <label class="switch">
          <input v-model="form.autoStart" type="checkbox" />
          <span class="switch-track" />
          <span class="switch-thumb" />
        </label>
      </div>

      <p v-if="saveError" class="form-error">{{ saveError }}</p>
    </form>

    <template #footer>
      <button class="fbtn" type="button" @click="emit('close')">{{ t('common.cancel') }}</button>
      <button class="fbtn fbtn-primary" type="button" :disabled="saving" @click="save">
        <LoadingIndicator v-if="saving" size="sm" inline />
        <span>{{ t('forwards.start') }}</span>
      </button>
    </template>
  </BottomSheet>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BottomSheet from '@/components/common/BottomSheet.vue'
import LoadingIndicator from '@/components/common/LoadingIndicator.vue'
import { hosts } from '@/composables/useHosts'
import { startForward } from '@/composables/useForwards'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const { t } = useI18n()

const saving = ref(false)
const saveError = ref('')
const errors = reactive<Record<string, string>>({})

const form = reactive({
  hostId: 0,
  localPort: 8080,
  remoteHost: '127.0.0.1',
  remotePort: 80,
  autoStart: false,
})

watch(() => props.open, (open) => {
  if (!open) return
  saveError.value = ''
  for (const k of Object.keys(errors)) delete errors[k]
  form.hostId = hosts.value[0]?.id ?? 0
})

function validate(): boolean {
  for (const k of Object.keys(errors)) delete errors[k]
  if (!form.hostId) errors.hostId = t('forwards.needHost')
  if (!form.localPort || form.localPort < 1 || form.localPort > 65535) errors.localPort = t('hosts.portInvalid')
  if (!form.remotePort || form.remotePort < 1 || form.remotePort > 65535) errors.remotePort = t('hosts.portInvalid')
  return Object.keys(errors).length === 0
}

async function save() {
  if (saving.value) return
  if (!validate()) return
  saving.value = true
  saveError.value = ''
  try {
    await startForward({
      hostId: form.hostId,
      localPort: form.localPort,
      remoteHost: form.remoteHost.trim() || '127.0.0.1',
      remotePort: form.remotePort,
      autoStart: form.autoStart,
    })
    emit('saved')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // A port conflict is the common case and deserves a clear sentence rather
    // than the raw bind error from the OS.
    saveError.value = /address already in use|已在使用/.test(msg) ? t('forwards.portInUse') : msg
  } finally {
    saving.value = false
  }
}
</script>
