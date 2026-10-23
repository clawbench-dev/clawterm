<template>
  <BottomSheet :open="open" :title="t('settings.theme')" maximized @close="emit('close')">
    <div class="theme-list">
      <button
        class="theme-item"
        :class="{ active: settings.theme === 'auto' }"
        @click="choose('auto')"
      >
        <span class="theme-swatch theme-swatch--auto" />
        <span class="theme-item-name">{{ t('settings.themeAuto') }}</span>
        <SunMoonIcon :size="12" class="theme-item-base-icon" />
      </button>
      <button
        v-for="th in THEMES"
        :key="th.id"
        class="theme-item"
        :class="{ active: settings.theme === th.id }"
        :style="{
          '--tterm-preview-bg': th.preview.bg,
          '--tterm-preview-accent': th.preview.accent,
        }"
        @click="choose(th.id)"
      >
        <span class="theme-swatch" />
        <span class="theme-item-name">{{ t(th.labelKey) }}</span>
        <component :is="th.dark ? Moon : Sun" :size="12" class="theme-item-base-icon" />
      </button>
    </div>
  </BottomSheet>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Moon, Sun, SunMoon as SunMoonIcon } from 'lucide-vue-next'
import BottomSheet from './BottomSheet.vue'
// Row language for the picker; global because the rows are shared with any
// other theme picker surface.
import '@/assets/theme-picker.css'
import { THEMES } from '@/utils/themeMeta'
import { settings, setSetting } from '@/composables/useSettings'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

function choose(id: string) {
  setSetting('theme', id)
}
</script>

<style scoped>
.theme-list {
  padding: var(--space-2) 0 var(--space-6);
}

/* Row language comes from assets/theme-picker.css (shared with the header
   picker). Only the list container is local. */
</style>
