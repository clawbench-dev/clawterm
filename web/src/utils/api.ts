import { appLog } from './appLog'

/**
 * Thin fetch wrapper around the same-origin API.
 *
 * Everything the UI does goes through here so that three cross-cutting
 * behaviours cannot be forgotten at a call site:
 *   1. A 401 flips the app back to the login screen (session expired / the
 *      password was changed on another device).
 *   2. The server's `{"error": "..."}` body becomes the thrown Error message,
 *      so callers show what actually failed instead of "HTTP 500".
 *   3. Transport failures (offline, server restarting) are distinguishable from
 *      HTTP errors — a distinction the UI needs to avoid shouting at the user
 *      when the phone briefly loses signal.
 */

export class ApiError extends Error {
  status: number
  code?: string
  details?: Record<string, unknown>

  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * True when the request never produced an HTTP response. `status` being a
 * number is the structural test: an ApiError means the server answered, so it
 * is a real error even if the message reads like a network problem (a proxy
 * can return 502 with "failed to fetch upstream").
 */
export function isTransportError(err: unknown): boolean {
  if (err instanceof ApiError) return false
  if (err instanceof TypeError) return true // fetch rejects with TypeError
  return err instanceof Error && /failed to fetch|networkerror|load failed/i.test(err.message)
}

type OnUnauthorized = () => void
let onUnauthorized: OnUnauthorized | null = null

/** Register the handler invoked once per 401 (App.vue wires this to logout). */
export function setUnauthorizedHandler(fn: OnUnauthorized | null) {
  onUnauthorized = fn
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: {},
  }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    appLog.w('Api', `${method} ${url} failed`, String(err))
    throw err
  }

  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized()
    throw new ApiError('not authenticated', 401, 'unauthorized')
  }

  if (res.status === 204) return undefined as T

  const text = await res.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      // A non-JSON body means a proxy or the Go mux answered (e.g. a plain
      // "404 page not found"). Surface the status, not a parse error.
      if (!res.ok) throw new ApiError(text.slice(0, 200) || res.statusText, res.status)
      throw new ApiError('unexpected non-JSON response', res.status)
    }
  }

  if (!res.ok) {
    const p = (payload ?? {}) as Record<string, unknown>
    const msg = typeof p.error === 'string' ? p.error : res.statusText
    const code = typeof p.code === 'string' ? p.code : undefined
    throw new ApiError(msg, res.status, code, p)
  }
  return payload as T
}

export const apiGet = <T>(url: string) => request<T>('GET', url)
export const apiPost = <T>(url: string, body?: unknown) => request<T>('POST', url, body)
export const apiPut = <T>(url: string, body?: unknown) => request<T>('PUT', url, body)
export const apiDelete = <T>(url: string) => request<T>('DELETE', url)
