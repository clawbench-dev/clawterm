<template>
  <Teleport to="body">
    <div
      v-if="everOpened"
      v-show="open || leaving"
      ref="overlayRef"
      class="bs-overlay"
      :class="{ 'bs-leaving': leaving, 'bs-instant': instant, 'bs-overlay-wide-auto': isWideScreen }"
      :style="{ '--bs-open-order': openOrder }"
      tabindex="-1"
      @click.self="handleClose"
      @keydown.escape="handleClose"
    >
      <div
        class="bs-panel"
        :class="[
          { 'bs-leaving': leaving, 'bs-instant': instant, 'bs-auto': auto, 'bs-wide-auto': isWideScreen, 'bs-maximized': maximized },
          panelClass,
        ]"
      >
        <div v-if="!noHeader" class="bs-header" :class="{ 'bs-header-has-close': isWideScreen }">
          <div class="bs-handle" />
          <slot name="header">
            <span class="bs-title">{{ title }}</span>
          </slot>
          <!-- The close button only exists in centered-card (wide) mode: on a
               phone the sheet closes via the handle or the scrim, and a floating
               X on top of a bottom sheet is redundant chrome. -->
          <button
            v-if="isWideScreen"
            type="button"
            class="modal-close-btn"
            :aria-label="t('common.close')"
            :title="t('common.close')"
            @click.stop="handleClose"
          >
            <X :size="16" />
          </button>
        </div>

        <div class="bs-body">
          <slot />
        </div>

        <footer v-if="$slots.footer || isWideScreen" class="bs-footer">
          <slot name="footer" />
        </footer>
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
import { registerBackHandler, PRIORITY_OVERLAY, nextDrawerId, pushDrawer, removeDrawer, drawerZOffset } from '@/composables/useUi'
import { useWideScreen } from '@/composables/useUi'

const props = withDefaults(defineProps<{
  open: boolean
  title?: string
  /** No animation on close (used when the opener unmounts immediately). */
  instant?: boolean
  /** Height follows the content instead of filling the screen. */
  auto?: boolean
  noHeader?: boolean
  /** Fill the available height rather than sizing to content. */
  maximized?: boolean
  /** Extra classes on the panel. */
  panelClass?: string
}>(), {
  title: '',
  instant: false,
  auto: false,
  noHeader: false,
  maximized: false,
  panelClass: '',
})

const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const { isWideScreen } = useWideScreen()

// Open-order stacking: every sheet teleports to <body> at the same z-tier, so
// the browser orders them by DOM position — fixed at MOUNT time. A sheet
// mounted early but opened later would paint under the one that opened it.
const seq = nextDrawerId()
const openOrder = drawerZOffset(seq)

const leaving = ref(false)
const everOpened = ref(false)
const overlayRef = ref<HTMLElement | null>(null)
let leaveTimer: ReturnType<typeof setTimeout> | null = null
let unregisterBack: (() => void) | null = null

const LEAVE_MS = 200

function handleClose() {
  if (leaving.value) return
  if (props.instant) {
    emit('close')
    return
  }
  leaving.value = true
  leaveTimer = setTimeout(() => {
    leaving.value = false
    emit('close')
  }, LEAVE_MS)
}

function cancelLeave() {
  if (leaveTimer) {
    clearTimeout(leaveTimer)
    leaveTimer = null
  }
  leaving.value = false
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      everOpened.value = true
      cancelLeave()
      pushDrawer(seq)
      unregisterBack = registerBackHandler({
        id: `bottomsheet-${seq}`,
        canGoBack: () => props.open && !leaving.value,
        goBack: () => handleClose(),
        priority: PRIORITY_OVERLAY,
      })
      // Focus the scrim so Escape works without the user tabbing into it.
      requestAnimationFrame(() => overlayRef.value?.focus())
    } else {
      removeDrawer(seq)
      unregisterBack?.()
      unregisterBack = null
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  cancelLeave()
  removeDrawer(seq)
  unregisterBack?.()
})
</script>

<style scoped>
/* Bottom-sheet shell. The wide-screen (centered card) variant is supplied by
   assets/modal-card.css, which ModalDialog shares, so both read identically on
   a tablet and a phone. */
.bs-overlay {
  position: fixed;
  inset: 0;
  /* 1000..1040 band: a sheet opened from inside another must paint above it.
     --z-overlay-raised (1050) stays clear for upgrade prompts. */
  z-index: calc(var(--z-overlay) + var(--bs-open-order, 0));
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  outline: none;
  animation: bs-fade-in 0.18s ease;
}

.bs-overlay.bs-leaving {
  animation: bs-fade-out 0.2s ease forwards;
}

.bs-panel {
  width: 100%;
  max-height: 88vh;
  background: var(--bg-secondary);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  animation: bs-slide-up 0.26s cubic-bezier(0.16, 1, 0.3, 1);
}

.bs-panel.bs-maximized {
  height: 88vh;
}

.bs-panel.bs-leaving {
  animation: bs-slide-down 0.2s ease forwards;
}

.bs-panel.bs-auto {
  max-height: 88vh;
}

.bs-header {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-6) var(--space-4);
  border-bottom: 1px solid var(--border-color);
  min-height: 42px;
}

/* Drag affordance. Purely decorative here (the sheet closes via the scrim,
   the handle tap or back), which keeps the drag logic out of the way of the
   content's own scrolling. */
.bs-handle {
  position: absolute;
  top: 6px;
  left: 50%;
  transform: translateX(-50%);
  width: 34px;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--border-color);
}

.bs-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bs-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.bs-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-6);
  padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border-color);
}

/* Collapse the footer to a hairline when it has no element content (a slot
   whose own v-if is false), instead of leaving an empty bar. */
.bs-footer:not(:has(> *)) {
  padding: 0;
  border-top: none;
  height: var(--space-2);
}

@keyframes bs-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes bs-fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}

@keyframes bs-slide-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

@keyframes bs-slide-down {
  from { transform: translateY(0); }
  to { transform: translateY(100%); }
}
</style>
