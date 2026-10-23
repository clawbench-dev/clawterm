import { createI18n } from 'vue-i18n'
import zh from './locales/zh'
import en from './locales/en'
import { settings } from '@/composables/useSettings'

const STORAGE_KEY = 'clawterm-locale'

function detectLocale(): string {
  if (settings.language === 'zh' || settings.language === 'en') return settings.language
  const nav = (navigator.language || '').toLowerCase()
  return nav.startsWith('zh') ? 'zh' : 'en'
}

const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'zh',
  messages: { zh, en },
})

/** Switch language; 'auto' re-detects from the browser. */
export function setLocale(choice: 'auto' | 'zh' | 'en') {
  const lang = choice === 'auto'
    ? ((navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en')
    : choice
  i18n.global.locale.value = lang
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch { /* private mode */ }
  document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en')
}

document.documentElement.setAttribute('lang', i18n.global.locale.value === 'zh' ? 'zh-CN' : 'en')

export default i18n
