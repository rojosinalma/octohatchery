import { Html, type PropsWithChildren } from '@kitajs/html'

/** Escape untrusted text for HTML content. Attributes are escaped by the JSX runtime already. */
export const e = (value: unknown): string => Html.escapeHtml(String(value ?? ''))

/** Sprite icon: `<set>-<name>` ids as rendered by `tailor apply --icons`. */
export const Icon = ({ id, size }: { id: string; size?: 'xs' | 'sm' | 'lg' | 'xl' }) => (
  <svg class="t-icon" aria-hidden="true" data-size={size}>
    <use href={`/tailor/icons.svg#${id}`} />
  </svg>
)

const fmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
})

/** `<time>` upgraded client-side to a relative label; the absolute date stays in the markup. */
export const RelTime = ({ at }: { at: string | null }) => {
  if (!at) return <span class="t-muted">–</span>
  const date = new Date(at)
  const label = Number.isNaN(date.getTime()) ? e(at) : `${fmt.format(date)} UTC`
  return (
    <time class="t-time" data-relative datetime={at}>
      {label}
    </time>
  )
}

/** Memory as GB: one decimal under 10, whole numbers above. */
export const gb = (mb: number) => {
  const g = mb / 1024
  return g < 10 ? g.toFixed(1) : String(Math.round(g))
}

/** Bytes as a short size: `812 MB`, `1.2 GB`. */
export const bytes = (n: number) => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

export const Empty = ({ icon, title, text, children }: PropsWithChildren<{ icon: string; title: string; text: string }>) => (
  <div class="t-empty">
    <span class="t-icon t-empty-icon">
      <Icon id={icon} size="xl" />
    </span>
    <h3 class="t-empty-title" safe>
      {title}
    </h3>
    <p safe>{text}</p>
    {children ? <div class="t-empty-actions">{children}</div> : null}
  </div>
)

const runnerTone: Record<string, string> = {
  spawning: 'info',
  idle: 'accent',
  busy: 'success',
  exited: 'neutral',
  failed: 'danger',
  removed: 'neutral',
}

const jobTone: Record<string, string> = {
  queued: 'warning',
  claimed: 'info',
  in_progress: 'success',
  completed: 'neutral',
  ignored: 'neutral',
}

export const RunnerBadge = ({ state }: { state: string }) => (
  <span class="t-badge" data-tone={runnerTone[state] ?? 'neutral'} safe>
    {state}
  </span>
)

export const JobBadge = ({ status, conclusion }: { status: string; conclusion: string | null }) => {
  if (status === 'completed' && conclusion) {
    const tone = conclusion === 'success' ? 'success' : conclusion === 'cancelled' || conclusion === 'skipped' ? 'neutral' : 'danger'
    return (
      <span class="t-badge" data-tone={tone} safe>
        {conclusion}
      </span>
    )
  }
  return (
    <span class="t-badge" data-tone={jobTone[status] ?? 'neutral'} safe>
      {status.replace('_', ' ')}
    </span>
  )
}

/** Octopus mark drawn with tokens for the navbar brand (the standalone favicon carries literal hex). */
export const BrandMark = () => (
  <svg class="t-icon brand-mark" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 13v-3a6 6 0 0 1 12 0v3M6 13h12M6 13c-1 3-3 4-2 8M10 13c0 3-1 5 0 8M14 13c0 3 1 5 0 8M18 13c1 3 3 4 2 8M9 9h2" />
    <circle cx="14.5" cy="9" r="1.2" fill="var(--t-success)" stroke="none" />
  </svg>
)
