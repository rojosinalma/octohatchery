import { Counter, Gauge, Registry } from 'prom-client'
import { countJobs, countRunners, slotsView } from './store'
import { dbConnected } from '../db'

const JOB_STATUSES = ['queued', 'claimed', 'in_progress', 'completed', 'ignored'] as const
const RUNNER_STATES = ['spawning', 'idle', 'busy', 'exited', 'failed', 'removed'] as const

export const registry = new Registry()

/** Counters bumped by the scheduler, sweep and webhook; gauges refresh from the DB on each scrape. */
export const metrics = {
  registry,
  runnerSpawns: new Counter({ name: 'octohatchery_runner_spawns_total', help: 'Runners started', registers: [registry] }),
  runnerExits: new Counter({ name: 'octohatchery_runner_exits_total', help: 'Runners reaped after exit', registers: [registry] }),
  webhooks: new Counter({ name: 'octohatchery_webhooks_total', help: 'Webhook deliveries by outcome', labelNames: ['outcome'], registers: [registry] }),
  claimFailures: new Counter({ name: 'octohatchery_claim_failures_total', help: 'Claims that failed to spawn', registers: [registry] }),
  slots: new Gauge({
    name: 'octohatchery_slots',
    help: 'Slots by host, type and state',
    labelNames: ['host', 'type', 'state'],
    registers: [registry],
    async collect() {
      if (!dbConnected()) return
      this.reset()
      for (const s of await slotsView()) {
        this.set({ host: s.host, type: s.type, state: 'used' }, s.used)
        this.set({ host: s.host, type: s.type, state: 'free' }, s.free)
      }
    },
  }),
  jobs: new Gauge({
    name: 'octohatchery_jobs',
    help: 'Jobs by status',
    labelNames: ['status'],
    registers: [registry],
    async collect() {
      if (!dbConnected()) return
      for (const s of JOB_STATUSES) this.set({ status: s }, await countJobs(s))
    },
  }),
  runners: new Gauge({
    name: 'octohatchery_runners',
    help: 'Runners by state',
    labelNames: ['state'],
    registers: [registry],
    async collect() {
      if (!dbConnected()) return
      for (const s of RUNNER_STATES) this.set({ state: s }, await countRunners(s))
    },
  }),
}
