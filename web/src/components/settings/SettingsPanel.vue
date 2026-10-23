<template>
  <div class="panel">
    <div class="panel-scroll">
      <section class="settings-section">
        <h2 class="settings-heading">{{ t('settings.appearance') }}</h2>

        <div class="settings-row" @click="themeOpen = true">
          <span class="settings-label">{{ t('settings.theme') }}</span>
          <span class="settings-value">
            {{ themeLabel }}
            <ChevronRightIcon :size="14" class="chevron" />
          </span>
        </div>

        <div class="settings-row">
          <span class="settings-label">{{ t('settings.language') }}</span>
          <select
            class="settings-select"
            :value="settings.language"
            @change="onLanguageChange(($event.target as HTMLSelectElement).value)"
          >
            <option value="auto">{{ t('settings.languageAuto') }}</option>
            <option value="zh">{{ t('settings.languageZh') }}</option>
            <option value="en">{{ t('settings.languageEn') }}</option>
          </select>
        </div>
      </section>

      <section class="settings-section">
        <h2 class="settings-heading">{{ t('settings.terminal') }}</h2>

        <div class="settings-row">
          <span class="settings-label">{{ t('settings.fontSize') }}</span>
          <span class="stepper">
            <button class="stepper-btn" :disabled="settings.terminalFontSize <= 9" @click="stepFont(-1)">−</button>
            <span class="stepper-value">{{ settings.terminalFontSize }}</span>
            <button class="stepper-btn" :disabled="settings.terminalFontSize >= 22" @click="stepFont(1)">+</button>
          </span>
        </div>

        <div class="settings-row">
          <span class="settings-label">{{ t('settings.fontFamily') }}</span>
          <select
            class="settings-select"
            :value="settings.terminalFont"
            @change="setSetting('terminalFont', ($event.target as HTMLSelectElement).value)"
          >
            <option value="default">Default</option>
            <option value="jetbrains">JetBrains Mono</option>
            <option value="firacode">Fira Code</option>
            <option value="cascadia">Cascadia Code</option>
            <option value="sourcecode">Source Code Pro</option>
            <option value="ibmplex">IBM Plex Mono</option>
          </select>
        </div>

        <div class="settings-row" @click="paletteOpen = true">
          <span class="settings-label">{{ t('settings.terminalTheme') }}</span>
          <span class="settings-value">
            {{ paletteLabel }}
            <ChevronRightIcon :size="14" class="chevron" />
          </span>
        </div>

        <div class="settings-row">
          <span class="settings-label">{{ t('settings.cursorBlink') }}</span>
          <label class="switch">
            <input :checked="settings.cursorBlink" type="checkbox" @change="setSetting('cursorBlink', ($event.target as HTMLInputElement).checked)" />
            <span class="switch-track" />
            <span class="switch-thumb" />
          </label>
        </div>

        <div class="settings-row">
          <div class="settings-label-block">
            <span class="settings-label">{{ t('settings.copyOnSelect') }}</span>
            <span class="settings-sub">{{ t('settings.copyOnSelectHint') }}</span>
          </div>
          <label class="switch">
            <input :checked="settings.copyOnSelect" type="checkbox" @change="setSetting('copyOnSelect', ($event.target as HTMLInputElement).checked)" />
            <span class="switch-track" />
            <span class="switch-thumb" />
          </label>
        </div>

        <div class="settings-row">
          <div class="settings-label-block">
            <span class="settings-label">{{ t('settings.showKeyBar') }}</span>
            <span class="settings-sub">{{ t('settings.showKeyBarHint') }}</span>
          </div>
          <label class="switch">
            <input :checked="settings.showKeyBar" type="checkbox" @change="setSetting('showKeyBar', ($event.target as HTMLInputElement).checked)" />
            <span class="switch-track" />
            <span class="switch-thumb" />
          </label>
        </div>
      </section>

      <section class="settings-section">
        <h2 class="settings-heading">{{ t('settings.behaviour') }}</h2>

        <div class="settings-row">
          <span class="settings-label">{{ t('settings.haptic') }}</span>
          <label class="switch">
            <input :checked="settings.haptic" type="checkbox" @change="setSetting('haptic', ($event.target as HTMLInputElement).checked)" />
            <span class="switch-track" />
            <span class="switch-thumb" />
          </label>
        </div>

        <div class="settings-row">
          <span class="settings-label">{{ t('settings.confirmClose') }}</span>
          <label class="switch">
            <input :checked="settings.confirmClose" type="checkbox" @change="setSetting('confirmClose', ($event.target as HTMLInputElement).checked)" />
            <span class="switch-track" />
            <span class="switch-thumb" />
          </label>
        </div>
      </section>

      <section class="settings-section">
        <h2 class="settings-heading">{{ t('settings.security') }}</h2>

        <div class="settings-row" @click="passwordOpen = true">
          <div class="settings-label-block">
            <span class="settings-label">{{ t('settings.changePassword') }}</span>
            <span class="settings-sub">{{ t('settings.changePasswordHint') }}</span>
          </div>
          <ChevronRightIcon :size="14" class="chevron" />
        </div>

        <div class="settings-row danger" @click="signOut">
          <span class="settings-label">{{ t('settings.logout') }}</span>
          <LogOutIcon :size="14" class="chevron" />
        </div>
      </section>

      <section class="settings-section">
        <h2 class="settings-heading">{{ t('settings.about') }}</h2>

        <div class="settings-row">
          <span class="settings-label">{{ t('settings.version') }}</span>
          <span class="settings-value">{{ version }}</span>
        </div>

        <div class="settings-row">
          <span class="settings-label">{{ t('settings.sessionCount') }}</span>
          <span class="settings-value">{{ tabCount }}</span>
        </div>

        <div class="settings-row" @click="reset">
          <span class="settings-label">{{ t('settings.reset') }}</span>
        </div>

        <p class="settings-about">{{ t('settings.aboutText') }}</p>
      </section>
    </div>

    <ThemeSheet :open="themeOpen" @close="themeOpen = false" />
    <TerminalThemeSheet :open="paletteOpen" @close="paletteOpen = false" />
    <ChangePasswordModal :open="passwordOpen" @close="passwordOpen = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight as ChevronRightIcon, LogOut as LogOutIcon } from 'lucide-vue-next'
import ThemeSheet from '@/components/common/ThemeSheet.vue'
import ChangePasswordModal from './ChangePasswordModal.vue'
import TerminalThemeSheet from '@/components/terminal/TerminalThemeSheet.vue'
import { settings, setSetting, resetSettings } from '@/composables/useSettings'
import { setLocale } from '@/i18n'
import { themeMeta } from '@/utils/themeMeta'
import { confirmDialog, showToast } from '@/composables/useUi'
import { useAuth } from '@/composables/useAuth'
import { tabCount } from '@/composables/useTerminalTabs'
import { apiGet } from '@/utils/api'

const { t } = useI18n()
const { logout, status } = useAuth()

const themeOpen = ref(false)
const paletteOpen = ref(false)
const passwordOpen = ref(false)
const version = ref('')

/**
 * The palette's display name.
 *
 * 'auto' has its own label; a bundled scheme is shown by its prettified id
 * (`Solarized_Light` → `Solarized Light`), matching the picker rows so the
 * settings row and the menu agree.
 */
const paletteLabel = computed(() => {
  const id = settings.terminalTheme
  if (id === 'auto') return t('settings.terminalThemeAuto')
  return id
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
})

const themeLabel = computed(() => {
  if (settings.theme === 'auto') return t('settings.themeAuto')
  const meta = themeMeta(settings.theme)
  return meta ? t(meta.labelKey) : settings.theme
})

onMounted(async () => {
  if (status.value?.version) {
    version.value = status.value.version
    return
  }
  try {
    const sys = await apiGet<{ version: string }>('/api/system')
    version.value = sys.version
  } catch {
    version.value = '—'
  }
})

function onLanguageChange(v: string) {
  setSetting('language', v as 'auto' | 'zh' | 'en')
  setLocale(v as 'auto' | 'zh' | 'en')
}

function stepFont(delta: number) {
  const next = Math.min(22, Math.max(9, settings.terminalFontSize + delta))
  setSetting('terminalFontSize', next)
}

async function reset() {
  const ok = await confirmDialog({
    title: t('settings.reset'),
    message: t('settings.resetConfirm'),
    confirmLabel: t('settings.reset'),
  })
  if (!ok) return
  resetSettings()
  showToast(t('settings.resetDone'), 'success')
}

async function signOut() {
  const ok = await confirmDialog({
    title: t('settings.logout'),
    message: t('settings.logoutConfirm'),
    confirmLabel: t('settings.logout'),
  })
  if (!ok) return
  await logout()
}
</script>

<style scoped>
.settings-section {
  padding: var(--space-4) 0 var(--space-6);
  border-bottom: 1px solid var(--border-color);
}

.settings-section:last-child {
  border-bottom: none;
}

.settings-heading {
  padding: var(--space-3) var(--space-6) var(--space-2);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--text-muted);
}

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  min-height: 44px;
  padding: var(--space-2) var(--space-6);
  cursor: default;
}

.settings-row:has(.chevron) {
  cursor: pointer;
}

.settings-row:has(.chevron):active {
  background: var(--bg-secondary);
}

.settings-label-block {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.settings-label {
  font-size: var(--font-size-md);
  color: var(--text-primary);
}

.settings-sub {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: var(--line-height-snug);
}

.settings-value {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-md);
  color: var(--text-muted);
}

.settings-row.danger .settings-label,
.settings-row.danger .chevron {
  color: var(--color-red);
}

.chevron {
  color: var(--text-hint);
}

.settings-select {
  max-width: 60%;
  height: 30px;
  padding: 0 var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: var(--font-size-md);
  font-family: inherit;
  outline: none;
}

.stepper {
  display: flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.stepper-btn {
  width: 30px;
  height: 30px;
  border: none;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: var(--font-size-lg);
  cursor: pointer;
}

.stepper-btn:disabled {
  opacity: var(--opacity-disabled);
  cursor: default;
}

.stepper-value {
  min-width: 34px;
  text-align: center;
  font-size: var(--font-size-md);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.settings-about {
  padding: var(--space-3) var(--space-6);
  font-size: var(--font-size-xs);
  line-height: var(--line-height-relaxed);
  color: var(--text-muted);
}
</style>
