export type JsonOk<T extends object = object> = { ok: true; message: string } & T
export type JsonErr = { ok: false; message: string; code: string }

/** `{ ok: true, message, ...data }` — the shape of every action response. */
export function jsonOk<T extends object = object>(data?: T, message = 'ok'): JsonOk<T> {
  return { ok: true, message, ...(data ?? ({} as T)) }
}

/** `{ ok: false, message, code }` plus the HTTP status the route should set. */
export function jsonErr(message: string, code = 'invalid', status = 400): { body: JsonErr; status: number } {
  return { body: { ok: false, message, code }, status }
}

/** Maps a ServiceError code to its HTTP status. */
export const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,
  invalid: 400,
  conflict: 409,
  unavailable: 503,
}

/**
 * One line naming what failed validation: `query per: Expected union value`. Elysia's `message` is a JSON blob
 * in production, so the first entry of `all` (path + summary) is the readable part.
 */
export function validationMessage(error: unknown): string {
  const e = error as { type?: string; all?: { path?: string; summary?: string; message?: string; schema?: { anyOf?: { const?: unknown }[] } }[]; message?: string }
  const first = e.all?.[0]
  if (first) {
    const where = [e.type, first.path?.replace(/^\//, '')].filter(Boolean).join(' ')
    const options = first.schema?.anyOf?.map((o) => o.const).filter((c) => c !== undefined)
    const what = options?.length ? `expected one of ${options.map(String).join(', ')}` : (first.summary ?? first.message ?? 'invalid value')
    return where ? `${where}: ${what}` : what
  }
  const line = e.message?.split('\n')[0]?.trim()
  return line && !line.startsWith('{') ? line : 'invalid request'
}
