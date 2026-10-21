import { createHash, timingSafeEqual } from 'node:crypto'
import { Elysia, t } from 'elysia'
import manifest from '../../octoforge.json'
import pkg from '../../package.json'
import { config, SCHEMA_NAME_PATTERN } from '../lib/config'
import { recordEvent } from '../lib/events'
import { githubCredential } from '../lib/github/credential'
import { jsonErr, jsonOk } from '../lib/json'
import { adoptDatabase, databaseStatus, dropAdoptedDatabase } from '../lib/octoforge/database'
import { deliverGitHub, dropGitHub, GitHubUnreachable } from '../lib/octoforge/github'
import { apiErrors } from './api'

const ACTOR = 'octoforge'
const PREFIX = '/api/octoforge'
const digest = (s: string) => createHash('sha256').update(s).digest()

/** Constant time: both sides are hashed first, so neither the token nor its length leaks through timing. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
  const same = timingSafeEqual(digest(m?.[1] ?? ''), digest(token))
  return m !== null && same
}

/** Accepts numeric ids as numbers or digit strings; stored as strings like the env values. */
const NumericId = t.Union([t.Integer({ minimum: 1 }), t.String({ pattern: '^[0-9]{1,20}$' })])

const GitHubBody = t.Union([
  t.Object({ mode: t.Literal('pat'), token: t.String({ minLength: 1, maxLength: 500 }) }),
  t.Object({
    mode: t.Literal('app'),
    app_id: NumericId,
    private_key: t.String({ minLength: 1, maxLength: 16_384 }),
    webhook_secret: t.String({ minLength: 1, maxLength: 256 }),
    installation_id: t.Optional(NumericId),
  }),
])

/**
 * Octoforge member API (contract v1): `/api/octoforge/*`. Without `OCTOFORGE_TOKEN` every route answers 404, as if
 * it did not exist; with it, every route except `GET /manifest` needs `Authorization: Bearer <OCTOFORGE_TOKEN>`.
 */
export const octoforge = new Elysia({ name: 'octoforge', prefix: '/api/octoforge' })
  .use(apiErrors)
  // onRequest runs before parsing and validation, so a disabled or unauthenticated call learns nothing about bodies.
  .onRequest(({ request, set }) => {
    const path = new URL(request.url).pathname
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return
    const token = config().octoforgeToken
    const refusal = !token
      ? jsonErr('not found', 'not_found', 404)
      : path === `${PREFIX}/manifest` || bearerMatches(request.headers.get('authorization') ?? undefined, token)
        ? undefined
        : jsonErr('missing or wrong bearer token', 'unauthorized', 401)
    if (!refusal) return
    set.status = refusal.status
    set.headers['content-type'] = 'application/json'
    return refusal.body
  })
  .get('/manifest', () => manifest)
  .get('/status', () => {
    const cred = githubCredential()
    const github = {
      mode: cred.mode,
      source: cred.source,
      ...(cred.mode === 'app' && cred.appId ? { app_id: Number(cred.appId) } : {}),
      ...(cred.login ? { login: cred.login } : {}),
    }
    const publicUrl = config().publicUrl
    return jsonOk({ contract: manifest.contract, version: pkg.version, ...(publicUrl ? { public_url: publicUrl } : {}), github, database: databaseStatus() })
  })
  .put(
    '/github',
    async ({ body, set }) => {
      try {
        const input = body.mode === 'pat' ? body : { ...body, app_id: String(body.app_id), installation_id: body.installation_id === undefined ? undefined : String(body.installation_id) }
        const who = await deliverGitHub(input)
        const message = who.login ? `token of ${who.login} stored and in use` : `GitHub App ${who.appSlug} stored and in use`
        return jsonOk({ ...(who.login ? { login: who.login } : { app_slug: who.appSlug }), restart_required: false }, message)
      } catch (err) {
        if (!(err instanceof GitHubUnreachable)) throw err
        const { body: out, status } = jsonErr(err.message, err.code, 502)
        set.status = status
        return out
      }
    },
    { body: GitHubBody },
  )
  .delete('/github', async () => {
    const { removed } = await dropGitHub()
    const cred = githubCredential()
    const back = cred.source === 'env' ? `the ${cred.mode} credential from the env` : 'no GitHub credential'
    return jsonOk({ removed, restart_required: false }, removed ? `delivered credential removed; using ${back}` : `no delivered credential; using ${back}`)
  })
  .post(
    '/database/adopt',
    async ({ body }) => {
      const copy = body.copy ?? true
      const { tables } = await adoptDatabase({ url: body.url, schema: body.schema, copy })
      await recordEvent(ACTOR, 'database.adopted', body.schema, { copy, tables })
      return jsonOk({ tables, restart_required: true }, `database adopted into schema ${body.schema}${copy ? ` (${Object.keys(tables).length} tables copied)` : ''}; restart to use it`)
    },
    {
      body: t.Object({
        url: t.String({ minLength: 1, maxLength: 2048 }),
        schema: t.String({ pattern: SCHEMA_NAME_PATTERN.source }),
        copy: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/database', async () => {
    const { removed } = await dropAdoptedDatabase()
    await recordEvent(ACTOR, 'database.dropped', 'database', { removed })
    return jsonOk({ removed, restart_required: true }, removed ? 'adopted database setting removed; restart to use DATABASE_URL again' : 'no adopted database setting')
  })
