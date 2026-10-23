<template>
  <ModalDialog :open="confirm.visible" :title="confirm.title" @close="resolveConfirm(false)">
    <p class="confirm-message">{{ confirm.message }}</p>
    <template #footer>
      <button class="fbtn" @click="resolveConfirm(false)">{{ confirm.cancelLabel || t('common.cancel') }}</button>
      <button class="fbtn fbtn-primary" :class="{ 'fbtn-danger': confirm.danger }" @click="resolveConfirm(true)">
        {{ confirm.confirmLabel || t('common.confirm') }}
      </button>
    </template>
  </ModalDialog>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ModalDialog from './ModalDialog.vue'
import { useConfirm } from '@/composables/useUi'

const { t } = useI18n()
const { confirm, resolveConfirm } = useConfirm()
</script>

<style scoped>
.confirm-message {
  font-size: var(--font-size-md);
  line-height: var(--line-height-relaxed);
  color: var(--text-secondary);
  white-space: pre-wrap;
}
</style>
