import { EventEmitter } from 'node:events'
import type { LogLine } from './types'

export type BusEvent = 'runner' | 'job' | 'event' | 'slot' | 'log'

/** Payload of the `log` event: a batch of stored lines, or `done` once the job's log is final. */
export type LogEvent = { jobId: number; lines: LogLine[]; done?: boolean; replaced?: boolean }

/** In-process change feed: emits 'runner' | 'job' | 'event' | 'slot' with the changed row, and 'log' with a LogEvent. */
export const bus = new EventEmitter()
bus.setMaxListeners(100)
