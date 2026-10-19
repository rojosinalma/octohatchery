import { Elysia } from 'elysia'
import { connectDb } from './db'
import { backend } from './lib/backends'
import { config, ConfigError } from './lib/config'
import { github } from './lib/github/auth'
import { log } from './lib/log'
import { startScheduler, stopScheduler } from './lib/scheduler'
import { electLeader, heartbeat, startSweep, stopSweep } from './lib/sweep'
import { mcp } from './mcp'
import { api } from './routes/api'
import { health } from './routes/health'
import { metrics } from './routes/metrics'
import { stream } from './routes/stream'
import { ui } from './routes/ui'
import { webhooks } from './routes/webhooks'

const logger = log('http')

async function main(): Promise<void> {
  let cfg
  try {
    cfg = config()
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`configuration error: ${err.message}\n`)
      process.exit(1)
    }
    throw err
  }

  await connectDb(cfg.databaseUrl)
  logger.info(`database ${cfg.databaseUrl.replace(/\/\/[^@]*@/, '//***@')} ready (${cfg.mode} mode, host ${cfg.hostName})`)
  logger.info(`github auth: ${github().kind}; container backend: ${backend().kind}`)
  await electLeader()
  await heartbeat()

  const app = new Elysia()
    .use(api)
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
