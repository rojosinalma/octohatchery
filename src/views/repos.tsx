import type { Repo, RunnerType } from '../lib/types'
import { Empty, Icon, RelTime } from './parts'

export type ReposData = { repos: Repo[]; types: RunnerType[] }

export const ReposTable = ({ repos }: { repos: Repo[] }) => {
  const adopted = repos.filter((r) => r.adopted)
  if (adopted.length === 0) {
    return (
      <div id="repos-live">
        <Empty icon="bi-github" title="No repos adopted" text="Adopt a repo above. OctoHatchery installs a webhook on it and takes its queued jobs from then on." />
      </div>
    )
  }
  return (
    <div id="repos-live" class="t-table-wrap">
      <table class="t-table" data-variant="data" data-density="compact" id="repos-table">
        <thead>
          <tr>
            <th data-sort="name">
              <button>
                Repo <span class="t-sort-icon"></span>
              </button>
            </th>
            <th>Visibility</th>
            <th>Webhook</th>
            <th>Adopted</th>
            <th class="t-col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {adopted.map((r) => (
            <tr data-repo={r.fullName} data-name={r.fullName}>
              <td>
                <a class="t-mono" href={`https://github.com/${r.fullName}`} target="_blank" rel="noopener" safe>
                  {r.fullName}
                </a>
              </td>
              <td>
                <span class="t-badge" data-tone={r.isPrivate ? 'neutral' : 'info'}>
                  {r.isPrivate ? 'private' : 'public'}
                </span>
              </td>
              <td>
                <span class="t-badge" data-tone={r.webhookId ? 'success' : 'warning'} data-tip={r.webhookId ? `Webhook #${r.webhookId}` : 'No webhook: jobs are found by polling only'}>
                  {r.webhookId ? 'active' : 'polling'}
                </span>
              </td>
              <td>
                <RelTime at={r.adoptedAt} />
              </td>
              <td class="t-col-actions">
                <div class="t-cluster" data-gap="1">
                  <button class="t-btn" data-size="sm" data-variant="ghost" data-action="runs-on" data-repo={r.fullName}>
                    <Icon id="bi-code-slash" /> runs-on
                  </button>
                  <button class="t-btn" data-size="sm" data-variant="ghost" data-tone="danger" data-icon="only" data-tip="Unadopt" data-action="unadopt" data-repo={r.fullName}>
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

const RunsOnDialog = ({ types }: { types: RunnerType[] }) => (
  <dialog class="t-dialog" id="runs-on-dlg" data-size="lg" aria-labelledby="runs-on-title">
    <div class="t-dialog-header">
      <h2 class="t-dialog-title" id="runs-on-title">
        <Icon id="bi-code-slash" /> <span>runs-on for </span>
        <span class="t-mono" id="runs-on-repo"></span>
      </h2>
      <button class="t-dialog-close" aria-label="Close" data-dialog-close>
        ×
      </button>
    </div>
    <div class="t-dialog-body t-stack" data-gap="3">
      <p class="t-muted t-small">
        Put one of these lines in a workflow job. Every runner carries <code>self-hosted</code>, its type and its host as labels. Copy the snippet, or let
        OctoHatchery change the workflows for you: a pull request you review, or a direct commit to the default branch.
      </p>
      {types.length === 0 ? (
        <Empty icon="bi-cpu" title="No runner types" text="Create a runner type first; the snippet names it.">
          <a class="t-btn" data-variant="primary" href="/runner-types">
            Runner types
          </a>
        </Empty>
      ) : (
        types.map((t) => (
          <section class="t-section" data-type={t.name}>
            <h3 class="t-section-title" safe>
              {t.name}
            </h3>
            <div class="t-section-body t-stack" data-gap="2">
              <pre class="t-code-pre" data-variant="shell">
                <button class="t-code-copy" type="button" aria-label="Copy">
                  <Icon id="bi-clipboard" />
                </button>
                <span class="t-tok-key">runs-on</span>: [<span class="t-tok-str">self-hosted</span>, <span class="t-tok-str" safe>{t.name}</span>]
              </pre>
              <div class="t-toolbar" data-gap="2">
                <button class="t-btn" data-size="sm" data-action="runs-on-apply" data-mode="pr" data-type={t.name}>
                  <Icon id="bi-github" /> Open a pull request
                </button>
                <button class="t-btn" data-size="sm" data-variant="warning" data-action="runs-on-apply" data-mode="commit" data-type={t.name}>
                  <Icon id="bi-lightning-charge" /> Commit to default branch
                </button>
              </div>
            </div>
          </section>
        ))
      )}
    </div>
    <div class="t-dialog-footer">
      <button class="t-btn" data-dialog-close>
        Close
      </button>
    </div>
  </dialog>
)

export const ReposPage = ({ repos, types }: ReposData) => (
  <>
    <header class="t-page-header">
      <h1 class="t-page-title">Repos</h1>
      <span class="t-page-lead">Adopted repos send their queued jobs here.</span>
    </header>
    <form class="t-toolbar" id="adopt-form" data-action="adopt" aria-label="Adopt a repo">
      <div class="t-field">
        <label class="t-label t-visually-hidden" for="adopt-name">
          Repo (owner/name)
        </label>
        <input class="t-input" data-size="sm" data-width="auto" id="adopt-name" name="fullName" placeholder="owner/name" required pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" autocomplete="off" />
      </div>
      <button class="t-btn" data-variant="primary" data-size="sm" type="submit">
        <Icon id="bi-plus-lg" /> Adopt
      </button>
      <span class="t-help" data-tone="accent">
        <button class="t-help-btn" type="button" aria-expanded="false" aria-label="About adopting">
          ?
        </button>
        <div class="t-help-box" hidden>
          <p>The GitHub App or token must have access to the repo. Adopting installs a webhook; unadopting removes it and ignores the repo's jobs.</p>
        </div>
      </span>
    </form>
    <ReposTable repos={repos} />
    <RunsOnDialog types={types} />
  </>
)
