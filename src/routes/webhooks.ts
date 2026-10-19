import { Elysia } from 'elysia'
import { jsonErr, jsonOk } from '../lib/json'
import { log } from '../lib/log'
import { metrics } from '../lib/metrics'
import { handleWebhook, verifySignature } from '../lib/webhook'

const logger = log('http')

/**
 * `POST /webhooks/github`: the only unauthenticated route. The body is read raw so the
 * HMAC (X-Hub-Signature-256) is checked over the exact bytes GitHub signed.
 */
export const webhooks = new Elysia({ name: 'webhooks' }).post(
  '/webhooks/github',
  async ({ request, set }) => {
    const raw = await request.text()
    const signature = request.headers.get('x-hub-signature-256') ?? undefined
    if (!(await verifySignature(raw, signature))) {
      metrics.webhooks.inc({ outcome: 'bad_signature' })
      logger.warn(`webhook rejected: bad signature (delivery ${request.headers.get('x-github-delivery') ?? '?'})`)
      const { body, status } = jsonErr('signature verification failed', 'unauthorized', 401)
      set.status = status
      return body
    }
    const outcome = await handleWebhook(request.headers.get('x-github-event') ?? undefined, raw)
    set.status = outcome.status
    return outcome.status < 400 ? jsonOk({}, outcome.message) : jsonErr(outcome.message, 'invalid', outcome.status).body
  },
  { parse: 'none' },
)
