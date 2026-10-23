<template>
  <Teleport to="body">
    <div
      v-if="everOpened"
      v-show="open || leaving"
      ref="overlayRef"
      class="modal-overlay"
      :class="{ 'modal-leaving': leaving }"
      :style="{ zIndex }"
      tabindex="-1"
      @click.self="handleClose"
      @keydown.escape="handleClose"
    >
      <div class="modal-dialog" :class="{ 'modal-leaving': leaving, 'modal-full-height': fullHeight }" @click.stop>
        <div class="modal-header">
          <slot name="header">
            <span class="modal-title">{{ title }}</span>
          </slot>
          <button
            type="button"
            class="modal-close-btn"
            :aria-label="t('common.close')"
            :title="t('common.close')"
            @click.stop="handleClose"
          >
            <X :size="16" />
          </button>
        </div>
        <div class="modal-body">
          <slot />
        </div>
        <div class="modal-footer" :class="{ 'modal-footer-default': !$slots.footer }">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import '@/assets/modal-card.css'
import '@/assets/modal-footer-btn.css'
import { registerBackHandler, PRIORITY_OVERLAY } from '@/composables/useUi'

const props = withDefaults(defineProps<{
  open: boolean
  title?: string
  zIndex?: number
  fullHeight?: boolean
}>(), {
  title: '',
  zIndex: 2100,
  fullHeight: false,
})

const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const leaving = ref(false)
const everOpened = ref(false)
const overlayRef = ref<HTMLElement | null>(null)
let leaveTimer: ReturnType<typeof setTimeout> | null = null
let unregisterBack: (() => void) | null = null

function handleClose() {
  if (leaving.value) return
  leaving.value = true
  leaveTimer = setTimeout(() => {
    leaving.value = false
    emit('close')
  }, 200)
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      everOpened.value = true
      if (leaveTimer) {
        clearTimeout(leaveTimer)
        leaveTimer = null
      }
      leaving.value = false
      // PRIORITY_OVERLAY + 1: a dialog paints above every drawer, so a dialog
      // opened from inside a drawer must win the back press.
      unregisterBack = registerBackHandler({
        id: 'modal-dialog',
        canGoBack: () => props.open && !leaving.value,
        goBack: handleClose,
        priority: PRIORITY_OVERLAY + 1,
      })
      requestAnimationFrame(() => overlayRef.value?.focus())
    } else {
      unregisterBack?.()
      unregisterBack = null
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (leaveTimer) clearTimeout(leaveTimer)
  unregisterBack?.()
})
</script>

<style scoped>
/* Everything else (card geometry, scrim, animation) comes from
   assets/modal-card.css, shared with BottomSheet's wide mode. */
.modal-dialog {
  max-width: var(--modal-max-width, 560px);
}

.modal-full-height {
  height: 100%;
}

.modal-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
