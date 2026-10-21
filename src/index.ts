import { Elysia } from 'elysia'
import { db } from './db'
import { backend } from './lib/backends'
import { config, ConfigError } from './lib/config'
import { github } from './lib/github/auth'
import { githubCredential } from './lib/github/credential'
import { log } from './lib/log'
import { refreshGitHubCredential } from './lib/octoforge/github'
import { connectDatabase, resolveDatabase, type ResolvedDatabase } from './lib/octoforge/database'
import { startScheduler, stopScheduler } from './lib/scheduler'
import { electLeader, heartbeat, startSweep, stopSweep } from './lib/sweep'
import { mcp } from './mcp'
import { api } from './routes/api'
import { health } from './routes/health'
import { metrics } from './routes/metrics'
import { octoforge } from './routes/octoforge'
import { stream } from './routes/stream'
import { ui } from './routes/ui'
import { webhooks } from './routes/webhooks'

const logger = log('http')

async function main(): Promise<void> {
  let cfg
  let target: ResolvedDatabase
  try {
    cfg = config()
    target = resolveDatabase(cfg)
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`configuration error: ${err.message}\n`)
      process.exit(1)
    }
    throw err
  }

  await connectDatabase(target)
  const schema = db().schema ? `, schema ${db().schema}` : ''
  logger.info(`database ${target.url.replace(/\/\/[^@]*@/, '//***@')} ready (${cfg.mode} mode, host ${cfg.hostName}${schema}, from ${target.source === 'env' ? 'DATABASE_URL' : 'octoforge-database.json'})`)
  // A credential Octoforge delivered earlier (settings table) wins over the env one; the scheduler loop re-reads it.
  await refreshGitHubCredential()
  logger.info(`github auth: ${github().kind} from ${githubCredential().source}; container backend: ${backend().kind}`)
  await electLeader()
  await heartbeat()

  const app = new Elysia()
    .use(api)
    .use(octoforge)
    .use(health)
    .use(metrics)
    .use(webhooks)
    .use(stream)
    .use(mcp)
    .use(ui)
    .listen(cfg.port)

  logger.info(`listening on :${cfg.port}`)
  startScheduler()
  startSweep()

  const shutdown = async (signal: string) => {
    logger.info(`${signal}: shutting down`)
    stopScheduler()
    stopSweep()
    await app.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

void main()
