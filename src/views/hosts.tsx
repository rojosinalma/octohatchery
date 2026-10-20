import type { Host, Slot } from '../lib/types'
import { Empty, Icon, RelTime, gb } from './parts'

export type HostsData = { hosts: Host[]; slots: Slot[] }

/** A spec the node has not reported yet. */
const Pending = () => (
  <span class="t-muted" data-tip="Reported by the node on its next heartbeat">
    –
  </span>
)

const HostsTable = ({ hosts, slots }: HostsData) => {
  const usage = (host: string) => {
    const mine = slots.filter((s) => s.host === host)
    return { used: mine.reduce((n, s) => n + s.used, 0), count: mine.reduce((n, s) => n + s.count, 0) }
  }
  return (
    <div class="t-table-wrap">
      <table class="t-table" data-variant="data" data-density="compact" id="hosts-table">
        <thead>
          <tr>
            <th data-sort="name">
              <button>
                Host <span class="t-sort-icon"></span>
              </button>
            </th>
            <th class="t-col-num">Slots</th>
            <th class="t-col-num" data-sort="cpus">
              <button>
                CPUs <span class="t-sort-icon"></span>
              </button>
            </th>
            <th class="t-col-num" data-sort="memory">
              <button>
                Memory <span class="t-sort-icon"></span>
              </button>
            </th>
            <th>OS</th>
            <th>Docker</th>
            <th>Docker version</th>
            <th>App version</th>
            <th data-sort="seen">
              <button>
                Last seen <span class="t-sort-icon"></span>
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {hosts.map((h) => {
            const u = usage(h.name)
            return (
              <tr id={h.name} data-name={h.name} data-cpus={String(h.cpus ?? -1)} data-memory={String(h.memoryMb ?? -1)} data-seen={h.lastSeenAt} data-tone={h.status === 'offline' ? 'danger' : undefined}>
                <td>
                  <span class="t-dot" data-status={h.status === 'online' ? (h.dockerOk ? 'running' : 'degraded') : 'stopped'} data-tip={h.status}></span>{' '}
                  <span class="t-mono" safe>
                    {h.name}
                  </span>
                  {h.isLeader ? (
                    <span
                      class="t-badge host-leader"
                      data-tone="accent"
                      data-size="xs"
                      data-tip="Leader: runs the cluster-wide chores (GitHub polling, stale-runner cleanup, retention purge, migrations). Another node takes over when it goes away."
                    >
                      <Icon id="bi-star-fill" size="xs" /> leader
                    </span>
                  ) : null}
                  {h.status === 'offline' ? (
                    <span class="t-badge host-leader" data-tone="danger" data-size="xs">
                      offline
                    </span>
                  ) : null}
                </td>
                <td class="t-col-num">
                  <a class="t-mono" href="/templates" data-tip="Used / total slots on this host; set them under Templates">{`${u.used}/${u.count}`}</a>
                </td>
                <td class="t-col-num">{h.cpus === null ? <Pending /> : String(h.cpus)}</td>
                <td class="t-col-num">{h.memoryMb === null ? <Pending /> : `${gb(h.memoryMb)} GB`}</td>
                <td>{h.os === null ? <Pending /> : <span safe>{h.os}</span>}</td>
                <td>
                  <span class="t-badge" data-tone={h.dockerOk ? 'success' : 'danger'}>
                    {h.dockerOk ? 'ok' : 'unreachable'}
                  </span>
                </td>
                <td>
                  {h.dockerVersion === null ? (
                    <Pending />
                  ) : (
                    <span class="t-mono t-small" safe>
                      {h.dockerVersion}
                    </span>
                  )}
                </td>
                <td>
                  {h.appVersion === null ? (
                    <Pending />
                  ) : (
                    <span class="t-badge t-mono" data-tone="neutral" data-variant="outline" safe>
                      {`v${h.appVersion}`}
                    </span>
                  )}
                </td>
                <td>
                  <RelTime at={h.lastSeenAt} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const ENV_SKELETON = [
  'MODE=cluster',
  'HOST_NAME=build-2                 # unique per host',
  'DATABASE_URL=postgres://user:pass@db:5432/octohatchery?sslmode=require',
  'GITHUB_AUTH=app                   # app | pat, the same on every host',
  'GITHUB_APP_ID=',
  'GITHUB_APP_PRIVATE_KEY=',
  'GITHUB_APP_INSTALLATION_ID=',
  'GITHUB_TOKEN=                     # pat mode only',
  'GITHUB_WEBHOOK_SECRET=',
  'PUBLIC_URL=https://octohatchery.example.com',
  'DOCKER_GID=999                    # stat -c %g /var/run/docker.sock',
].join('\n')

const AddHostDialog = () => (
  <dialog class="t-dialog" id="add-host-dlg" data-size="lg" aria-labelledby="add-host-title">
    <div class="t-dialog-header">
      <h2 class="t-dialog-title" id="add-host-title">
        <Icon id="bi-hdd-rack" /> <span>Add a host</span>
      </h2>
      <button class="t-dialog-close" aria-label="Close" data-dialog-close>
        ×
      </button>
    </div>
    <div class="t-dialog-body t-stack" data-gap="3">
      <p>
        There is nothing to fill in here: a host joins by running an OctoHatchery node. Start one on the new machine with the same <code>DATABASE_URL</code>{' '}
        (PostgreSQL, <code>MODE=cluster</code>), the same <code>GITHUB_*</code> credentials and <code>GITHUB_WEBHOOK_SECRET</code>, and its own <code>HOST_NAME</code>. The
        node registers itself on its first heartbeat and appears in this table; then give it slots under <a href="/templates">Templates</a>.
      </p>
      <ol class="t-stack" data-gap="1">
        <li>Clone the repository on the host and copy this skeleton to <code>.env</code> (mode 0600).</li>
        <li>
          Run <code>docker compose up -d</code>. The node takes its place in the cluster; the leader runs the migrations.
        </li>
        <li>Set slots per template for the new host.</li>
      </ol>
      <pre class="t-code-pre" data-variant="shell">
        <button class="t-code-copy" type="button" aria-label="Copy">
          <Icon id="bi-clipboard" />
        </button>
        {ENV_SKELETON}
      </pre>
      <p class="t-muted t-small">
        Full procedure, including the database and the proxy:{' '}
        <a href="https://github.com/rojosinalma/octohatchery/blob/main/docs/operations.md#cluster-mode" target="_blank" rel="noopener">
          Cluster mode in the operations guide <Icon id="bi-box-arrow-up-right" size="xs" />
        </a>
      </p>
    </div>
    <div class="t-dialog-footer">
      <button class="t-btn" data-dialog-close>
        Close
      </button>
    </div>
  </dialog>
)

export const HostsPage = ({ hosts, slots }: HostsData) => (
  <>
    <header class="t-page-header">
      <h1 class="t-page-title">Hosts</h1>
      <span class="t-page-lead">Every machine running an OctoHatchery node, with what it reports about itself.</span>
      <div class="t-page-actions">
        <button class="t-btn" data-variant="primary" data-size="sm" data-dialog-open="add-host-dlg">
          <Icon id="bi-plus-lg" /> Add a host
        </button>
      </div>
    </header>
    {hosts.length === 0 ? (
      <Empty icon="bi-hdd-rack" title="No hosts yet" text="A host appears here when an OctoHatchery node starts on it and sends its first heartbeat. Nothing is added by hand.">
        <button class="t-btn" data-variant="primary" data-dialog-open="add-host-dlg">
          <Icon id="bi-plus-lg" /> Add a host
        </button>
      </Empty>
    ) : (
      <HostsTable hosts={hosts} slots={slots} />
    )}
    <AddHostDialog />
  </>
)
