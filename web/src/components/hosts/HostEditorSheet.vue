<template>
  <BottomSheet :open="open" :title="isEdit ? t('hosts.editHost') : t('hosts.addHost')" maximized @close="emit('close')">
    <form class="form" @submit.prevent="save">
      <div class="form-row">
        <label class="form-label">{{ t('hosts.name') }}</label>
        <input v-model="form.name" class="form-input" :class="{ invalid: errors.name }" :placeholder="t('hosts.namePlaceholder')" data-field="host-name" />
        <span v-if="errors.name" class="form-error">{{ errors.name }}</span>
      </div>

      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">{{ t('hosts.address') }}</label>
          <input v-model="form.address" class="form-input" :class="{ invalid: errors.address }" :placeholder="t('hosts.addressPlaceholder')" autocapitalize="none" autocorrect="off" spellcheck="false" data-field="host-address" />
          <span v-if="errors.address" class="form-error">{{ errors.address }}</span>
        </div>
        <div class="form-row">
          <label class="form-label">{{ t('hosts.port') }}</label>
          <input v-model.number="form.port" class="form-input" :class="{ invalid: errors.port }" type="number" inputmode="numeric" min="1" max="65535" data-field="host-port" />
          <span v-if="errors.port" class="form-error">{{ errors.port }}</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label">{{ t('hosts.username') }}</label>
        <input v-model="form.username" class="form-input" :class="{ invalid: errors.username }" autocapitalize="none" autocorrect="off" spellcheck="false" data-field="host-user" />
        <span v-if="errors.username" class="form-error">{{ errors.username }}</span>
      </div>

      <div class="form-row">
        <label class="form-label">{{ t('hosts.authType') }}</label>
        <div class="segmented" role="tablist">
          <button type="button" :class="{ active: form.authType === 'password' }" @click="form.authType = 'password'">
            {{ t('hosts.authPassword') }}
          </button>
          <button type="button" :class="{ active: form.authType === 'key' }" @click="form.authType = 'key'">
            {{ t('hosts.authKey') }}
          </button>
          <button type="button" :class="{ active: form.authType === 'agent' }" @click="form.authType = 'agent'">
            {{ t('hosts.authAgent') }}
          </button>
        </div>
      </div>

      <template v-if="form.authType === 'password'">
        <div class="form-row">
          <label class="form-label">{{ t('hosts.password') }}</label>
          <input
            v-model="form.password"
            class="form-input"
            type="password"
            autocomplete="new-password"
            :placeholder="host?.hasPassword ? t('hosts.passwordKeep') : t('hosts.passwordPlaceholder')"
            data-field="host-password"
          />
          <span class="form-hint">{{ t('hosts.passwordKeep') }}</span>
        </div>
      </template>

      <template v-else-if="form.authType === 'key'">
        <div class="form-row">
          <label class="form-label">{{ t('hosts.keyPath') }}</label>
          <input v-model="form.keyPath" class="form-input" :class="{ invalid: errors.keyPath }" :placeholder="t('hosts.keyPathPlaceholder')" autocapitalize="none" autocorrect="off" spellcheck="false" data-field="host-key-path" />
          <span v-if="errors.keyPath" class="form-error">{{ errors.keyPath }}</span>
          <span v-else class="form-hint">{{ t('hosts.keyPathHint') }}</span>
        </div>
        <div class="form-row">
          <label class="form-label">{{ t('hosts.passphrase') }}</label>
          <input
            v-model="form.passphrase"
            class="form-input"
            type="password"
            autocomplete="new-password"
            :placeholder="host?.hasPassphrase ? t('hosts.passwordKeep') : t('hosts.passphrasePlaceholder')"
          />
        </div>
      </template>

      <p v-else class="form-hint">
        SSH_AUTH_SOCK
      </p>

      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">{{ t('hosts.group') }}</label>
          <input v-model="form.group" class="form-input" :placeholder="t('hosts.groupPlaceholder')" />
        </div>
        <div class="form-row">
          <label class="form-label">{{ t('hosts.color') }}</label>
          <div class="color-row">
            <button
              v-for="c in COLORS"
              :key="c"
              type="button"
              class="color-dot"
              :class="{ active: form.color === c }"
              :style="{ background: c }"
              :aria-label="c"
              @click="form.color = form.color === c ? '' : c"
            />
            <button v-if="form.color" type="button" class="color-clear" @click="form.color = ''">
              <XIcon :size="12" />
            </button>
          </div>
        </div>
      </div>

      <p v-if="saveError" class="form-error">{{ saveError }}</p>
    </form>

    <template #footer>
      <button class="fbtn" type="button" @click="emit('close')">{{ t('common.cancel') }}</button>
      <button class="fbtn fbtn-primary" type="button" :disabled="saving" @click="save">
        <LoadingIndicator v-if="saving" size="sm" inline />
        <span>{{ t('common.save') }}</span>
      </button>
    </template>
  </BottomSheet>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X as XIcon } from 'lucide-vue-next'
import BottomSheet from '@/components/common/BottomSheet.vue'
import LoadingIndicator from '@/components/common/LoadingIndicator.vue'
import { createHost, updateHost, type Host, type HostPayload } from '@/composables/useHosts'

const props = defineProps<{
  open: boolean
  host: Host | null
  prefill: Host | null
}>()

const emit = defineEmits<{ close: []; saved: [h: Host] }>()
const { t } = useI18n()

const isEdit = computed(() => props.host !== null)
const saving = ref(false)
const saveError = ref('')

const COLORS = [
  '#e05d44', '#e8a33d', '#d8c02a', '#4caf50',
  '#2fa4a0', '#3b82f6', '#8b5cf6', '#ec4899',
]

function emptyForm(): HostPayload {
  return {
    name: '',
    address: '',
    port: 22,
    username: '',
    authType: 'password',
    keyPath: '',
    password: '',
    passphrase: '',
    color: '',
    group: '',
  }
}

const form = reactive<HostPayload>(emptyForm())
const errors = reactive<Record<string, string>>({})

/**
 * Reset the form when the sheet opens.
 *
 * The password fields always start EMPTY, even when editing: the server never
 * sends the stored secret back, so there is nothing to prefill — and leaving
 * the field blank is how the UI says "keep the current password".
 */
watch(
  () => [props.open, props.host, props.prefill] as const,
  ([open, host, prefill]) => {
    if (!open) return
    saveError.value = ''
    for (const k of Object.keys(errors)) delete errors[k]
    const src = host ?? prefill
    if (src) {
      Object.assign(form, {
        name: src.name,
        address: src.address,
        port: src.port,
        username: src.username,
        authType: src.authType,
        keyPath: src.keyPath,
        password: '',
        passphrase: '',
        color: src.color,
        group: src.group,
      })
    } else {
      Object.assign(form, emptyForm())
    }
  },
  { immediate: true },
)

function validate(): boolean {
  for (const k of Object.keys(errors)) delete errors[k]
  if (!form.name.trim()) errors.name = t('hosts.required')
  if (!form.address.trim()) errors.address = t('hosts.required')
  if (!form.username.trim()) errors.username = t('hosts.required')
  if (!form.port || form.port < 1 || form.port > 65535) errors.port = t('hosts.portInvalid')
  if (form.authType === 'key' && !form.keyPath.trim()) errors.keyPath = t('hosts.required')
  return Object.keys(errors).length === 0
}

async function save() {
  if (saving.value) return
  if (!validate()) return
  saving.value = true
  saveError.value = ''
  try {
    const payload: HostPayload = {
      ...form,
      name: form.name.trim(),
      address: form.address.trim(),
      username: form.username.trim(),
      keyPath: form.keyPath.trim(),
      group: form.group.trim(),
    }
    const saved = props.host
      ? await updateHost(props.host.id, payload)
      : await createHost(payload)
    emit('saved', saved)
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.color-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  min-height: 38px;
}

.color-dot {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  transition: transform var(--duration-fast);
}

.color-dot.active {
  border-color: var(--text-primary);
  transform: scale(1.08);
}

.color-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--border-color);
  border-radius: 50%;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
</style>
