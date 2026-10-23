import { ref } from 'vue'
import { apiDelete, apiGet, apiPost, apiPut } from '@/utils/api'
import { appLog } from '@/utils/appLog'

export interface Snippet {
  id: number
  label: string
  command: string
  hostId: number
  send: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface SnippetPayload {
  label: string
  command: string
  hostId: number
  send: boolean
}

export const snippets = ref<Snippet[]>([])
export const snippetsLoading = ref(false)
export const snippetsLoaded = ref(false)

const TAG = 'Snippets'

export async function loadSnippets(force = false): Promise<void> {
  if (snippetsLoading.value) return
  if (snippetsLoaded.value && !force) return
  snippetsLoading.value = true
  try {
    snippets.value = await apiGet<Snippet[]>('/api/snippets')
    snippetsLoaded.value = true
  } catch (err) {
    appLog.w(TAG, 'load failed', String(err))
    throw err
  } finally {
    snippetsLoading.value = false
  }
}

export async function createSnippet(p: SnippetPayload): Promise<Snippet> {
  const s = await apiPost<Snippet>('/api/snippets', p)
  snippets.value = [...snippets.value, s]
  return s
}

export async function updateSnippet(id: number, p: SnippetPayload): Promise<void> {
  await apiPut(`/api/snippets/${id}`, p)
  snippets.value = snippets.value.map((s) => (s.id === id ? { ...s, ...p } : s))
}

export async function deleteSnippet(id: number): Promise<void> {
  await apiDelete(`/api/snippets/${id}`)
  snippets.value = snippets.value.filter((s) => s.id !== id)
}

export async function reorderSnippets(ids: number[]): Promise<void> {
  await apiPut('/api/snippets/reorder', { ids })
  // Re-derive sortOrder locally so the list does not jump before the next load.
  const byId = new Map(snippets.value.map((s) => [s.id, s]))
  snippets.value = ids
    .map((id, i) => {
      const s = byId.get(id)
      return s ? { ...s, sortOrder: i } : null
    })
    .filter((s): s is Snippet => s !== null)
}

export function useSnippets() {
  return { snippets, loading: snippetsLoading, loaded: snippetsLoaded, loadSnippets, createSnippet, updateSnippet, deleteSnippet, reorderSnippets }
}
