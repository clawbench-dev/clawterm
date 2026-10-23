<template>
  <BottomSheet :open="open" :title="t('settings.terminalTheme')" maximized @close="emit('close')">
    <div class="tt-list">
      <!-- Auto first: it is the default and the only entry that follows the app
           theme, so it must not be buried in a 157-item list. -->
      <button
        class="tt-item"
        :class="{ active: settings.terminalTheme === 'auto' }"
        data-theme-id="auto"
        @click="choose('auto')"
      >
        <span class="tt-swatch tt-swatch-auto" />
        <span class="tt-name">{{ t('settings.terminalThemeAuto') }}</span>
      </button>

      <button
        v-for="id in SORTED_TERMINAL_THEME_IDS"
        :key="id"
        class="tt-item"
        :class="{ active: settings.terminalTheme === id }"
        :data-theme-id="id"
        @click="choose(id)"
      >
        <span
          class="tt-swatch"
          :style="{ background: TERMINAL_THEME_BACKGROUNDS[id] || 'var(--bg-tertiary)' }"
        />
        <span class="tt-name">{{ prettyName(id) }}</span>
        <span class="tt-preview">
          <span class="tt-dot" :style="{ background: paletteAccent(id, 'red') }" />
          <span class="tt-dot" :style="{ background: paletteAccent(id, 'green') }" />
          <span class="tt-dot" :style="{ background: paletteAccent(id, 'blue') }" />
        </span>
      </button>
    </div>
  </BottomSheet>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ITheme } from '@xterm/xterm'
import BottomSheet from '@/components/common/BottomSheet.vue'
import { settings, setSetting } from '@/composables/useSettings'
import {
  SORTED_TERMINAL_THEME_IDS,
  TERMINAL_THEME_BACKGROUNDS,
  loadTerminalThemes,
} from '@/utils/terminalThemes'
import { appLog } from '@/utils/appLog'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const palettes = ref<Record<string, ITheme> | null>(null)

onMounted(async () => {
  // The palette module is a lazy chunk; loading it here keeps the main bundle
  // free of 157 colour tables nobody may ever look at.
  try {
    palettes.value = await loadTerminalThemes()
  } catch (err) {
    appLog.w('TerminalTheme', 'palette load failed', String(err))
  }
})

/**
 * Palette swatches.
 *
 * The dots read from the loaded palette so the row previews the scheme's actual
 * ANSI colours rather than a generic red/green/blue. Before the chunk lands (or
 * if it fails) they fall back to the theme's own background, which still gives
 * each row a distinct, honest look.
 */
function paletteAccent(id: string, slot: 'red' | 'green' | 'blue'): string {
  const p = palettes.value?.[id]
  return p?.[slot] ?? TERMINAL_THEME_BACKGROUNDS[id] ?? 'var(--text-hint)'
}

/** `OneHalfDark` → `One Half Dark`; underscores become spaces. */
function prettyName(id: string): string {
  return id
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
}

function choose(id: string) {
  setSetting('terminalTheme', id)
}
</script>

<style scoped>
.tt-list {
  padding-bottom: var(--space-6);
}

.tt-item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
  padding: var(--space-3) var(--space-6);
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-md);
  text-align: left;
  cursor: pointer;
  position: relative;
}

.tt-item + .tt-item {
  border-top: 1px solid color-mix(in srgb, var(--border-color) 40%, transparent);
}

.tt-item:active {
  background: var(--bg-secondary);
}

@media (hover: hover) {
  .tt-item:hover {
    background: var(--bg-secondary);
  }
}

/* Selection is a 2px accent rail plus a tint — the same language the app theme
   picker uses, so the two menus read as one control. */
.tt-item.active {
  background: color-mix(in srgb, var(--accent-color) 10%, transparent);
}

.tt-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--accent-color);
}

.tt-swatch {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 25%, transparent);
}

/* Auto follows the app theme: a split disc reads as "either one". */
.tt-swatch-auto {
  background: linear-gradient(135deg, var(--bg-primary) 0 48%, var(--text-primary) 52% 100%);
}

.tt-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tt-item.active .tt-name {
  font-weight: var(--font-weight-semibold);
}

.tt-preview {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 3px;
}

.tt-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
}
</style>
