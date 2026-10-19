import type { Event } from '../lib/types'
import { Empty, RelTime, e } from './parts'

export type EventsData = { events: Event[] }

const actorTone = (actor: string) => (actor === 'user' ? 'accent' : actor.startsWith('mcp:') ? 'purple' : actor === 'webhook' ? 'info' : 'neutral')

const detail = (d: Record<string, unknown>) => {
  const entries = Object.entries(d)
  if (entries.length === 0) return <span class="t-muted">–</span>
  return (
    <span class="t-small t-mono">
      {entries.map(([k, v]) => (
        <span class="event-kv">
          <span class="t-muted" safe>
            {k}
          </span>
          =<span safe>{typeof v === 'string' ? v : JSON.stringify(v)}</span>
        </span>
      ))}
    </span>
  )
}

/** The table block: re-fetched by `app.js` on `event` events (`GET /events?partial=1`). */
export const EventsTable = ({ events }: EventsData) => {
  if (events.length === 0) {
    return (
      <div id="events-live" data-live="event">
        <Empty icon="bi-journal-text" title="No events yet" text="Every change made here, by an agent or by a webhook is recorded. Adopt a repo to see the first entry." />
      </div>
    )
  }
  return (
    <div id="events-live" data-live="event" class="t-table-wrap">
      <table class="t-table" data-variant="log" data-density="compact" id="events-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Target</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {events.map((ev) => (
            <tr data-event-id={String(ev.id)}>
              <td class="t-nowrap">
                <RelTime at={ev.at} />
              </td>
              <td>
                <span class="t-badge" data-tone={actorTone(ev.actor)} safe>
                  {ev.actor}
                </span>
              </td>
              <td class="t-mono" safe>
                {ev.action}
              </td>
              <td class="t-mono" safe>
                {ev.target}
              </td>
              <td>{detail(ev.detail)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export const EventsPage = (data: EventsData) => (
  <>
    <header class="t-page-header">
      <h1 class="t-page-title">Events</h1>
      <span class="t-page-lead">{e(`Audit trail: who did what, and when. ${data.events.length} entries in the retention window.`)}</span>
    </header>
    <EventsTable {...data} />
  </>
)
