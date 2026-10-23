/**
 * `xterm-theme` ships no types: it is a single CommonJS module exporting one
 * `ITheme` object per scheme name. Declared here rather than pulling in a
 * `@types` package that does not exist.
 */
declare module 'xterm-theme' {
  import type { ITheme } from '@xterm/xterm'
  const themes: Record<string, ITheme>
  export default themes
}
