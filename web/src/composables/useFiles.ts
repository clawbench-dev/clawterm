import { ref } from 'vue'
import { apiGet } from '@/utils/api'
import { appLog } from '@/utils/appLog'

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  isLink: boolean
  size: number
  mode: string
  modTime: number
}

export interface DirListing {
  path: string
  entries: FileEntry[]
}

export interface FileContent {
  path: string
  size: number
  truncated: boolean
  content: string
}

const TAG = 'Files'

/** Per-host directory cache, keyed by "hostId:path". */
const cache = new Map<string, DirListing>()
const loading = ref(false)
const error = ref('')

/** Last browsed path per host, so switching back returns where you were. */
const lastPath = new Map<number, string>()

export async function listDir(hostId: number, path: string, force = false): Promise<DirListing> {
  const key = `${hostId}:${path}`
  if (!force) {
    const hit = cache.get(key)
    if (hit) return hit
  }
  loading.value = true
  error.value = ''
  try {
    const res = await apiGet<DirListing>(`/api/files?hostId=${hostId}&path=${encodeURIComponent(path)}`)
    cache.set(key, res)
    lastPath.set(hostId, res.path)
    return res
  } catch (err) {
    appLog.w(TAG, `list ${path} failed`, String(err))
    error.value = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    loading.value = false
  }
}

export async function readFile(hostId: number, path: string): Promise<FileContent> {
  return apiGet<FileContent>(`/api/files/content?hostId=${hostId}&path=${encodeURIComponent(path)}`)
}

export function downloadUrl(hostId: number, path: string): string {
  return `/api/files/download?hostId=${hostId}&path=${encodeURIComponent(path)}`
}

export function rememberedPath(hostId: number): string {
  return lastPath.get(hostId) ?? '.'
}

export function forgetCache(hostId?: number) {
  if (hostId === undefined) {
    cache.clear()
    return
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${hostId}:`)) cache.delete(key)
  }
}

/** Human-readable byte size. 1024-based: it is what `ls -h` shows. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function formatTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const pad = (n: number) => String(n).padStart(2, '0')
  return sameYear
    ? `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}

/**
 * Extensions whose files are never worth showing as text.
 *
 * An ALLOWLIST would be wrong here: SFTP carries no MIME type, so a file with
 * an unknown extension (.service, .repo, .timer) is usually still text, and
 * refusing it makes the preview useless. A denylist of formats that are
 * definitely binary fails in the safe direction — the preview says "binary"
 * instead of dumping megabytes of replacement characters into the DOM.
 */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'avif',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar',
  'mp3', 'mp4', 'm4a', 'wav', 'flac', 'ogg', 'webm', 'mkv', 'mov', 'avi',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'exe', 'dll', 'so', 'dylib', 'a', 'o', 'class', 'jar', 'wasm',
  'db', 'sqlite', 'sqlite3', 'pyc', 'bin', 'img', 'iso', 'dmg',
])

/**
 * Whether a file can be shown as text.
 *
 * Two signals, because neither alone is enough: the extension catches the
 * obvious binaries cheaply, and a NUL byte in the fetched prefix catches the
 * mislabelled ones (a `.log` full of binary, an extensionless database dump).
 */
export function looksTextual(name: string, content: string): boolean {
  if (content.includes('\u0000')) return false
  const dot = name.lastIndexOf('.')
  if (dot === -1) return true // Makefile, Dockerfile, LICENSE…
  return !BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

export function useFiles() {
  return { loading, error, listDir, readFile, formatSize, formatTime }
}
