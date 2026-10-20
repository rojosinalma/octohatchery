import type { RepoListItem, RunnerType } from '../lib/types'
import { Empty, Icon, RelTime } from './parts'

export type GitHubAuthKind = 'app' | 'pat' | 'none'
export type ReposData = { repos: RepoListItem[]; types: RunnerType[]; githubAuth: GitHubAuthKind }

export const ReposTable = ({ repos, githubAuth }: Pick<ReposData, 'repos' | 'githubAuth'>) => {
  const adopted = repos.filter((r) => r.adopted)
  if (adopted.length === 0) {
    return (
      <div id="repos-live">
        <Empty icon="bi-github" title="No repos adopted" text="Pick a repo from the ones GitHub lets this node see. OctoHatchery takes its queued jobs from then on.">
          <button class="t-btn" data-variant="primary" data-action="adopt-open">
            <Icon id="bi-plus-lg" /> Adopt a repo
          </button>
        </Empty>
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
            <th class="t-col-num" data-sort="jobs">
              <button>
                Jobs <span class="t-sort-icon"></span>
              </button>
            </th>
            <th>Adopted</th>
            <th class="t-col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {adopted.map((r) => (
            <tr data-repo={r.fullName} data-name={r.fullName} data-jobs={String(r.jobCount)}>
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
                {githubAuth === 'app' ? (
                  <span class="t-badge" data-tone="success" data-tip="The GitHub App delivers workflow_job events for every repo it is installed on">
                    GitHub App
                  </span>
                ) : (
                  <span class="t-badge" data-tone={r.webhookId ? 'success' : 'warning'} data-tip={r.webhookId ? `Webhook #${r.webhookId}` : 'No webhook: jobs are found by polling only'}>
                    {r.webhookId ? 'active' : 'polling'}
                  </span>
                )}
              </td>
              <td class="t-col-num">
                {r.jobCount > 0 ? (
                  <a class="t-mono" href={`/jobs?repo=${encodeURIComponent(r.fullName)}`} data-tip="Jobs of this repo">
                    {String(r.jobCount)}
                  </a>
                ) : (
                  <span class="t-muted">0</span>
                )}
              </td>
              <td>
                <RelTime at={r.adoptedAt} />
              </td>
              <td class="t-col-actions">
                <div class="t-cluster row-actions" data-gap="1">
                  <button class="t-btn" data-size="sm" data-variant="ghost" data-icon="only" data-tip="runs-on snippet and workflow change" aria-label="runs-on" data-action="runs-on" data-repo={r.fullName}>
                    <Icon id="bi-code-slash" />
                  </button>
                  {githubAuth === 'app' ? (
                    <span data-tip="Webhook covered by the GitHub App" class="row-action-disabled">
                      <button class="t-btn" data-size="sm" data-variant="ghost" data-icon="only" aria-label="Add webhook" disabled>
                        <Icon id="bi-link-45deg" />
                      </button>
                    </span>
                  ) : (
                    <button
                      class="t-btn"
                      data-size="sm"
                      data-variant="ghost"
                      data-icon="only"
                      data-action="webhook"
                      data-repo={r.fullName}
                      data-tip={r.webhookId ? 'Repair webhook: re-create or fix the workflow_job webhook on GitHub' : 'Add webhook: create the workflow_job webhook so jobs arrive at once'}
                      aria-label={r.webhookId ? 'Repair webhook' : 'Add webhook'}
                    >
                      <Icon id="bi-link-45deg" />
                    </button>
                  )}
                  <button class="t-btn" data-size="sm" data-variant="ghost" data-tone="danger" data-icon="only" data-tip="Unadopt" aria-label="Unadopt" data-action="unadopt" data-repo={r.fullName}>
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
        Put one of these lines in a workflow job. Every runner carries <code>self-hosted</code>, its template and its host as labels. Copy the snippet, or let
        OctoHatchery change the workflows for you: a pull request you review, or a direct commit to the default branch.
      </p>
      {types.length === 0 ? (
        <Empty icon="bi-cpu" title="No templates" text="Create a template first; the snippet names it.">
          <a class="t-btn" data-variant="primary" href="/templates">
            Templates
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

const AdoptDialog = () => (
  <dialog class="t-dialog" id="adopt-dlg" data-size="lg" aria-labelledby="adopt-title">
    <div class="t-dialog-header">
      <h2 class="t-dialog-title" id="adopt-title">
        <Icon id="bi-github" /> <span>Adopt a repo</span>
      </h2>
      <button class="t-dialog-close" aria-label="Close" data-dialog-close>
        ×
      </button>
    </div>
    <div class="t-dialog-body t-stack" data-gap="3">
      <p class="t-muted t-small">
        These are the repositories the GitHub App installation or the token can reach. One click adopts: OctoHatchery takes the repo's queued <code>self-hosted</code> jobs from then on
        (and, with a token, installs a <code>workflow_job</code> webhook). Unadopting reverses it.
      </p>
      <div class="t-cluster adopt-filter" data-gap="2" data-align="center">
        <div class="t-field adopt-search-field">
          <label class="t-label t-visually-hidden" for="adopt-search">
            Filter repositories
          </label>
          <input class="t-input" type="search" id="adopt-search" placeholder="Filter by name…" autocomplete="off" disabled />
        </div>
        <span class="t-small t-muted" id="adopt-count" aria-live="polite"></span>
      </div>
      <div id="adopt-state"></div>
      <div class="t-list adopt-list" role="listbox" aria-label="Repositories" id="adopt-list"></div>
      <p class="t-muted t-small" id="adopt-none" hidden>
        No repository matches the filter.
      </p>
    </div>
    <div class="t-dialog-footer">
      <button class="t-btn" data-dialog-close>
        Close
      </button>
    </div>
  </dialog>
)

export const ReposPage = ({ repos, types, githubAuth }: ReposData) => (
  <>
    <header class="t-page-header">
      <h1 class="t-page-title">Repos</h1>
      <span class="t-page-lead">Adopted repos send their queued jobs here.</span>
      <div class="t-page-actions">
        <button class="t-btn" data-variant="primary" data-size="sm" data-action="adopt-open">
          <Icon id="bi-plus-lg" /> Adopt a repo
        </button>
        <span class="t-help" data-tone="accent">
          <button class="t-help-btn" type="button" aria-expanded="false" aria-label="About adopting">
            ?
          </button>
          <div class="t-help-box" hidden>
            <p>The list shows what the GitHub App or token can reach; a repo missing from it must be added to the App installation or the token first. Adopting installs a webhook (token mode); unadopting removes it and ignores the repo's jobs.</p>
          </div>
        </span>
      </div>
    </header>
    <ReposTable repos={repos} githubAuth={githubAuth} />
    <RunsOnDialog types={types} />
    <AdoptDialog />
  </>
)
