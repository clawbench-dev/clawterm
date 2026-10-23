import { ref, computed } from 'vue'
import { apiGet, apiPost } from '@/utils/api'
import { appLog } from '@/utils/appLog'

/**
 * Auth state: whether the device password has been set, and whether this
 * browser session is unlocked.
 *
 * The password is a local gate, not a user account: it protects the stored
 * host credentials if the phone is picked up unlocked. It is verified on the
 * server so a client-side bypass does not reveal anything — every API route
 * checks the session cookie.
 */

export interface AuthStatus {
  authenticated: boolean
  needsSetup: boolean
  version: string
}

const status = ref<AuthStatus | null>(null)
const loading = ref(false)
const lastError = ref('')

const isAuthenticated = computed(() => status.value?.authenticated === true)
const needsSetup = computed(() => status.value?.needsSetup === true)

export async function refreshAuth(): Promise<void> {
  loading.value = true
  lastError.value = ''
  try {
    status.value = await apiGet<AuthStatus>('/api/auth/status')
  } catch (err) {
    appLog.w('Auth', 'status check failed', String(err))
    // An unreachable server must not look like "not authenticated": that would
    // bounce the user to a login form that cannot work either. Keep the
    // previous state and let the connection overlay explain the situation.
    lastError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

export async function login(password: string, isSetup = false): Promise<void> {
  lastError.value = ''
  await apiPost('/api/auth/login', { password, set: isSetup })
  await refreshAuth()
}

export async function logout(): Promise<void> {
  try {
    await apiPost('/api/auth/logout')
  } finally {
    status.value = { authenticated: false, needsSetup: false, version: status.value?.version ?? '' }
  }
}

export function useAuth() {
  return { status, loading, lastError, isAuthenticated, needsSetup, refreshAuth, login, logout }
}

/** Called by the API layer on any 401 (session expired or password changed). */
export function handleUnauthorized() {
  if (status.value) status.value = { ...status.value, authenticated: false }
  appLog.i('Auth', 'session expired')
}
