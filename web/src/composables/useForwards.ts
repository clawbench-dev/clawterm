import { ref } from 'vue'
import { apiDelete, apiGet, apiPost } from '@/utils/api'
import { appLog } from '@/utils/appLog'

export interface ForwardView {
  id: number
  hostId: number
  hostName: string
  localPort: number
  remoteHost: string
  remotePort: number
  autoStart: boolean
  running: boolean
  error?: string
  connections: number
}

export const forwards = ref<ForwardView[]>([])
export const forwardsLoading = ref(false)
export const forwardsLoaded = ref(false)

const TAG = 'Forwards'

export async function loadForwards(force = false): Promise<void> {
  if (forwardsLoading.value) return
  if (forwardsLoaded.value && !force) return
  forwardsLoading.value = true
  try {
    forwards.value = await apiGet<ForwardView[]>('/api/forwards')
    forwardsLoaded.value = true
  } catch (err) {
    appLog.w(TAG, 'load failed', String(err))
    throw err
  } finally {
    forwardsLoading.value = false
  }
}

export interface ForwardPayload {
  hostId: number
  localPort: number
  remoteHost: string
  remotePort: number
  autoStart: boolean
}

export async function startForward(p: ForwardPayload): Promise<void> {
  await apiPost('/api/forwards', p)
  await loadForwards(true)
}

export async function stopForward(localPort: number): Promise<void> {
  await apiDelete(`/api/forwards?port=${localPort}`)
  await loadForwards(true)
}

export function useForwards() {
  return { forwards, loading: forwardsLoading, loaded: forwardsLoaded, loadForwards, startForward, stopForward }
}

/** Count of running forwards, for the dock badge. */
export function runningForwardCount(): number {
  return forwards.value.filter((f) => f.running).length
}
