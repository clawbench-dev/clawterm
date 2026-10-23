import { ref, computed, shallowRef, watch } from 'vue'
import type { Terminal } from '@xterm/xterm'
import { appLog } from '@/utils/appLog'
import { TerminalSession, type ConnectionState } from './useTerminalSession'
import { hostById } from './useHosts'

const TAG = 'TerminalTabs'

export interface TerminalTab {
  /** Stable local id (never reused). */
  id: string
  hostId: number
  title: string
  /** Server-side PTY id, empty until `ready` arrives. */
  sessionId: string
  state: ConnectionState
  error: string
  errorCode: string
  exitCode: number
  /** Unread output arrived while the tab was not visible. */
  hasUnread: boolean
  /** True while the terminal view is the visible pane. */
  active: boolean
}

/**
 * Terminal tabs.
 *
 * The xterm instances live here rather than inside the view component because
 * the dock switches panels by unmounting them: a terminal that is destroyed on
 * every tab switch would lose its scrollback, its selection and — worse — its
 * cursor position in whatever TUI is running. Keeping the instance alive and
 * re-parenting its element is what makes switching feel instant.
 *
 * Output is buffered per tab until its view has attached (the first render
 * happens after the socket may already have delivered the prompt), otherwise
 * the first screenful of a fast session is lost.
 */
export const tabs = ref<TerminalTab[]>([])
export const activeTabId = ref('')

/** Non-reactive heavy objects, keyed by tab id. */
const terminals = new Map<string, Terminal>()
const sessions = new Map<string, TerminalSession>()
const pendingOutput = new Map<string, string[]>()
/** Views currently attached to a tab (a tab can be re-parented, not cloned). */
const mounted = new Map<string, (data: string) => void>()

let seq = 0

export const MAX_TABS = 12

export const activeTab = computed<TerminalTab | undefined>(
  () => tabs.value.find((t) => t.id === activeTabId.value),
)

export const tabCount = computed(() => tabs.value.length)

/** Register the xterm instance for a tab (called by the view on mount). */
export function attachTerminal(tabId: string, term: Terminal, flush: (data: string) => void) {
  terminals.set(tabId, term)
  const route = (data: string) => flush(data)
  mounted.set(tabId, route)
  // Flush anything that arrived while the view was not mounted.
  const queued = pendingOutput.get(tabId)
  if (queued && queued.length) {
    for (const chunk of queued) route(chunk)
    pendingOutput.delete(tabId)
  }
}

export function detachTerminal(tabId: string) {
  mounted.delete(tabId)
}

/** Route PTY output to the tab's view, buffering when no view is attached. */
function deliver(tabId: string, data: string) {
  const flush = mounted.get(tabId)
  if (flush) {
    flush(data)
    return
  }
  const q = pendingOutput.get(tabId) ?? []
  q.push(data)
  // A tab that is never opened again must not grow without bound.
  if (q.length > 4000) q.splice(0, q.length - 4000)
  pendingOutput.set(tabId, q)
}

/**
 * Open a new terminal tab for a host.
 *
 * Returns the tab so the caller can switch to it. Throws when the tab limit is
 * reached — the caller shows the toast, because the limit is a UX fact the user
 * needs to hear about, not a silent no-op.
 */
export function openTab(hostId: number, cols = 80, rows = 24): TerminalTab {
  if (tabs.value.length >= MAX_TABS) {
    throw new Error(`tab limit ${MAX_TABS}`)
  }
  const host = hostById(hostId)
  const id = `t${++seq}`
  const tab: TerminalTab = {
    id,
    hostId,
    title: host?.name || `SSH ${hostId}`,
    sessionId: '',
    state: 'connecting',
    error: '',
    errorCode: '',
    exitCode: 0,
    hasUnread: false,
    active: false,
  }
  tabs.value = [...tabs.value, tab]

  const session = new TerminalSession({
    hostId,
    title: tab.title,
    cols,
    rows,
    onData: (data) => {
      deliver(id, data)
      const t = tabs.value.find((x) => x.id === id)
      // Unread only counts when the user is looking somewhere else; a terminal
      // in the background producing output is exactly the case the dot is for.
      if (t && activeTabId.value !== id) t.hasUnread = true
    },
    onExit: (code) => {
      const t = tabs.value.find((x) => x.id === id)
      if (t) {
        t.exitCode = code
        t.state = 'exited'
      }
    },
    onSessionId: (sid) => {
      const t = tabs.value.find((x) => x.id === id)
      if (t) t.sessionId = sid
    },
  })
  sessions.set(id, session)

  // Mirror the session's reactive state into the tab record, so the view can
  // read plain tab fields instead of reaching into the session object.
  watch(
    [session.state, session.error, session.errorCode],
    ([state, error, errorCode]) => {
      const t = tabs.value.find((x) => x.id === id)
      if (!t) return
      t.state = state
      t.error = error
      t.errorCode = errorCode
    },
    { immediate: true },
  )

  session.connect()
  appLog.i(TAG, `open tab ${id} for host ${hostId}`)
  return tab
}

export function selectTab(id: string) {
  const t = tabs.value.find((x) => x.id === id)
  if (!t) return
  activeTabId.value = id
  for (const x of tabs.value) x.active = x.id === id
  t.hasUnread = false
}

export function closeTab(id: string) {
  const idx = tabs.value.findIndex((t) => t.id === id)
  if (idx === -1) return
  const tab = tabs.value[idx]
  sessions.get(id)?.close()
  sessions.delete(id)
  terminals.delete(id)
  mounted.delete(id)
  pendingOutput.delete(id)

  tabs.value = tabs.value.filter((t) => t.id !== id)
  if (tab.sessionId) {
    // End the server-side PTY too, otherwise it lingers until the grace period
    // expires and the tab count on the server drifts from the UI.
    void fetch(`/api/terminal/sessions?session=${encodeURIComponent(tab.sessionId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    }).catch(() => { /* best effort: the reaper collects it */ })
  }
  if (activeTabId.value === id) {
    const next = tabs.value[Math.min(idx, tabs.value.length - 1)]
    if (next) selectTab(next.id)
    else activeTabId.value = ''
  }
  appLog.i(TAG, `closed tab ${id}`)
}

export function renameTab(id: string, title: string) {
  const t = tabs.value.find((x) => x.id === id)
  if (t) t.title = title
}

export function sendInput(id: string, data: string) {
  sessions.get(id)?.send(data)
}

export function resizeTab(id: string, cols: number, rows: number) {
  sessions.get(id)?.resize(cols, rows)
}

export function sessionFor(id: string): TerminalSession | undefined {
  return sessions.get(id)
}

/** Reconnect a tab whose connection gave up (auth error, network death). */
export function reconnectTab(id: string) {
  const s = sessions.get(id)
  if (!s) return
  s.connect()
}

/** Close every tab (sign-out). */
export function closeAllTabs() {
  for (const t of [...tabs.value]) closeTab(t.id)
}

/** Count of tabs still alive — used by the dock badge. */
export const runningCount = computed(() => tabs.value.filter((t) => t.state === 'connected').length)

// `shallowRef` is re-exported for views that need to hold an xterm instance
// without making Vue walk it.
export { shallowRef }
