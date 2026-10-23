import { ref } from 'vue'
import { appLog } from '@/utils/appLog'
import * as api from '@/native/api'
import { on } from '@/native/bridge'
import type { ForwardRule } from '@/native/api'

export type { ForwardRule }

export interface ForwardView extends ForwardRule {
  hostName: string
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
    forwards.value = await api.listForwards() as ForwardView[]
    forwardsLoaded.value = true
  } catch (err) {
    appLog.w(TAG, 'load failed', String(err))
    throw err
  } finally {
    forwardsLoading.value = false
  }
}

export async function startForward(p: {
  hostId: number
  localPort: number
  remoteHost: string
  remotePort: number
  autoStart: boolean
}): Promise<void> {
  await api.startForward(p)
  await loadForwards(true)
}

export async function stopForward(localPort: number): Promise<void> {
  await api.stopForward(localPort)
  await loadForwards(true)
}

export function useForwards() {
  return { forwards, loading: forwardsLoading, loaded: forwardsLoaded, loadForwards, startForward, stopForward }
}

/** Count of running forwards, for the dock badge. */
export function runningForwardCount(): number {
  return forwards.value.filter((f) => f.running).length
}

/**
 * Keep the list live while the forwards tab is open.
 *
 * A forward accepts connections in the background; without this the connection
 * counter and any error would only appear on a manual refresh. The listener is
 * installed once for the app's lifetime (the store is a module singleton), so a
 * tab switch does not miss events.
 */
let installed = false
export function installForwardEvents() {
  if (installed) return
  installed = true
  on('forward.status', (payload) => {
    const localPort = Number(payload.localPort)
    if (!Number.isFinite(localPort)) return
    forwards.value = forwards.value.map((f) => (
      f.localPort === localPort
        ? {
          ...f,
          running: payload.running === true,
          connections: Number(payload.connections ?? f.connections),
          error: typeof payload.error === 'string' ? payload.error : f.error,
        }
        : f
    ))
  })
}
