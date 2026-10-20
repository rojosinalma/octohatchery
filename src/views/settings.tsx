import { Icon, e } from './parts'

export type SettingsData = { settings: Record<string, string>; version: string }

type Control =
  | { kind: 'duration'; scale?: number }
  | { kind: 'number'; min?: number; unit?: string }
  | { kind: 'select'; options: { value: string; label: string; help: string }[] }
  | { kind: 'text'; placeholder?: string }

type Spec = { key: string; label: string; help: string; tone?: 'accent' | 'info' | 'danger'; control: Control; default: string }

type Group = { id: string; title: string; icon: string; items: Spec[] }

/** Settings known to the scheduler and stream; keys and defaults follow the project rules. Unknown keys render as text rows under "Other". */
export const SETTING_GROUPS: Group[] = [
  {
    id: 'scheduler',
    title: 'Scheduler',
    icon: 'bi-cpu',
    items: [
      {
        key: 'poll_interval_s',
        label: 'Poll interval',
        help: 'How often the leader asks GitHub for queued jobs the webhook may have missed. Webhooks stay the fast path.',
        control: { kind: 'duration' },
        default: '300',
      },
      {
        key: 'scheduler_tick_s',
        label: 'Scheduler tick',
        help: 'How often each node looks for queued jobs it can claim and reaps finished runners.',
        control: { kind: 'duration' },
        default: '5',
      },
      {
        key: 'heartbeat_s',
        label: 'Host heartbeat',
        help: 'How often a node reports itself alive. A host silent for three heartbeats shows as offline.',
        control: { kind: 'duration' },
        default: '15',
      },
      {
        key: 'stale_runner_minutes',
        label: 'Stale runner timeout',
        help: 'A runner that has no job after this long is removed and deregistered.',
        control: { kind: 'duration', scale: 60 },
        default: '5',
      },
    ],
  },
  {
    id: 'retention',
    title: 'Retention',
    icon: 'bi-journal-text',
    items: [
      {
        key: 'retention_days',
        label: 'Keep history for',
        help: 'Finished jobs, exited runners and events older than this are purged by the leader.',
        control: { kind: 'number', min: 1, unit: 'days' },
        default: '30',
      },
    ],
  },
  {
    id: 'live',
    title: 'Live updates',
    icon: 'bi-lightning-charge',
    items: [
      {
        key: 'sse_max_clients',
        label: 'Max live connections',
        help: 'Open dashboards and agents listening on the event stream at the same time. Extra ones get 503.',
        control: { kind: 'number', min: 1, unit: 'clients' },
        default: '20',
      },
      {
        key: 'sse_idle_s',
        label: 'Idle disconnect',
        help: 'A stream with nothing to send for this long is closed; the dashboard reconnects on its own.',
        control: { kind: 'duration' },
        default: '300',
      },
    ],
  },
  {
    id: 'runners',
    title: 'Runners',
    icon: 'bi-hdd-rack',
    items: [
      {
        key: 'buildkit_host',
        label: 'BuildKit host',
        help: 'Injected into every runner as BUILDKIT_HOST so docker buildx builds go to the shared daemon instead of a socket.',
        tone: 'accent',
        control: { kind: 'text', placeholder: 'tcp://octohatchery-buildkitd:1234' },
        default: 'tcp://octohatchery-buildkitd:1234',
      },
    ],
  },
  {
    id: 'logging',
    title: 'Logging',
    icon: 'bi-info-circle',
    items: [
      {
        key: 'log_level',
        label: 'Log level',
        help: 'Applies to every subsystem within a few seconds; no restart.',
        control: {
          kind: 'select',
          options: [
            { value: 'debug', label: 'Debug', help: 'Every external call and decision' },
            { value: 'info', label: 'Info', help: 'Normal operation' },
            { value: 'warn', label: 'Warning', help: 'Only things that need a look' },
            { value: 'error', label: 'Error', help: 'Only failures' },
          ],
        },
        default: 'info',
      },
    ],
  },
]

/** Keys driven by the theme switcher, not shown as rows. */
export const THEME_KEYS = ['ui_skin', 'ui_palette', 'ui_mode']

const humanise = (key: string) => key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

const ControlFor = ({ spec, value }: { spec: Spec; value: string }) => {
  const id = `s-${spec.key}`
  const c = spec.control
  switch (c.kind) {
    case 'duration': {
      const seconds = Math.round((Number(value) || 0) * (c.scale ?? 1))
      return (
        <div class="t-input-group t-duration" data-setting={spec.key} data-value={String(seconds)} data-scale={c.scale ? String(c.scale) : undefined} data-size="sm">
          <input class="t-input" type="number" min="0" step="1" id={id} aria-label={spec.label} />
          <select class="t-select" aria-label="unit">
            <option value="1">s</option>
            <option value="60">min</option>
            <option value="3600">h</option>
          </select>
        </div>
      )
    }
    case 'number':
      return (
        <div class="t-input-group">
          <input class="t-input" data-size="sm" type="number" min={c.min !== undefined ? String(c.min) : undefined} step="1" id={id} data-setting={spec.key} value={value} />
          {c.unit ? <span class="t-input-addon">{c.unit}</span> : null}
        </div>
      )
    case 'select':
      return (
        <select class="t-select" data-size="sm" id={id} data-setting={spec.key}>
          {c.options.map((o) => (
            <option value={o.value} selected={o.value === value}>
              {`${o.label} — ${o.help}`}
            </option>
          ))}
        </select>
      )
    case 'text':
      return <input class="t-input" data-size="sm" id={id} data-setting={spec.key} value={value} placeholder={c.placeholder} />
  }
}

const Row = ({ spec, value }: { spec: Spec; value: string }) => (
  <div class="t-setting" data-key={spec.key}>
    <div class="t-setting-label">
      <label for={`s-${spec.key}`} safe>
        {spec.label}
      </label>
      <span class="t-help" data-tone={spec.tone ?? 'info'}>
        <button class="t-help-btn" type="button" aria-expanded="false" aria-label={`About ${spec.label}`}>
          {spec.tone === 'accent' ? '?' : spec.tone === 'danger' ? '!' : 'i'}
        </button>
        <div class="t-help-box" hidden>
          <p safe>{spec.help}</p>
          <p class="t-muted t-small">{e(`Default: ${spec.default}`)}</p>
        </div>
      </span>
    </div>
    <div class="t-setting-control">
      <ControlFor spec={spec} value={value} />
    </div>
    <span class="t-setting-state" aria-live="polite"></span>
  </div>
)

export const SettingsSide = () => (
  <nav class="t-sidebar" aria-label="Settings sections">
    <ul>
      <li class="t-sidebar-group">Settings</li>
      {SETTING_GROUPS.map((g) => (
        <li>
          <a class="t-sidebar-item" href={`#${g.id}`}>
            <Icon id={g.icon} />
            <span class="t-sidebar-item-name" safe>
              {g.title}
            </span>
          </a>
        </li>
      ))}
      <li>
        <a class="t-sidebar-item" href="#other">
          <Icon id="bi-gear" />
          <span class="t-sidebar-item-name">Other</span>
        </a>
      </li>
      <li class="t-sidebar-divider"></li>
      <li>
        <a class="t-sidebar-item" href="#appearance">
          <Icon id="bi-star-fill" />
          <span class="t-sidebar-item-name">Appearance</span>
        </a>
      </li>
    </ul>
  </nav>
)

export const SettingsPage = ({ settings, version }: SettingsData) => {
  const known = new Set([...SETTING_GROUPS.flatMap((g) => g.items.map((i) => i.key)), ...THEME_KEYS])
  const other = Object.keys(settings)
    .filter((k) => !known.has(k))
    .sort()
  return (
    <>
      <header class="t-page-header">
        <a class="t-page-back" href="/" aria-label="Back to overview">
          ←
        </a>
        <h1 class="t-page-title">Settings</h1>
        <span class="t-page-lead">Changes save as you leave a field and apply within seconds.</span>
      </header>
      <div class="t-settings t-stack" data-gap="4" id="settings">
        {SETTING_GROUPS.map((g) => (
          <section class="t-section" id={g.id}>
            <h2 class="t-section-title" safe>
              {g.title}
            </h2>
            <div class="t-section-body">
              {g.items.map((spec) => (
                <Row spec={spec} value={settings[spec.key] ?? spec.default} />
              ))}
            </div>
          </section>
        ))}
        <section class="t-section" id="other">
          <h2 class="t-section-title">Other</h2>
          <div class="t-section-body">
            {other.length === 0 ? (
              <p class="t-muted t-small">No other settings are stored.</p>
            ) : (
              other.map((k) => <Row spec={{ key: k, label: humanise(k), help: 'Stored by the API or an agent; not known to this dashboard.', control: { kind: 'text' }, default: '' }} value={settings[k] ?? ''} />)
            )}
          </div>
        </section>
      <section class="t-section" id="appearance">
        <h2 class="t-section-title">Appearance</h2>
        <div class="t-section-body">
          <div class="t-setting" data-key="ui_theme">
            <div class="t-setting-label">
              <span id="theme-label">Skin and palette</span>
              <span class="t-help" data-tone="info">
                <button class="t-help-btn" type="button" aria-expanded="false" aria-label="About skin and palette">
                  i
                </button>
                <div class="t-help-box" hidden>
                  <p>Stored as settings and shared by every browser that opens this dashboard. The sun/moon toggle in the footer switches between dark and light.</p>
                </div>
              </span>
            </div>
            <div class="t-setting-control" aria-labelledby="theme-label">
              <div data-tailor-pickers="skin palette"></div>
            </div>
          </div>
        </div>
      </section>
      <section class="t-section" id="about">
        <h2 class="t-section-title">About</h2>
        <div class="t-section-body">
          <dl class="t-facts">
            <dt>Version</dt>
            <dd class="t-mono" safe>
              {version}
            </dd>
            <dt>Source</dt>
            <dd>
              <a href="https://github.com/rojosinalma/octohatchery" target="_blank" rel="noopener">
                github.com/rojosinalma/octohatchery
              </a>
            </dd>
          </dl>
        </div>
      </section>
      </div>
    </>
  )
}
