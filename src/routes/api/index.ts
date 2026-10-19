import { Elysia } from 'elysia'
import { jsonErr, STATUS_BY_CODE } from '../../lib/json'
import { log } from '../../lib/log'
import { ServiceError } from '../../lib/types'
import { events } from './events'
import { hosts } from './hosts'
import { jobs } from './jobs'
import { repos } from './repos'
import { runnerTypes } from './runner-types'
import { runners } from './runners'
import { settingsRoutes } from './settings'
import { slots } from './slots'

export { actorOf } from './actor'

const logger = log('http')

/** Maps ServiceError codes and validation failures to `{ok:false}` bodies; unexpected errors are logged with their stack. */
export const apiErrors = new Elysia({ name: 'api-errors' }).onError({ as: 'scoped' }, ({ error, code, set }) => {
  if (error instanceof ServiceError) {
    const { body, status } = jsonErr(error.message, error.code, STATUS_BY_CODE[error.code] ?? 400)
    set.status = status
    return body
  }
  if (code === 'VALIDATION') {
    const { body, status } = jsonErr(error.message.split('\n')[0] ?? 'invalid request', 'invalid', 400)
    set.status = status
    return body
  }
  logger.error('unhandled', error instanceof Error ? error : String(error))
  const { body, status } = jsonErr('internal error', 'internal', 500)
  set.status = status
  return body
})

export const api = new Elysia({ prefix: '/api' })
  .use(apiErrors)
  .use(hosts)
  .use(runnerTypes)
  .use(slots)
  .use(repos)
  .use(jobs)
  .use(runners)
  .use(events)
  .use(settingsRoutes)
