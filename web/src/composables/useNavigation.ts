import { ref } from 'vue'

/**
 * App-level navigation.
 *
 * Kept in its own module rather than as App.vue state passed down as props:
 * three different panels need to jump to another tab (hosts → terminal, files →
 * terminal, hosts → files), and threading an emit chain through every panel
 * would make each of them aware of its parent.
 */

export type TabId = 'hosts' | 'terminal' | 'files' | 'forwards' | 'snippets' | 'settings'

export const TABS: TabId[] = ['hosts', 'terminal', 'files', 'forwards', 'snippets', 'settings']

const STORAGE_KEY = 'clawterm-active-tab'

export const activeTab = ref<TabId>(readInitial())

function readInitial(): TabId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as TabId | null
    if (saved && TABS.includes(saved)) return saved
  } catch { /* private mode */ }
  return 'hosts'
}

export function switchTab(id: TabId) {
  activeTab.value = id
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch { /* private mode */ }
}
