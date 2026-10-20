import { backend } from './backends'
import { bus, type ImageEvent } from './bus'
import { config } from './config'
import { recordEvent } from './events'
import { log } from './log'
import { SETTING_DEFAULTS, settings } from './settings'
import { DIND_IMAGE } from './spawn'
import { claimImagePull, failStrandedImagePulls, finishImagePull, listRunnerTypes, syncHostImages } from './store'
import type { ImagePull } from './types'

const logger = log('docker')

/**
 * Every image reference this instance cares about, each once, sorted: the image of every template, the default
 * runner image and the Docker-in-Docker sidecar. The matrix on Templates → Images has one row per entry.
 */
export async function wantedImages(): Promise<string[]> {
  const types = await listRunnerTypes()
  const def = await settings.fetch('runner_image_default', SETTING_DEFAULTS['runner_image_default']!)
  return [...new Set([...types.map((t) => t.image), def, DIND_IMAGE])].filter(Boolean).sort()
}

function announce(ev: ImageEvent): void {
  bus.emit('image', ev)
}

/** Heartbeat step: what this node's engine has for the wanted references; announces a change on the bus. */
export async function reportImages(host = config().hostName): Promise<boolean> {
  const present = await backend().listImages()
  const changed = await syncHostImages(host, present, await wantedImages())
  if (changed) announce({ host })
  return changed
}

let inFlight: Promise<void> | undefined
let recovered = false

/**
 * Scheduler step: start the oldest queued pull for this host when none is running here. The pull itself runs in
 * the background so the tick keeps claiming jobs; its outcome lands in `image_pulls`, the inventory is refreshed
 * and both reach the dashboards through the bus. Returns the pull that was started, if any.
 */
export async function startImagePull(host = config().hostName): Promise<ImagePull | undefined> {
  if (!recovered) {
    recovered = true
    for (const p of await failStrandedImagePulls(host, 'node restarted during the pull')) announce({ host, reference: p.reference, status: p.status })
  }
  if (inFlight) return undefined
  const pull = await claimImagePull(host)
  if (!pull) return undefined
  announce({ host, reference: pull.reference, status: pull.status })
  inFlight = runPull(pull).finally(() => (inFlight = undefined))
  return pull
}

/** Tests: wait for the pull in progress (if any) to record its outcome. */
export async function awaitImagePull(): Promise<void> {
  await inFlight
}

/** Tests: forget the per-process state between worlds. */
export function resetImagePulls(): void {
  inFlight = undefined
  recovered = false
}

async function runPull(pull: ImagePull): Promise<void> {
  const target = `${pull.reference} on ${pull.host}`
  let outcome: { status: 'done' | 'failed'; error?: string }
  try {
    await backend().pull(pull.reference)
    outcome = { status: 'done' }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn(`pull ${target} failed: ${error}`)
    outcome = { status: 'failed', error }
  }
  try {
    await reportImages(pull.host)
  } catch (err) {
    logger.warn(`image inventory after pull ${target} failed`, err instanceof Error ? err.message : String(err))
  }
  const finished = await finishImagePull(pull.id, outcome)
  await recordEvent('scheduler', outcome.status === 'done' ? 'image.pulled' : 'image.pull_failed', target, { requestedBy: pull.requestedBy, ...(outcome.error ? { error: outcome.error } : {}) })
  announce({ host: pull.host, reference: pull.reference, status: finished?.status ?? outcome.status })
}
