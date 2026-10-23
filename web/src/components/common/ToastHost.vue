<template>
  <Teleport to="body">
    <Transition name="toast">
      <div v-if="toast.visible" class="toast" :class="`toast-${toast.type}`" @click="dismissToast">
        <span class="toast-icon" aria-hidden="true">
          <component :is="icon" :size="15" />
        </span>
        <span class="toast-text">{{ toast.message }}</span>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Check, X, Info, Loader2 } from 'lucide-vue-next'
import { useToast } from '@/composables/useUi'

const { toast, dismissToast } = useToast()

const ICONS = { success: Check, error: X, info: Info, loading: Loader2 } as const
const icon = computed(() => ICONS[toast.value.type])
</script>

<style>
/* Global, not scoped: the toast teleports to <body>, which is fine for scoped
   rules (they follow the element), but the colour recipes below are shared with
   the same look the rest of the app uses for status surfaces, so keeping them
   global avoids a second copy if another surface needs them. */
.toast {
  position: fixed;
  top: calc(8px + var(--header-safe-area-top, 0px));
  left: 0;
  right: 0;
  margin: 0 auto;
  width: fit-content;
  min-width: 80px;
  max-width: 88vw;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 14px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--accent-color) 85%, var(--bg-tertiary));
  color: #fff;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  line-height: var(--line-height-snug);
  box-shadow: var(--shadow-md);
  z-index: var(--z-popover);
  cursor: pointer;
  text-align: left;
  /* Selectable so a long error message can be copied out. */
  user-select: text;
  -webkit-tap-highlight-color: transparent;
}

.toast-error {
  background: color-mix(in srgb, var(--color-red, #ef4444) 78%, var(--bg-tertiary));
}

.toast-success {
  background: color-mix(in srgb, var(--color-success, #22c55e) 78%, var(--bg-tertiary));
}

.toast-info,
.toast-loading {
  background: color-mix(in srgb, var(--color-info, var(--accent-color)) 78%, var(--bg-tertiary));
}

/* Dark themes: a saturated fill at 78% is too loud against a dark page, and
   white text on the light-theme mixes loses contrast. */
[data-theme-base="dark"] .toast {
  background: color-mix(in srgb, var(--accent-color) 40%, var(--bg-tertiary));
  color: var(--text-primary);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
}

[data-theme-base="dark"] .toast-error {
  background: color-mix(in srgb, var(--color-red, #ef4444) 55%, var(--bg-tertiary));
}

[data-theme-base="dark"] .toast-success {
  background: color-mix(in srgb, var(--color-success, #22c55e) 55%, var(--bg-tertiary));
}

[data-theme-base="dark"] .toast-info,
[data-theme-base="dark"] .toast-loading {
  background: color-mix(in srgb, var(--color-info, var(--accent-color)) 55%, var(--bg-tertiary));
}

.toast:active {
  opacity: var(--opacity-hover);
  transform: scale(0.97);
}

.toast-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.toast-loading .toast-icon svg {
  animation: toast-spin 0.9s linear infinite;
}

@keyframes toast-spin {
  to { transform: rotate(360deg); }
}

.toast-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: break-word;
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-12px);
}
</style>
