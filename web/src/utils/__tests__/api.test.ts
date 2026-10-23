import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiGet, isTransportError, setUnauthorizedHandler } from '../api'

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  setUnauthorizedHandler(null)
  vi.unstubAllGlobals()
})

describe('apiGet', () => {
  it('parses a JSON body', async () => {
    mockFetch(async () => json(200, [{ id: 1 }]))
    await expect(apiGet('/api/hosts')).resolves.toEqual([{ id: 1 }])
  })

  // 204 has no body; parsing it would throw on an empty string.
  it('returns undefined for 204', async () => {
    mockFetch(async () => new Response(null, { status: 204 }))
    await expect(apiGet('/api/x')).resolves.toBeUndefined()
  })

  // The server's `{"error": ...}` message is what the user should see, not
  // "HTTP 500".
  it('surfaces the server error message', async () => {
    mockFetch(async () => json(400, { error: 'name is required' }))
    await expect(apiGet('/api/hosts')).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      message: 'name is required',
    })
  })

  it('carries a stable error code when the server sends one', async () => {
    mockFetch(async () => json(502, { error: 'refused', code: 'connection_refused' }))
    const err = await apiGet('/api/x').catch((e) => e as ApiError)
    expect(err.code).toBe('connection_refused')
    expect(err.details).toMatchObject({ code: 'connection_refused' })
  })

  // A non-JSON error body comes from the Go mux or a proxy; reporting the
  // status beats reporting a JSON parse failure.
  it('handles a non-JSON error body', async () => {
    mockFetch(async () => new Response('404 page not found', { status: 404 }))
    const err = await apiGet('/api/x').catch((e) => e as ApiError)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(404)
    expect(err.message).toContain('404')
  })

  // 401 must call the handler so the app can return to the login screen; it
  // must also throw, or the caller would treat the empty body as success.
  it('notifies the unauthorized handler and throws on 401', async () => {
    const onUnauth = vi.fn()
    setUnauthorizedHandler(onUnauth)
    mockFetch(async () => json(401, { error: 'not authenticated' }))

    await expect(apiGet('/api/hosts')).rejects.toMatchObject({ status: 401 })
    expect(onUnauth).toHaveBeenCalledTimes(1)
  })
})

describe('isTransportError', () => {
  // The structural test: an ApiError means the server ANSWERED, so it is never a
  // transport failure even if its text reads like one (a proxy can return 502
  // with "failed to fetch upstream" in the body).
  it('is false for an ApiError even with network-ish wording', () => {
    expect(isTransportError(new ApiError('failed to fetch upstream', 502))).toBe(false)
  })

  it('is true for a TypeError from fetch', () => {
    expect(isTransportError(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('is true for a load-failure message', () => {
    expect(isTransportError(new Error('NetworkError when attempting to fetch resource.'))).toBe(true)
  })

  it('is false for an ordinary error', () => {
    expect(isTransportError(new Error('bad input'))).toBe(false)
  })
})
