import type { Host, HostImage, ImageInventory, ImagePull } from '../lib/types'
import { Empty, Icon, RelTime, bytes } from './parts'
import { TemplatesTabs } from './runner-types'

export type ImagesData = ImageInventory

const ACTIVE = new Set(['queued', 'running'])

/** `sha256:0123456789ab…` → `0123456789ab` for the cell; the full digest stays in the tooltip. */
const shortDigest = (digest: string) => digest.replace(/^sha256:/, '').slice(0, 12)

type Cell = { host: Host; reference: string; image?: HostImage; pull?: ImagePull }

const state = (c: Cell): 'pulling' | 'present' | 'missing' => (c.pull && ACTIVE.has(c.pull.status) ? 'pulling' : c.image ? 'present' : 'missing')

const PullButton = ({ host, reference, busy }: { host: Host; reference: string; busy: boolean }) => {
  const offline = host.status !== 'online'
  return (
    <button
      class="t-btn"
      data-size="sm"
      data-variant="ghost"
      data-icon="only"
      data-tip={offline ? `${host.name} is offline` : `Pull now on ${host.name}`}
      aria-label={`Pull ${reference} on ${host.name}`}
      data-action="image-pull"
      data-host={host.name}
      data-reference={reference}
      aria-busy={busy ? 'true' : undefined}
      disabled={busy || offline}
    >
      <Icon id="bi-arrow-repeat" />
    </button>
  )
}

const ImageCell = (c: Cell) => {
  const st = state(c)
  const failed = c.pull?.status === 'failed' && st === 'missing'
  return (
    <td data-host={c.host.name} data-state={st}>
      <div class="t-cluster image-cell" data-gap="1" data-align="center">
        {st === 'pulling' ? (
          <span class="t-badge" data-tone="info" data-tip={c.pull!.status === 'running' ? `Pulling on ${c.host.name} now` : `Queued; ${c.host.name} starts it on its next tick`}>
            <span class="t-spinner" data-size="sm" aria-hidden="true"></span> {c.pull!.status === 'running' ? 'pulling' : 'queued'}
          </span>
        ) : st === 'present' ? (
          <>
            <span class="t-badge" data-tone="success" data-tip={c.image!.digest ?? 'digest unknown'}>
              present
            </span>
            <span class="t-small t-muted t-nowrap image-meta">
              {c.image!.digest ? (
                <span class="t-mono" safe>
                  {shortDigest(c.image!.digest)}
                </span>
              ) : null}
              {c.image!.sizeBytes !== null ? <> · {bytes(c.image!.sizeBytes)}</> : null}
              {c.image!.pulledAt ? (
                <span data-tip="When the image was built (the engine does not record the pull time)">
                  {' · built '}
                  <RelTime at={c.image!.pulledAt} />
                </span>
              ) : null}
            </span>
          </>
        ) : (
          <>
            <span class="t-badge" data-tone="danger" data-tip="Not on this host; the first runner there pulls it before starting, which delays the job">
              missing
            </span>
            {failed ? (
              <span class="t-badge" data-tone="danger" data-variant="outline" data-tip={c.pull!.error ?? 'pull failed'}>
                last pull failed
              </span>
            ) : null}
          </>
        )}
        <PullButton host={c.host} reference={c.reference} busy={st === 'pulling'} />
      </div>
    </td>
  )
}

/** The live block: re-fetched whole by `app.js` on `image` events (`GET /templates/images?partial=1`). */
export const ImagesLive = ({ references, hosts, images, pulls }: ImagesData) => {
  if (hosts.length === 0 || references.length === 0) {
    return (
      <div id="images-live" data-live="image">
        <Empty
          icon={hosts.length === 0 ? 'bi-hdd-rack' : 'bi-layers'}
          title={hosts.length === 0 ? 'No hosts yet' : 'No images yet'}
          text={hosts.length === 0 ? 'A node registers itself on boot and reports the images its engine holds on every heartbeat.' : 'Images appear here from templates: every image a template uses, the default runner image and the Docker-in-Docker sidecar.'}
        >
          {hosts.length === 0 ? null : (
            <a class="t-btn" data-variant="primary" href="/templates">
              Templates
            </a>
          )}
        </Empty>
      </div>
    )
  }
  const image = (ref: string, host: string) => images.find((i) => i.reference === ref && i.host === host)
  const pull = (ref: string, host: string) => pulls.find((p) => p.reference === ref && p.host === host)
  return (
    <div id="images-live" data-live="image" class="t-table-wrap">
      <table class="t-table" data-variant="data" data-density="compact" id="images-table">
        <thead>
          <tr>
            <th>Image</th>
            {hosts.map((h) => (
              <th>
                <span class="t-dot" data-status={h.status === 'online' ? (h.dockerOk ? 'running' : 'degraded') : 'stopped'} data-tip={h.status}></span>{' '}
                <a href={`/hosts#${encodeURIComponent(h.name)}`} data-tip="Host details" safe>
                  {h.name}
                </a>
              </th>
            ))}
            <th class="t-col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {references.map((ref) => {
            const missingOn = hosts.filter((h) => !image(ref, h.name)).map((h) => h.name)
            const anyOnline = hosts.some((h) => h.status === 'online')
            return (
              <tr data-reference={ref} data-missing={String(missingOn.length)}>
                <td class="t-mono t-small" safe>
                  {ref}
                </td>
                {hosts.map((h) => (
                  <ImageCell host={h} reference={ref} image={image(ref, h.name)} pull={pull(ref, h.name)} />
                ))}
                <td class="t-col-actions">
                  <button
                    class="t-btn"
                    data-size="sm"
                    data-variant="ghost"
                    data-icon="only"
                    data-tip={anyOnline ? 'Pull on all hosts' : 'Every host is offline'}
                    aria-label={`Pull ${ref} on all hosts`}
                    data-action="image-pull-all"
                    data-reference={ref}
                    data-hosts={hosts.filter((h) => h.status === 'online').map((h) => h.name).join(',')}
                    disabled={!anyOnline}
                  >
                    <Icon id="bi-cloud-arrow-down" />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * "Add image": nothing is typed. The select offers the references the instance already wants (templates, default,
 * dind) that are missing on at least one host; adding one queues a pull on every host that lacks it.
 */
const AddImageDialog = ({ references, hosts, images }: ImagesData) => {
  const missing = references
    .map((ref) => ({ ref, hosts: hosts.filter((h) => h.status === 'online' && !images.some((i) => i.reference === ref && i.host === h.name)).map((h) => h.name) }))
    .filter((m) => m.hosts.length > 0)
  return (
    <dialog class="t-dialog" id="add-image-dlg" aria-labelledby="add-image-title">
      <form id="add-image-form" data-action="image-add">
        <div class="t-dialog-header">
          <h2 class="t-dialog-title" id="add-image-title">
            <Icon id="bi-layers" /> <span>Add image</span>
          </h2>
          <button class="t-dialog-close" type="button" aria-label="Close" data-dialog-close>
            ×
          </button>
        </div>
        <div class="t-dialog-body t-stack" data-gap="3">
          <p class="t-muted t-small">
            Images are not typed in: this list holds every image a template uses, the default runner image and the Docker-in-Docker sidecar. To list a new image,{' '}
            <a href="/templates">create or edit a template</a> that uses it.
          </p>
          {missing.length === 0 ? (
            <div class="t-alert" data-tone="info" role="status" id="add-image-none">
              <Icon id="bi-check-circle" />
              <div class="t-alert-body">Every image a template uses is present on every online host. Nothing to add.</div>
            </div>
          ) : (
            <div class="t-field">
              <label class="t-label" for="add-image-pick">
                Image
              </label>
              <select class="t-select" id="add-image-pick" name="reference" required>
                {missing.map((m) => (
                  <option value={m.ref} data-hosts={m.hosts.join(',')} safe>
                    {`${m.ref} · missing on ${m.hosts.join(', ')}`}
                  </option>
                ))}
              </select>
              <p class="t-hint">The image is pulled on every online host that lacks it.</p>
            </div>
          )}
        </div>
        <div class="t-dialog-footer">
          <button class="t-btn" type="button" data-dialog-close>
            {missing.length === 0 ? 'Close' : 'Cancel'}
          </button>
          {missing.length === 0 ? null : (
            <button class="t-btn" data-variant="primary" type="submit">
              <Icon id="bi-cloud-arrow-down" /> Pull
            </button>
          )}
        </div>
      </form>
    </dialog>
  )
}

export const ImagesPage = (data: ImagesData) => (
  <>
    <header class="t-page-header">
      <h1 class="t-page-title">Templates</h1>
      <span class="t-page-lead">Which runner images each host holds. A host pulls a missing image before its first runner of that template starts.</span>
      <div class="t-page-actions">
        <button class="t-btn" data-variant="primary" data-size="sm" data-dialog-open="add-image-dlg">
          <Icon id="bi-plus-lg" /> Add image
        </button>
      </div>
    </header>
    <TemplatesTabs active="images" />
    <ImagesLive {...data} />
    <AddImageDialog {...data} />
  </>
)
