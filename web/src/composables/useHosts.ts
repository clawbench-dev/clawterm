import { ref, computed } from 'vue'
import { apiDelete, apiGet, apiPost, apiPut } from '@/utils/api'
import { appLog } from '@/utils/appLog'

export interface Host {
  id: number
  name: string
  address: string
  port: number
  username: string
  authType: 'password' | 'key' | 'agent'
  keyPath: string
  hasPassword: boolean
  hasPassphrase: boolean
  color: string
  group: string
  lastUsedAt: number
  createdAt: string
  updatedAt: string
}

export interface HostPayload {
  name: string
  address: string
  port: number
  username: string
  authType: 'password' | 'key' | 'agent'
  keyPath: string
  password: string
  passphrase: string
  color: string
  group: string
}

/**
 * Host list state. Module-level singletons: the host list is read by the hosts
 * panel, the file browser's host picker and the snippet scope selector, and
 * three independent copies would drift (one deleting a host while another still
 * shows it).
 */
export const hosts = ref<Host[]>([])
export const hostsLoading = ref(false)
export const hostsLoaded = ref(false)
export const hostSearch = ref('')

const TAG = 'Hosts'

export async function loadHosts(force = false): Promise<void> {
  if (hostsLoading.value) return
  if (hostsLoaded.value && !force) return
  hostsLoading.value = true
  try {
    hosts.value = await apiGet<Host[]>('/api/hosts')
    hostsLoaded.value = true
  } catch (err) {
    appLog.w(TAG, 'load failed', String(err))
    throw err
  } finally {
    hostsLoading.value = false
  }
}

export async function createHost(p: HostPayload): Promise<Host> {
  const h = await apiPost<Host>('/api/hosts', p)
  hosts.value = [...hosts.value, h]
  return h
}

export async function updateHost(id: number, p: HostPayload): Promise<Host> {
  const h = await apiPut<Host>(`/api/hosts/${id}`, p)
  hosts.value = hosts.value.map((x) => (x.id === id ? h : x))
  return h
}

export async function deleteHost(id: number): Promise<void> {
  await apiDelete(`/api/hosts/${id}`)
  hosts.value = hosts.value.filter((x) => x.id !== id)
}

export interface HostTestResult {
  ok: boolean
  latency: number
  notice: string
  addr: string
}

export function testHost(id: number): Promise<HostTestResult> {
  return apiPost<HostTestResult>(`/api/hosts/${id}/test`)
}

/** Accept a changed host key (unpins it so the next dial re-pins). */
export function acceptHostKey(id: number): Promise<void> {
  return apiPost<void>(`/api/hosts/${id}/forget-key`)
}

export function hostById(id: number): Host | undefined {
  return hosts.value.find((h) => h.id === id)
}

/**
 * Hosts grouped for display: ungrouped first, then groups alphabetically.
 *
 * Recent-use order is preserved inside each group — the list already arrives
 * sorted by last use, and re-sorting by name would throw away the only signal
 * that says "this is the one you actually connect to".
 */
export const groupedHosts = computed(() => {
  const q = hostSearch.value.trim().toLowerCase()
  const filtered = q
    ? hosts.value.filter((h) => `${h.name} ${h.address} ${h.username}`.toLowerCase().includes(q))
    : hosts.value
  const groups = new Map<string, Host[]>()
  for (const h of filtered) {
    const key = h.group.trim()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(h)
  }
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === '') return -1
    if (b[0] === '') return 1
    return a[0].localeCompare(b[0])
  })
})

export function useHosts() {
  return {
    hosts,
    loading: hostsLoading,
    loaded: hostsLoaded,
    search: hostSearch,
    grouped: groupedHosts,
    loadHosts,
    createHost,
    updateHost,
    deleteHost,
    testHost,
    acceptHostKey,
    hostById,
  }
}
