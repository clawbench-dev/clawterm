import { computed, reactive, ref, watch } from 'vue'
import { appLog } from '@/utils/appLog'
import { applyTheme, DARK_DEFAULT, DEFAULT_THEME, LIGHT_DEFAULT, resolveTheme } from '@/utils/themeMeta'

/**
 * User preferences. Everything here is per-device (localStorage), not per
 * account: they describe how this screen should look, and syncing them would
 * push a phone's font size onto a desktop.
 *
 * Keys are prefixed `clawterm-settings-` and stored as JSON so a number stays a
 * number. The theme key is also read by the inline bootstrap script in
 * index.html — that script runs before this module exists, and the two MUST
 * agree on the key name and the JSON encoding.
 */

const PREFIX = 'clawterm-settings-'

export interface Settings {
  theme: string
  /** UI language: 'auto' follows the browser. */
  language: 'auto' | 'zh' | 'en'
  /** Terminal font size in px. */
  terminalFontSize: number
  /** Terminal font family id (see utils/terminalFonts.ts). */
  terminalFont: string
  /** xterm theme name, or 'auto' to follow the app theme. */
  terminalTheme: string
  /** Copy the selection as soon as it is made (mobile-friendly default). */
  copyOnSelect: boolean
  /** Haptic feedback on key bar presses. */
  haptic: boolean
  /** Keep the screen awake while a terminal is in the foreground. */
  keepAwake: boolean
  /** Confirm before closing a tab with a running process. */
  confirmClose: boolean
  /** Show the quick-key toolbar above the keyboard. */
  showKeyBar: boolean
  /** Reverse video for the cursor. */
  cursorBlink: boolean
}

const DEFAULTS: Settings = {
  theme: DEFAULT_THEME,
  language: 'auto',
  terminalFontSize: 13,
  terminalFont: 'default',
  terminalTheme: 'auto',
  copyOnSelect: true,
  haptic: true,
  keepAwake: false,
  confirmClose: true,
  showKeyBar: true,
  cursorBlink: true,
}

function read<T>(key: keyof Settings, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) return fallback
    const v = JSON.parse(raw)
    return typeof v === typeof fallback ? (v as T) : fallback
  } catch {
    return fallback
  }
}

function load(): Settings {
  const out = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    // @ts-expect-error — the loop is type-safe by construction (each key reads
    // its own default), which TS cannot express for a heterogeneous record.
    out[key] = read(key, DEFAULTS[key])
  }
  return out
}

export const settings = reactive<Settings>(load())

/** Persist one key and run its side effect. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings[key] = value
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    appLog.w('Settings', `failed to persist ${key}`)
  }
}

/** Reset every preference to its default (used by the settings page). */
export function resetSettings() {
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    setSetting(key, DEFAULTS[key])
  }
}

// Apply the theme on load and whenever it changes. `applyTheme` is idempotent
// and cheap, so watching the whole object is simpler than tracking each key.
watch(
  () => settings.theme,
  (v) => applyTheme(v),
  { immediate: true },
)

/** The concrete theme id in effect (never 'auto'). */
export function effectiveTheme(): string {
  return resolveTheme(settings.theme)
}

/**
 * Reactive form of {@link effectiveTheme}.
 *
 * A plain function cannot be watched, so anything that must REACT to the theme
 * (the terminal palette, the status bar) needs this. It also tracks the system
 * preference, because `auto` has to re-resolve when the OS switches to dark
 * while the app is open.
 */
export const effectiveThemeRef = computed(() => {
  if (settings.theme !== 'auto') return settings.theme
  // `systemPrefersDark` is a ref updated by a media-query listener, so this
  // computed re-runs when the OS changes.
  return systemPrefersDark.value ? DARK_DEFAULT : LIGHT_DEFAULT
})

/**
 * The OS dark-mode preference.
 *
 * Subscribed once at module load: `matchMedia().matches` alone is a snapshot,
 * and a user who flips the system theme while the app is open would otherwise
 * keep the old palette until a reload.
 */
export const systemPrefersDark = ref(
  typeof window !== 'undefined'
    ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)
    : true,
)

if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = (e: MediaQueryListEvent) => { systemPrefersDark.value = e.matches }
  if (mq.addEventListener) mq.addEventListener('change', onChange)
  else mq.addListener?.(onChange)
}
