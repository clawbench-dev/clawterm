import { ref, computed } from 'vue'
import { appLog } from '@/utils/appLog'
import * as api from '@/native/api'

/**
 * Auth state: whether the device password has been set, and whether this
 * session is unlocked.
 *
 * The password is a LOCAL gate, not an account. It protects the stored host
 * credentials if the phone is picked up unlocked. Verification happens in the
 * native layer (the only place that can read the stored hash), so a script in
 * the WebView cannot bypass it by calling a different API.
 */

export type AuthStatus = api.AuthStatus

const status = ref<AuthStatus | null>(null)
const loading = ref(false)
const lastError = ref('')

const isAuthenticated = computed(() => status.value?.authenticated === true)
const needsSetup = computed(() => status.value?.needsSetup === true)

export async function refreshAuth(): Promise<void> {
  loading.value = true
  lastError.value = ''
  try {
    status.value = await api.authStatus()
  } catch (err) {
    appLog.w('Auth', 'status check failed', String(err))
    // A broken bridge must not look like "not authenticated": that would bounce
    // the user to a login form that cannot work either.
    lastError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

/**
 * First-run setup or a normal unlock.
 *
 * The caller does not choose: the native side knows whether a password exists,
 * so `verify` and `setup` are distinct calls and a first-run `verify` fails with
 * `needs_setup` instead of silently setting the password from the login form.
 */
export async function login(password: string): Promise<void> {
  lastError.value = ''
  if (status.value?.needsSetup) await api.authSetup(password)
  else await api.authVerify(password)
  await refreshAuth()
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await api.authChange(oldPassword, newPassword)
}

export async function logout(): Promise<void> {
  try {
    await api.authLock()
  } finally {
    status.value = { authenticated: false, needsSetup: false }
  }
}

export function useAuth() {
  return { status, loading, lastError, isAuthenticated, needsSetup, refreshAuth, login, changePassword, logout }
}
