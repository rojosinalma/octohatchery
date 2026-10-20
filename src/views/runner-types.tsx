import type { Host, RunnerDocker, RunnerType, Slot } from '../lib/types'
import { Empty, Icon } from './parts'

export type RunnerTypesData = { types: RunnerType[]; hosts: Host[]; slots: Slot[] }

const TypesTable = ({ types }: { types: RunnerType[] }) => {
  if (types.length === 0) {
    return (
      <Empty icon="bi-cpu" title="No runner types" text="A runner type is the image, labels and resource caps a runner starts with. Create the first one.">
        <button class="t-btn" data-variant="primary" data-action="type-new">
          <Icon id="bi-plus-lg" /> New runner type
        </button>
      </Empty>
    )
  }
  return (
    <div class="t-table-wrap">
      <table class="t-table" data-variant="data" data-density="compact" id="types-table">
        <thead>
          <tr>
            <th data-sort="name">
              <button>
                Name <span class="t-sort-icon"></span>
              </button>
            </th>
            <th>Labels</th>
            <th>Image</th>
            <th class="t-col-num">CPUs</th>
            <th class="t-col-num">Memory</th>
            <th>Docker</th>
            <th class="t-col-num">Environment</th>
            <th class="t-col-num">Mounts</th>
            <th>Secrets</th>
            <th class="t-col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {types.map((t) => (
            <tr data-name={t.name}>
              <td>
                <span class="t-mono" safe>
                  {t.name}
                </span>
                {t.description ? (
                  <div class="t-muted t-small" safe>
                    {t.description}
                  </div>
                ) : null}
              </td>
              <td>
                <span class="t-badge" data-tone="neutral" data-variant="outline" data-size="xs">
                  self-hosted
                </span>
                <span class="t-badge" data-tone="accent" data-variant="outline" data-size="xs" safe>
                  {t.name}
                </span>
                {t.labels.map((l) => (
                  <span class="t-badge" data-tone="neutral" data-variant="outline" data-size="xs" safe>
                    {l}
                  </span>
                ))}
              </td>
              <td class="t-mono t-small" safe>
                {t.image}
              </td>
              <td class="t-col-num">{String(t.cpus)}</td>
              <td class="t-col-num">{`${t.memoryMb} MB`}</td>
              <td>
                <DockerBadge docker={t.docker} />
              </td>
              <td class="t-col-num">
                {Object.keys(t.env).length ? (
                  <span data-tip={Object.keys(t.env).join(', ')}>{String(Object.keys(t.env).length)}</span>
                ) : (
                  <span class="t-muted">0</span>
                )}
              </td>
              <td class="t-col-num">
                {t.mounts.length ? <span data-tip={t.mounts.join(', ')}>{String(t.mounts.length)}</span> : <span class="t-muted">0</span>}
              </td>
              <td>
                {t.secretEnv.map((name) => (
                  <span class="t-badge" data-tone="warning" data-variant="outline" data-size="xs" data-tip="Read from the node's environment at spawn time" safe>
                    {name}
                  </span>
                ))}
              </td>
              <td class="t-col-actions">
                <div class="t-cluster row-actions" data-gap="1">
                  <button class="t-btn" data-size="sm" data-variant="ghost" data-icon="only" data-tip="Edit" data-action="type-edit" data-type={JSON.stringify(t)}>
                    <Icon id="bi-pencil" />
                  </button>
                  <button class="t-btn" data-size="sm" data-variant="ghost" data-tone="danger" data-icon="only" data-tip="Delete" data-action="type-delete" data-name={t.name}>
                    <Icon id="bi-trash" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const SlotsMatrix = ({ types, hosts, slots }: RunnerTypesData) => {
  if (types.length === 0 || hosts.length === 0) {
    return (
      <Empty
        icon="bi-hdd-rack"
        title={hosts.length === 0 ? 'No hosts yet' : 'No runner types yet'}
        text={hosts.length === 0 ? 'A node registers itself on boot. Slots are set per host once one is online.' : 'Create a runner type to give it slots on a host.'}
      />
    )
  }
  const find = (type: string, host: string) => slots.find((s) => s.type === type && s.host === host)
  return (
    <div class="t-table-wrap">
      <table class="t-table" data-variant="data" data-density="compact" id="slots-matrix">
        <thead>
          <tr>
            <th>Type</th>
            {hosts.map((h) => (
              <th>
                <span class="t-dot" data-status={h.status === 'online' ? 'running' : 'stopped'} data-tip={h.status}></span> <span safe>{h.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {types.map((t) => (
            <tr data-type={t.name}>
              <td class="t-mono" safe>
                {t.name}
              </td>
              {hosts.map((h) => {
                const s = find(t.name, h.name)
                const id = `slot-${t.name}-${h.name}`.replace(/[^a-zA-Z0-9_-]/g, '_')
                return (
                  <td>
                    <div class="t-cluster slot-cell" data-gap="1" data-align="center">
                      <label class="t-visually-hidden" for={id}>{`Slots for ${t.name} on ${h.name}`}</label>
                      <input
                        class="t-input"
                        data-size="sm"
                        data-width="auto"
                        type="number"
                        min="0"
                        step="1"
                        id={id}
                        value={String(s?.count ?? 0)}
                        data-slot-type={t.name}
                        data-slot-host={h.name}
                        data-last={String(s?.count ?? 0)}
                      />
                      <span class="t-small t-muted t-nowrap" data-tip="used / free">{`${s?.used ?? 0} / ${s?.free ?? 0}`}</span>
                      <button
                        class="t-btn"
                        data-size="sm"
                        data-variant="ghost"
                        data-icon="only"
                        data-tip={`Spawn ${t.name} on ${h.name}`}
                        data-action="spawn"
                        data-type={t.name}
                        data-host={h.name}
                        disabled={h.status !== 'online'}
                      >
                        <Icon id="bi-play-fill" />
                      </button>
                    </div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The three Docker options with their trade-off, in the order they appear in the dialog. */
export const DOCKER_OPTIONS: { value: RunnerDocker; label: string; badge: string; tone: string; desc: JSX.Element }[] = [
  {
    value: 'none',
    label: 'None',
    badge: 'none',
    tone: 'neutral',
    desc: (
      <>
        No daemon. Image builds go through the shared BuildKit; <code>services:</code> and <code>docker run</code> steps fail.
      </>
    ),
  },
  {
    value: 'socket',
    label: 'Host socket',
    badge: 'host socket',
    tone: 'warning',
    desc: (
      <>
        The runner uses this host's Docker. <code>services:</code>, <code>docker run</code> and Compose work; every job on this type sees and can control every container on the host.
      </>
    ),
  },
  {
    value: 'dind',
    label: 'Docker-in-Docker',
    badge: 'dind',
    tone: 'info',
    desc: <>A private Docker daemon starts next to each runner (privileged sidecar) and dies with it. Isolated, about 5 s slower to start, no shared image cache.</>,
  },
]

export const DockerBadge = ({ docker }: { docker: RunnerDocker }) => {
  const o = DOCKER_OPTIONS.find((x) => x.value === docker) ?? DOCKER_OPTIONS[0]!
  return (
    <span class="t-badge" data-tone={o.tone} data-tip={o.label} safe>
      {o.badge}
    </span>
  )
}

const TypeDialog = () => (
  <dialog class="t-dialog" id="type-dlg" data-size="lg" aria-labelledby="type-dlg-title">
    <form id="type-form" data-action="type-save">
      <div class="t-dialog-header">
        <h2 class="t-dialog-title" id="type-dlg-title">
          Runner type
        </h2>
        <button class="t-dialog-close" type="button" aria-label="Close" data-dialog-close>
          ×
        </button>
      </div>
      <div class="t-dialog-body t-grid" data-cols="12" data-gap="3">
        <div class="t-field" data-span="4">
          <label class="t-label" for="tf-name">
            Name
          </label>
          <input class="t-input" id="tf-name" name="name" required pattern="[a-z0-9][a-z0-9-]*" placeholder="generic" />
          <p class="t-hint">Also a label on every runner of this type. Lowercase, digits, dashes.</p>
        </div>
        <div class="t-field" data-span="8">
          <label class="t-label" for="tf-description">
            Description
          </label>
          <input class="t-input" id="tf-description" name="description" placeholder="What this type is for" />
        </div>
        <div class="t-field" data-span="12">
          <label class="t-label" for="tf-image">
            Image
          </label>
          <input class="t-input" id="tf-image" name="image" required placeholder="ghcr.io/rojosinalma/octohatchery-runner:latest" />
          <p class="t-hint">Must contain the GitHub Actions runner and start it from <code>RUNNER_JITCONFIG</code>.</p>
        </div>
        <div class="t-field" data-span="6">
          <label class="t-label" for="tf-labels-entry">
            Labels
          </label>
          <div class="chip-input" id="tf-labels-chips" data-chips-for="tf-labels">
            <span class="t-badge" data-tone="neutral" data-variant="outline" data-fixed data-tip="Always added by OctoHatchery">
              self-hosted
            </span>
            <span class="t-badge" data-tone="accent" data-variant="outline" data-fixed data-tip="Always added by OctoHatchery" id="tf-labels-type">
              type
            </span>
            <span class="t-badge chip-example" data-tone="neutral" data-variant="outline" data-fixed data-tip="Always added by OctoHatchery: the name of the host the runner starts on" id="tf-labels-host">
              host
            </span>
            <input class="chip-entry" id="tf-labels-entry" placeholder="Add a label…" autocomplete="off" aria-describedby="tf-labels-hint" />
          </div>
          <input type="hidden" id="tf-labels" name="labels" />
          <p class="t-hint" id="tf-labels-hint">
            Enter, comma or space adds a label; × removes it. Lowercase letters, digits, <code>-</code> or <code>_</code>.
          </p>
        </div>
        <div class="t-field" data-span="3">
          <label class="t-label" for="tf-cpus">
            CPUs
          </label>
          <input class="t-input" id="tf-cpus" name="cpus" type="number" min="0.1" step="0.1" required value="2" />
        </div>
        <div class="t-field" data-span="3">
          <label class="t-label" for="tf-memory">
            Memory (MB)
          </label>
          <input class="t-input" id="tf-memory" name="memoryMb" type="number" min="128" step="128" required value="4096" />
        </div>
        <div class="t-field" data-span="6">
          <label class="t-label" for="tf-env">
            Environment
          </label>
          <textarea class="t-textarea" id="tf-env" name="env" rows="4" placeholder="NODE_OPTIONS=--max-old-space-size=4096"></textarea>
          <p class="t-hint">
            One <code>KEY=value</code> per line. Plain values only; stored in the database.
          </p>
        </div>
        <div class="t-field" data-span="6">
          <label class="t-label" for="tf-mounts">
            Mounts
          </label>
          <textarea class="t-textarea" id="tf-mounts" name="mounts" rows="4" placeholder="/srv/cache:/cache:ro"></textarea>
          <p class="t-hint">
            One <code>src:dst[:ro]</code> per line. The tool cache volume is mounted on every runner anyway.
          </p>
        </div>
        <div class="t-field" data-span="12">
          <label class="t-label" for="tf-secrets">
            Secret environment names
          </label>
          <input class="t-input" id="tf-secrets" name="secretEnv" placeholder="DEPLOY_TOKEN, NPM_TOKEN" />
          <p class="t-hint">Comma-separated variable names. Values are read from the node's own environment at spawn time and never stored.</p>
        </div>
        <fieldset class="t-check-group docker-options" data-span="12">
          <legend class="t-label">Docker</legend>
          <div class="t-grid" data-cols="3" data-min="sm">
            {DOCKER_OPTIONS.map((o) => (
              <label class="t-check docker-option" data-docker={o.value}>
                <input class="t-check-input" type="radio" name="docker" value={o.value} checked={o.value === 'none'} />
                <span class="t-check-label">
                  {o.label}
                  <span class="t-check-desc">{o.desc}</span>
                </span>
              </label>
            ))}
          </div>
          <p class="t-hint">
            What a job can do with <code>docker</code>. GitHub's <code>services:</code> containers need a daemon the runner can reach: host socket or Docker-in-Docker.
          </p>
        </fieldset>
      </div>
      <div class="t-dialog-footer">
        <button class="t-btn" type="button" data-dialog-close>
          Cancel
        </button>
        <button class="t-btn" data-variant="primary" type="submit">
          Save
        </button>
      </div>
    </form>
  </dialog>
)

export const RunnerTypesPage = (data: RunnerTypesData) => (
  <>
    <header class="t-page-header">
      <h1 class="t-page-title">Runner types</h1>
      <span class="t-page-lead">What a runner is made of, and how many may run per host.</span>
      <div class="t-page-actions">
        <button class="t-btn" data-variant="primary" data-size="sm" data-action="type-new">
          <Icon id="bi-plus-lg" /> New runner type
        </button>
      </div>
    </header>
    <div class="t-stack" data-gap="4">
      <section class="t-section">
        <h2 class="t-section-title">
          Types <span class="t-counter">{String(data.types.length)}</span>
        </h2>
        <div class="t-section-body">
          <TypesTable types={data.types} />
        </div>
      </section>
      <section class="t-section">
        <h2 class="t-section-title">
          Slots per host{' '}
          <span class="t-help" data-tone="info">
            <button class="t-help-btn" type="button" aria-expanded="false" aria-label="About slots">
              i
            </button>
            <div class="t-help-box" hidden>
              <p>A slot is one runner of that type allowed on that host at a time. Changes save when you leave the field. The play button starts a runner by hand; it still needs a free slot.</p>
            </div>
          </span>
        </h2>
        <div class="t-section-body">
          <SlotsMatrix {...data} />
        </div>
      </section>
    </div>
    <TypeDialog />
  </>
)
