import { EventEmitter } from 'node:events'

export type BusEvent = 'runner' | 'job' | 'event' | 'slot'

/** In-process change feed: emits 'runner' | 'job' | 'event' | 'slot' with the changed row. */
export const bus = new EventEmitter()
bus.setMaxListeners(100)
