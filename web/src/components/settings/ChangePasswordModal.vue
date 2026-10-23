<template>
  <ModalDialog :open="open" :title="t('settings.changePassword')" @close="emit('close')">
    <form class="form" @submit.prevent="save">
      <div class="form-row">
        <label class="form-label">{{ t('settings.newPassword') }}</label>
        <input v-model="password" class="form-input" type="password" autocomplete="new-password" data-field="new-password" />
      </div>
      <div class="form-row">
        <label class="form-label">{{ t('login.confirmPassword') }}</label>
        <input v-model="confirm" class="form-input" type="password" autocomplete="new-password" data-field="confirm-password" />
      </div>
      <p v-if="error" class="form-error">{{ error }}</p>
    </form>

    <template #footer>
      <button class="fbtn" type="button" @click="emit('close')">{{ t('common.cancel') }}</button>
      <button class="fbtn fbtn-primary" type="button" :disabled="saving" @click="save">{{ t('common.save') }}</button>
    </template>
  </ModalDialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ModalDialog from '@/components/common/ModalDialog.vue'
import { useAuth } from '@/composables/useAuth'
import { showToast } from '@/composables/useUi'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const { login } = useAuth()

const password = ref('')
const confirm = ref('')
const error = ref('')
const saving = ref(false)

watch(() => props.open, (v) => {
  if (v) {
    password.value = ''
    confirm.value = ''
    error.value = ''
  }
})

async function save() {
  error.value = ''
  if (password.value.length < 4) {
    error.value = t('login.tooShort')
    return
  }
  if (password.value !== confirm.value) {
    error.value = t('login.mismatch')
    return
  }
  saving.value = true
  try {
    // `set: true` is the change-password form of the login endpoint; the server
    // requires an authenticated session for it.
    await login(password.value, true)
    showToast(t('settings.passwordChanged'), 'success')
    emit('close')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>
