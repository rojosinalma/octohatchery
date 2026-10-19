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
