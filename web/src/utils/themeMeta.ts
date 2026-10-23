import { appLog } from '@/utils/appLog'

/**
 * Theme registry — the single source of truth for the 36 named themes.
 *
 * The colours themselves live in `web/css/variables.css` as
 * `[data-theme="<id>"]` blocks. This file only carries what the *UI* needs to
 * render a picker row (label key, light/dark class, the three swatch colours,
 * and the Android status-bar colour). Adding a theme therefore means: a block
 * in variables.css, one entry here, one i18n key.
 */

export interface ThemePreview {
  bg: string
  text: string
  accent: string
}

export interface ThemeMeta {
  id: string
  dark: boolean
  labelKey: string
  statusBar: string
  preview: ThemePreview
}

export const THEMES: ThemeMeta[] = [
  { id: 'one-light',           dark: false, labelKey: 'themes.oneLight',           statusBar: '#f0f0f0', preview: { bg: '#fafafa', text: '#383a42', accent: '#4078f2' } },
  { id: 'ayu-light',           dark: false, labelKey: 'themes.ayuLight',           statusBar: '#f3f3f3', preview: { bg: '#fafafa', text: '#5c6166', accent: '#ff9940' } },
  { id: 'github-light',        dark: false, labelKey: 'themes.githubLight',        statusBar: '#f8f9fa', preview: { bg: '#f8f9fa', text: '#212529', accent: '#4a90d9' } },
  { id: 'light-modern',        dark: false, labelKey: 'themes.lightModern',        statusBar: '#f3f3f3', preview: { bg: '#fafafa', text: '#1a1a1a', accent: '#0b57d0' } },
  { id: 'light-plus',          dark: false, labelKey: 'themes.lightPlus',          statusBar: '#f5f5f5', preview: { bg: '#ffffff', text: '#000000', accent: '#0065bf' } },
  { id: 'quiet-light',         dark: false, labelKey: 'themes.quietLight',         statusBar: '#ececec', preview: { bg: '#f5f5f5', text: '#333333', accent: '#4a6f8b' } },
  { id: 'vitesse-light',       dark: false, labelKey: 'themes.vitesseLight',       statusBar: '#f6f6f4', preview: { bg: '#ffffff', text: '#393a34', accent: '#4d9375' } },
  { id: 'bluloco-light',       dark: false, labelKey: 'themes.blulocoLight',       statusBar: '#edf1f7', preview: { bg: '#f7f9fc', text: '#292d3e', accent: '#2b7bda' } },
  { id: 'material-lighter',    dark: false, labelKey: 'themes.materialLighter',    statusBar: '#f0f0f0', preview: { bg: '#fafafa', text: '#212121', accent: '#1976d2' } },
  { id: 'alabaster',           dark: false, labelKey: 'themes.alabaster',          statusBar: '#eeeeee', preview: { bg: '#f7f7f7', text: '#272727', accent: '#0086b3' } },
  { id: 'everforest-light',    dark: false, labelKey: 'themes.everforestLight',    statusBar: '#f2e9d0', preview: { bg: '#fdf6e3', text: '#5c6a72', accent: '#7a8478' } },
  { id: 'high-contrast-light', dark: false, labelKey: 'themes.highContrastLight',  statusBar: '#f5f5f5', preview: { bg: '#f5f5f5', text: '#000000', accent: '#0055cc' } },
  { id: 'nord-light',          dark: false, labelKey: 'themes.nordLight',          statusBar: '#e5e9f0', preview: { bg: '#eceff4', text: '#2e3440', accent: '#5e81ac' } },
  { id: 'catppuccin-latte',    dark: false, labelKey: 'themes.catppuccinLatte',    statusBar: '#e6e9ef', preview: { bg: '#e6e9ef', text: '#4c4f69', accent: '#1e66f5' } },
  { id: 'solarized-light',     dark: false, labelKey: 'themes.solarizedLight',     statusBar: '#eee8d5', preview: { bg: '#eee8d5', text: '#657b83', accent: '#268bd2' } },
  { id: 'gruvbox-light',       dark: false, labelKey: 'themes.gruvboxLight',       statusBar: '#f2e5bc', preview: { bg: '#f2e5bc', text: '#3c3836', accent: '#af3a03' } },
  { id: 'solarized-dark',      dark: true,  labelKey: 'themes.solarizedDark',      statusBar: '#0a3541', preview: { bg: '#0a3541', text: '#a0b0b4', accent: '#2e9fd8' } },
  { id: 'monokai',             dark: true,  labelKey: 'themes.monokai',            statusBar: '#272822', preview: { bg: '#272822', text: '#f8f8f2', accent: '#66d9ef' } },
  { id: 'material-darker',     dark: true,  labelKey: 'themes.materialDarker',     statusBar: '#212121', preview: { bg: '#212121', text: '#eeffff', accent: '#80cbc4' } },
  { id: 'dark-plus',           dark: true,  labelKey: 'themes.darkPlus',           statusBar: '#1e1e1e', preview: { bg: '#1e1e1e', text: '#d4d4d4', accent: '#3794ff' } },
  { id: 'bluloco-dark',        dark: true,  labelKey: 'themes.blulocoDark',        statusBar: '#1d212c', preview: { bg: '#1d212c', text: '#e2e8f0', accent: '#52a5ff' } },
  { id: 'nord',                dark: true,  labelKey: 'themes.nord',               statusBar: '#202833', preview: { bg: '#202833', text: '#e6ecf4', accent: '#6cb2f0' } },
  { id: 'everforest-dark',     dark: true,  labelKey: 'themes.everforestDark',     statusBar: '#22282b', preview: { bg: '#22282b', text: '#d3c6aa', accent: '#a7c080' } },
  { id: 'one-dark-pro',        dark: true,  labelKey: 'themes.oneDarkPro',         statusBar: '#21252b', preview: { bg: '#21252b', text: '#abb2bf', accent: '#61afef' } },
  { id: 'dracula',             dark: true,  labelKey: 'themes.dracula',            statusBar: '#21222c', preview: { bg: '#21222c', text: '#f8f8f2', accent: '#bd93f9' } },
  { id: 'rose-pine',           dark: true,  labelKey: 'themes.rosePine',           statusBar: '#1f1d2e', preview: { bg: '#1f1d2e', text: '#e0def4', accent: '#ebbcba' } },
  { id: 'gruvbox-dark',        dark: true,  labelKey: 'themes.gruvboxDark',        statusBar: '#1d2021', preview: { bg: '#1d2021', text: '#ebdbb2', accent: '#fe8019' } },
  { id: 'solarized-deep',      dark: true,  labelKey: 'themes.solarizedDeep',      statusBar: '#15212b', preview: { bg: '#15212b', text: '#dce5ec', accent: '#3bb8e0' } },
  { id: 'github-dark',         dark: true,  labelKey: 'themes.githubDark',         statusBar: '#161b22', preview: { bg: '#161b22', text: '#c9d1d9', accent: '#58a6ff' } },
  { id: 'catppuccin-mocha',    dark: true,  labelKey: 'themes.catppuccinMocha',    statusBar: '#181825', preview: { bg: '#181825', text: '#cdd6f4', accent: '#89b4fa' } },
  { id: 'vitesse-dark',        dark: true,  labelKey: 'themes.vitesseDark',        statusBar: '#181818', preview: { bg: '#181818', text: '#dbd7ca', accent: '#4d9375' } },
  { id: 'tokyo-night',         dark: true,  labelKey: 'themes.tokyoNight',         statusBar: '#16161e', preview: { bg: '#16161e', text: '#c0caf5', accent: '#7aa2f7' } },
  { id: 'kanagawa',            dark: true,  labelKey: 'themes.kanagawa',           statusBar: '#16161d', preview: { bg: '#16161d', text: '#dcd7ba', accent: '#7e9cd8' } },
  { id: 'ayu-dark',            dark: true,  labelKey: 'themes.ayuDark',            statusBar: '#0d1017', preview: { bg: '#0d1017', text: '#b3b1ad', accent: '#e6b450' } },
  { id: 'night-owl',           dark: true,  labelKey: 'themes.nightOwl',           statusBar: '#001122', preview: { bg: '#001122', text: '#d6deeb', accent: '#82aaff' } },
  { id: 'high-contrast-dark',  dark: true,  labelKey: 'themes.highContrastDark',   statusBar: '#0a0a0a', preview: { bg: '#0a0a0a', text: '#ffffff', accent: '#00ccff' } },
]

export const THEME_IDS: readonly string[] = THEMES.map((t) => t.id)

const BY_ID = new Map(THEMES.map((t) => [t.id, t]))

export const DARK_DEFAULT = 'gruvbox-dark'
export const LIGHT_DEFAULT = 'github-light'
export const DEFAULT_THEME = DARK_DEFAULT

export function themeMeta(id: string): ThemeMeta | undefined {
  return BY_ID.get(id)
}

export function isDarkTheme(id: string): boolean {
  return BY_ID.get(id)?.dark ?? true
}

/** Resolve 'auto' against the system preference. Never returns 'auto'. */
export function resolveTheme(choice: string): string {
  if (choice === 'auto') {
    const dark = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    return dark ? DARK_DEFAULT : LIGHT_DEFAULT
  }
  return BY_ID.has(choice) ? choice : DEFAULT_THEME
}

/**
 * Apply a theme choice to <html> and keep the Android status bar in sync.
 *
 * The status bar colour goes through `meta[name=theme-color]`, which both
 * Chrome-for-Android and the WebView shell honour; the native side reads the
 * same value from its own ThemePalette table, so a mismatch here would show as
 * a differently coloured strip above the app.
 */
export function applyTheme(choice: string) {
  const id = resolveTheme(choice)
  const meta = themeMeta(id)
  const root = document.documentElement
  root.setAttribute('data-theme', id)
  root.setAttribute('data-theme-base', meta?.dark ? 'dark' : 'light')
  const tag = document.querySelector('meta[name="theme-color"]')
  if (tag && meta) tag.setAttribute('content', meta.statusBar)
  appLog.d('Theme', `applied ${id}`)
}
