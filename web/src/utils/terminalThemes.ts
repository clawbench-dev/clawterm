import type { ITheme } from '@xterm/xterm'
import { isDarkTheme } from './themeMeta'

/**
 * xterm colour schemes.
 *
 * These are the 157 community palettes from the `xterm-theme` package, inlined
 * as data rather than imported: the package ships one module exporting every
 * theme, so importing it to render a picker would put all 157 palettes in the
 * main bundle for a screen most users never open. Inlining lets the picker be a
 * plain data list and keeps the terminal itself theme-agnostic.
 *
 * `auto` is not one of them: it means "derive the palette from the app theme"
 * and is handled by utils/terminalTheme.ts.
 */

export const TERMINAL_THEME_AUTO = 'auto'
export const TERMINAL_THEME_STORAGE_KEY = 'terminalTheme'

/** Ids in picker order: palettes with a known background first (light to dark),
 *  then the ones that inherit the terminal default. */
export const TERMINAL_THEME_IDS: string[] = [
  'AdventureTime', 'Afterglow', 'AlienBlood', 'Argonaut', 'Arthur', 'AtelierSulphurpool',
  'Atom', 'Batman', 'Belafonte_Night', 'BirdsOfParadise', 'Blazer', 'Borland',
  'Bright_Lights', 'Broadcast', 'Brogrammer', 'C64', 'Chalk', 'Chalkboard', 'Ciapre',
  'Cobalt2', 'Cobalt_Neon', 'CrayonPonyFish', 'Dark_Pastel', 'Darkside', 'Desert',
  'DimmedMonokai', 'DotGov', 'Dracula', 'Duotone_Dark', 'ENCOM', 'Earthsong', 'Elemental',
  'Elementary', 'Espresso', 'Espresso_Libre', 'Fideloper', 'FirefoxDev', 'Firewatch',
  'FishTank', 'Flat', 'Flatland', 'Floraverse', 'ForestBlue', 'FrontEndDelight',
  'FunForrest', 'Galaxy', 'Github', 'Glacier', 'Grape', 'Grass', 'Gruvbox_Dark',
  'Hardcore', 'Harper', 'Highway', 'Hipster_Green', 'Homebrew', 'Hurtado', 'Hybrid',
  'IC_Green_PPL', 'IC_Orange_PPL', 'IR_Black', 'Jackie_Brown', 'Japanesque', 'Jellybeans',
  'JetBrains_Darcula', 'Kibble', 'Later_This_Evening', 'Lavandula', 'LiquidCarbon',
  'LiquidCarbonTransparent', 'LiquidCarbonTransparentInverse', 'Man_Page', 'Material',
  'MaterialDark', 'Mathias', 'Medallion', 'Misterioso', 'Molokai', 'MonaLisa',
  'Monokai_Soda', 'Monokai_Vivid', 'N0tch2k', 'Neopolitan', 'Neutron', 'NightLion_v1',
  'NightLion_v2', 'Night_3024', 'Novel', 'Obsidian', 'Ocean', 'OceanicMaterial', 'Ollie',
  'OneHalfDark', 'OneHalfLight', 'Pandora', 'Paraiso_Dark', 'Parasio_Dark', 'PaulMillr',
  'PencilDark', 'PencilLight', 'Piatto_Light', 'Pnevma', 'Pro', 'Red_Alert', 'Red_Sands',
  'Rippedcasts', 'Royal', 'Ryuuko', 'SeaShells', 'Seafoam_Pastel', 'Seti', 'Shaman',
  'Slate', 'Smyck', 'SoftServer', 'Solarized_Darcula', 'Solarized_Dark',
  'Solarized_Dark_Higher_Contrast', 'Solarized_Dark_Patched', 'Solarized_Light', 'SpaceGray',
  'SpaceGray_Eighties', 'SpaceGray_Eighties_Dull', 'Spacedust', 'Spiderman', 'Spring',
  'Square', 'Sundried', 'Symfonic', 'Teerb', 'Terminal_Basic', 'Thayer_Bright', 'The_Hulk',
  'Tomorrow', 'Tomorrow_Night', 'Tomorrow_Night_Blue', 'Tomorrow_Night_Bright',
  'Tomorrow_Night_Eighties', 'ToyChest', 'Treehouse', 'Ubuntu', 'UnderTheSea', 'Urple',
  'Vaughn', 'VibrantInk', 'Violet_Dark', 'Violet_Light', 'WarmNeon', 'Wez', 'WildCherry',
  'Wombat', 'Wryan', 'Zenburn', 'ayu', 'deep', 'default', 'idleToes',
]

/** Background of each palette, used to sort the picker and to draw its swatch.
 *  `null` means the palette has no background of its own. */
export const TERMINAL_THEME_BACKGROUNDS: Record<string, string | null> = {
  AdventureTime: '#1f1d45',
  Afterglow: '#212121',
  AlienBlood: '#0f1610',
  Argonaut: '#0e1019',
  Arthur: '#1c1c1c',
  AtelierSulphurpool: '#202746',
  Atom: '#161719',
  Batman: '#1b1d1e',
  Belafonte_Night: '#20111b',
  BirdsOfParadise: '#2a1f1d',
  Blazer: '#0d1926',
  Borland: '#0000a4',
  Bright_Lights: '#191919',
  Broadcast: '#2b2b2b',
  Brogrammer: '#131313',
  C64: '#40318d',
  Chalk: '#2b2d2e',
  Chalkboard: '#29262f',
  Ciapre: '#191c27',
  Cobalt2: '#132738',
  Cobalt_Neon: '#142838',
  CrayonPonyFish: '#150707',
  Dark_Pastel: '#000000',
  Darkside: '#222324',
  Desert: '#333333',
  DimmedMonokai: '#1f1f1f',
  DotGov: '#262c35',
  Dracula: '#1e1f29',
  Duotone_Dark: '#1f1d27',
  ENCOM: '#000000',
  Earthsong: '#292520',
  Elemental: '#22211d',
  Elementary: '#181818',
  Espresso: '#323232',
  Espresso_Libre: '#2a211c',
  Fideloper: '#292f33',
  FirefoxDev: '#0e1011',
  Firewatch: '#1e2027',
  FishTank: '#232537',
  Flat: '#002240',
  Flatland: '#1d1f21',
  Floraverse: '#0e0d15',
  ForestBlue: '#051519',
  FrontEndDelight: '#1b1c1d',
  FunForrest: '#251200',
  Galaxy: '#1d2837',
  Github: '#f4f4f4',
  Glacier: '#0c1115',
  Grape: '#171423',
  Grass: '#13773d',
  Gruvbox_Dark: '#1e1e1e',
  Hardcore: '#121212',
  Harper: '#010101',
  Highway: '#222225',
  Hipster_Green: '#100b05',
  Homebrew: '#000000',
  Hurtado: '#000000',
  Hybrid: '#161719',
  IC_Green_PPL: '#3a3d3f',
  IC_Orange_PPL: '#262626',
  IR_Black: '#000000',
  Jackie_Brown: '#2c1d16',
  Japanesque: '#1e1e1e',
  Jellybeans: '#121212',
  JetBrains_Darcula: '#202020',
  Kibble: '#0e100a',
  Later_This_Evening: '#222222',
  Lavandula: '#050014',
  LiquidCarbon: '#303030',
  LiquidCarbonTransparent: '#000000',
  LiquidCarbonTransparentInverse: '#000000',
  Man_Page: '#fef49c',
  Material: '#eaeaea',
  MaterialDark: '#232322',
  Mathias: '#000000',
  Medallion: '#1d1908',
  Misterioso: '#2d3743',
  Molokai: '#121212',
  MonaLisa: '#120b0d',
  Monokai_Soda: '#1a1a1a',
  Monokai_Vivid: '#121212',
  N0tch2k: '#222222',
  Neopolitan: '#271f19',
  Neutron: '#1c1e22',
  NightLion_v1: '#000000',
  NightLion_v2: '#171717',
  Night_3024: '#090300',
  Novel: '#dfdbc3',
  Obsidian: '#283033',
  Ocean: '#224fbc',
  OceanicMaterial: '#1c262b',
  Ollie: '#222125',
  OneHalfDark: '#282c34',
  OneHalfLight: '#fafafa',
  Pandora: '#141e43',
  Paraiso_Dark: '#2f1e2e',
  Parasio_Dark: '#2f1e2e',
  PaulMillr: '#000000',
  PencilDark: '#212121',
  PencilLight: '#f1f1f1',
  Piatto_Light: '#ffffff',
  Pnevma: '#1c1c1c',
  Pro: '#000000',
  Red_Alert: '#762423',
  Red_Sands: '#7a251e',
  Rippedcasts: '#2b2b2b',
  Royal: '#100815',
  Ryuuko: '#2c3941',
  SeaShells: '#09141b',
  Seafoam_Pastel: '#243435',
  Seti: '#111213',
  Shaman: '#001015',
  Slate: '#222222',
  Smyck: '#1b1b1b',
  SoftServer: '#242626',
  Solarized_Darcula: '#3d3f41',
  Solarized_Dark: '#001e27',
  Solarized_Dark_Higher_Contrast: '#001e27',
  Solarized_Dark_Patched: '#001e27',
  Solarized_Light: '#fcf4dc',
  SpaceGray: '#20242d',
  SpaceGray_Eighties: '#222222',
  SpaceGray_Eighties_Dull: '#222222',
  Spacedust: '#0a1e24',
  Spiderman: '#1b1d1e',
  Spring: '#ffffff',
  Square: '#1a1a1a',
  Sundried: '#1a1818',
  Symfonic: '#000000',
  Teerb: '#262626',
  Terminal_Basic: '#ffffff',
  Thayer_Bright: '#1b1d1e',
  The_Hulk: '#1b1d1e',
  Tomorrow: '#ffffff',
  Tomorrow_Night: '#1d1f21',
  Tomorrow_Night_Blue: '#002451',
  Tomorrow_Night_Bright: '#000000',
  Tomorrow_Night_Eighties: '#2d2d2d',
  ToyChest: '#24364b',
  Treehouse: '#191919',
  Ubuntu: '#300a24',
  UnderTheSea: '#011116',
  Urple: '#1b1b23',
  Vaughn: '#25234f',
  VibrantInk: '#000000',
  Violet_Dark: '#1c1d1f',
  Violet_Light: '#fcf4dc',
  WarmNeon: '#404040',
  Wez: '#000000',
  WildCherry: '#1f1726',
  Wombat: '#171717',
  Wryan: '#101010',
  Zenburn: '#3f3f3f',
  ayu: '#0f1419',
  deep: '#000000',
  default: null,
  idleToes: '#323232',
}

/** Parse `#rgb` / `#rrggbb` into RGB, or null when unparsable. */
export function parseHexColor(hex: string): [number, number, number] | null {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length !== 6) return null
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  if ([r, g, b].some(Number.isNaN)) return null
  return [r, g, b]
}

/** Perceived luminance (0 dark .. 255 light); 0 when unparsable. */
export function backgroundLuminance(hex: string): number {
  const rgb = parseHexColor(hex)
  if (!rgb) return 0
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
}

/**
 * Picker order: light to dark, with the background-less palettes last.
 *
 * Sorting once here (not at render time) keeps the list stable across opens —
 * a menu that reorders itself between visits makes the item you just used hard
 * to find again.
 */
export const SORTED_TERMINAL_THEME_IDS: readonly string[] = (() => {
  const withBg = TERMINAL_THEME_IDS.filter((id) => TERMINAL_THEME_BACKGROUNDS[id] != null)
  const noBg = TERMINAL_THEME_IDS.filter((id) => TERMINAL_THEME_BACKGROUNDS[id] == null)
  const sorted = [...withBg].sort(
    (a, b) => backgroundLuminance(TERMINAL_THEME_BACKGROUNDS[b]!) - backgroundLuminance(TERMINAL_THEME_BACKGROUNDS[a]!),
  )
  return [...sorted, ...noBg]
})()

/**
 * Whether a palette reads as dark.
 *
 * Used to keep the status bar and the surrounding chrome in step with the
 * terminal: a light terminal palette under a dark app header looks like a
 * rendering bug.
 */
export function isDarkTerminalTheme(id: string): boolean {
  const bg = TERMINAL_THEME_BACKGROUNDS[id]
  if (!bg) return isDarkTheme('gruvbox-dark')
  return backgroundLuminance(bg) < 128
}

// ── Palette loading ─────────────────────────────────────────────────────────

let cached: Record<string, ITheme> | null = null
let pending: Promise<Record<string, ITheme>> | null = null

/** How many times to retry a failed chunk load before giving up. */
const LOAD_RETRIES = 3
const RETRY_DELAY_MS = 600

/**
 * Load the palettes.
 *
 * `xterm-theme` exports all 157 schemes from one module, so it is imported
 * dynamically: bundling it eagerly would add its full weight to the first paint
 * for a screen most users never open. The retry exists because this is a lazy
 * CHUNK — a flaky network makes the picker come up empty, and one retry fixes
 * the common case.
 *
 * The promise is cleared on failure so the next attempt can start fresh; a
 * permanently rejected cached promise would break the picker for the rest of
 * the session.
 */
export async function loadTerminalThemes(): Promise<Record<string, ITheme>> {
  if (cached) return cached
  if (pending) return pending
  pending = (async () => {
    let lastErr: unknown = null
    for (let attempt = 0; attempt <= LOAD_RETRIES; attempt++) {
      try {
        const mod = await import('xterm-theme')
        cached = (mod.default ?? mod) as Record<string, ITheme>
        return cached
      } catch (err) {
        lastErr = err
        if (attempt < LOAD_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        }
      }
    }
    throw lastErr
  })()
  try {
    return await pending
  } finally {
    pending = null
  }
}

/** Resolve one palette by id, falling back to null when the module is missing. */
export async function resolveTerminalTheme(id: string): Promise<ITheme | null> {
  if (!id || id === TERMINAL_THEME_AUTO) return null
  const all = await loadTerminalThemes()
  return all[id] ?? null
}

/** @internal test helper */
export function _resetTerminalThemeCache() {
  cached = null
  pending = null
}
