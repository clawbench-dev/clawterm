import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Navigation restores the last tab from localStorage.
 *
 * The interesting case is a stale value: `forwards` was a real tab until the
 * feature was removed, so every existing install still has it stored. Restoring
 * it blindly would leave `activeTab` pointing at a panel that no longer exists —
 * `PANELS[id]` would be undefined and the content area would render nothing.
 */
describe('useNavigation', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('starts on hosts with nothing stored', async () => {
    const { activeTab, TABS } = await import('@/composables/useNavigation')
    expect(activeTab.value).toBe('hosts')
    expect(TABS).toEqual(['hosts', 'terminal', 'files', 'snippets', 'settings'])
  })

  it('restores a stored tab that still exists', async () => {
    localStorage.setItem('clawterm-active-tab', 'snippets')
    const { activeTab } = await import('@/composables/useNavigation')
    expect(activeTab.value).toBe('snippets')
  })

  // A removed tab must fall back rather than restore a tab with no panel.
  it('ignores a stored tab that no longer exists', async () => {
    localStorage.setItem('clawterm-active-tab', 'forwards')
    const { activeTab } = await import('@/composables/useNavigation')
    expect(activeTab.value).toBe('hosts')
  })

  it('ignores garbage in storage', async () => {
    localStorage.setItem('clawterm-active-tab', 'nope')
    const { activeTab } = await import('@/composables/useNavigation')
    expect(activeTab.value).toBe('hosts')
  })

  it('persists a switch so a reload lands on the same tab', async () => {
    const { switchTab } = await import('@/composables/useNavigation')
    switchTab('files')
    expect(localStorage.getItem('clawterm-active-tab')).toBe('files')
  })
})
