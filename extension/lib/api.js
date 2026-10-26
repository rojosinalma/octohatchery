// JSON client for the hatchery API. The dashboard has no login of its own: a reverse proxy with SSO sits in
// front, so requests carry the browser's cookies for that host and a redirect (to the proxy's login page)
// or an HTML reply means "signed out", not "down".

/**
 * @typedef {{ kind: 'ok', data: any }
 *   | { kind: 'signed_out', status: number }
 *   | { kind: 'down', message: string }
 *   | { kind: 'missing', message: string }
 *   | { kind: 'error', message: string }} ApiResult
 */

const TIMEOUT_MS = 15_000

/** @param {unknown} err */
const errText = (err) => (err instanceof Error ? (err.name === 'TimeoutError' ? 'no answer within 15 s' : err.message) : String(err))

/**
 * GET `base + path` as JSON.
 * @param {string} base hatchery origin
 * @param {string} path absolute path with query
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<ApiResult>}
 */
export async function getJson(base, path, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  /** @type {Response} */
  let res
  try {
    res = await fetchImpl(base + path, {
      credentials: 'include',
      redirect: 'manual',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return { kind: 'down', message: errText(err) }
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) {
    return { kind: 'signed_out', status: res.status }
  }
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('json')) {
    // A login page served with 200 (some proxies do this) is a sign-in prompt; a 502 page from the proxy is an outage.
    return res.ok ? { kind: 'signed_out', status: res.status } : { kind: 'down', message: `HTTP ${res.status}` }
  }
  let body
  try {
    body = await res.json()
  } catch {
    return { kind: 'down', message: 'the reply is not valid JSON' }
  }
  const message = typeof body?.message === 'string' ? body.message : `HTTP ${res.status}`
  if (res.status === 404) return { kind: 'missing', message }
  if (res.status >= 500) return { kind: 'down', message }
  if (!res.ok || body?.ok === false) return { kind: 'error', message }
  return { kind: 'ok', data: body }
}

/**
 * Checks that `base` is an OctoHatchery the browser can read: `/health` answers with a version and
 * `/api/jobs` answers too (the API can sit behind a stricter rule than the health check).
 * @param {string} base
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: true, version: string, host: string } | { ok: false, kind: ApiResult['kind'], message: string }>}
 */
export async function probe(base, opts = {}) {
  const health = await getJson(base, '/health', opts)
  if (health.kind === 'signed_out') return { ok: false, kind: 'signed_out', message: 'Signed out: open the hatchery in a tab, sign in, then test again' }
  if (health.kind === 'down') return { ok: false, kind: 'down', message: `No answer from ${base}: ${health.message}` }
  if (health.kind !== 'ok' || typeof health.data?.version !== 'string' || !Array.isArray(health.data?.slots)) {
    return { ok: false, kind: 'error', message: `${base} does not look like an OctoHatchery (no version in /health)` }
  }
  const jobs = await getJson(base, '/api/jobs?limit=1', opts)
  if (jobs.kind === 'signed_out') return { ok: false, kind: 'signed_out', message: 'The API asks for a sign-in: open the hatchery in a tab, sign in, then test again' }
  if (jobs.kind !== 'ok') return { ok: false, kind: jobs.kind, message: `The jobs API failed: ${jobs.message}` }
  return { ok: true, version: health.data.version, host: String(health.data.host ?? '') }
}
