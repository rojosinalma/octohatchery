import { EventEmitter } from 'node:events'
import type { LogLine } from './types'

export type BusEvent = 'runner' | 'job' | 'event' | 'slot' | 'log' | 'image'

/** Payload of the `image` event: a host's inventory or a pull for one reference on it changed. */
export type ImageEvent = { host: string; reference?: string; status?: string }

/** Payload of the `log` event: a batch of stored lines, or `done` once the job's log is final. */
export type LogEvent = { jobId: number; lines: LogLine[]; done?: boolean; replaced?: boolean }

/** In-process change feed: emits 'runner' | 'job' | 'event' | 'slot' with the changed row, 'log' with a LogEvent, 'image' with an ImageEvent. */
export const bus = new EventEmitter()
bus.setMaxListeners(100)
