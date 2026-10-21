# Changelog

All notable changes to OctoHatchery are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Octoforge member contract v1 ([docs/octoforge.md](docs/octoforge.md)): `octoforge.json` at the repository root, and with the new `OCTOFORGE_TOKEN` the routes `GET /api/octoforge/manifest`, `GET /api/octoforge/status`, `PUT`/`DELETE /api/octoforge/github`, `POST /api/octoforge/database/adopt` and `DELETE /api/octoforge/database`. Every route except the manifest needs the token as a bearer. Without `OCTOFORGE_TOKEN` nothing changes.
- `DATABASE_SCHEMA` (PostgreSQL): the schema that holds the tables and the migrations journal, default `octohatchery`, created when missing; every connection opens with `search_path` set to it, so several tools or installs can share one database. A role that owns only its schema works (the schema is not created again when it exists).
- Database adoption (`POST /api/octoforge/database/adopt {url, schema, copy}`): migrates the target, copies every table from one snapshot of the current database in one target transaction (ids kept, booleans and numbers converted between SQLite and PostgreSQL, sequences moved past the copied ids), compares the row count of every table and only then writes `DATA_DIR/octoforge-database.json` (0600). A non-empty target or a differing count fails with 409 and changes nothing; `copy: false` only migrates the target (for the other nodes of a cluster). The URL is never logged or returned.
- `DATA_DIR/octoforge-database.json` overrides `DATABASE_URL` / `DATABASE_SCHEMA` at start; an unreadable file stops the start with a reason. `DELETE /api/octoforge/database` removes it.
- GitHub credentials handed over by Octoforge (token or App) are checked with GitHub, stored in the `settings` table (plain text, key `octoforge_github`) and win over the `GITHUB_*` values; every node picks them up within about 15 seconds without a restart. A token without `GITHUB_WEBHOOK_SECRET` gets a generated webhook secret. Audit events `github.delivered`, `github.dropped`, `database.adopted`, `database.dropped`.
- With `OCTOFORGE_TOKEN` set and no `GITHUB_*` value, a node starts without GitHub access and waits for a credential; GitHub actions fail with "no GitHub credential yet" until then.
- `GET /api/github/status` carries `credentialSource` (`env`, `octoforge` or `none`); Settings → GitHub shows "(delivered by Octoforge)" next to the mode.
- One GitHub App can serve several accounts: OctoHatchery lists the App's installations (`GET /app/installations`, cached five minutes, re-fetched when a repo's owner is unknown and on Re-check) and uses the installation of each repo's owner for every GitHub call. `GITHUB_APP_INSTALLATION_ID` is now optional and names the default installation.
- Setting `github_accounts`: the accounts whose installations are served. Empty serves the default installation, or every installation without `GITHUB_APP_INSTALLATION_ID`. Webhooks from other accounts are dropped with a `webhook.ignored` audit event and never create a job; their repos cannot be adopted and are left out of the adopt dialog and the polling fallback.
- Settings → GitHub: one card per installation (account, user or organisation, installation link, repository count, missing permissions with what breaks), **Accounts served** as checkboxes, and a link to install the App on another account. `GET /api/github/status` carries `installations` and `newInstallUrl`.
- Repos → Adopt a repo lists the repositories of every served installation, grouped by owner.
- Run as per runner type (`runner_types.run_as`: `image` or `root`; migration `0006_runner_type_run_as`): `root` starts the runner container as uid 0, for jobs that write root-owned files in bind mounts; `image` (the default) keeps the image's own user. A Run as select in the template dialog, a `root` badge in the templates list; `PUT /api/runner-types/:name` and `upsert_runner_type` accept `runAs`.

- Job logs: the node that runs a job follows its runner's output into the database while the job runs and swaps in GitHub's final log when it ends; capped per job by the new `log_max_kb` setting (default 2048) and purged with the job.
- Job page `/jobs/:id` with a live, bounded log view (follow, copy, source and truncated badges); job names in the Jobs and Runners tables link to it.
- `GET /api/jobs/:id`, `GET /api/jobs/:id/log?after=&limit=` and the SSE stream `GET /api/jobs/:id/log/stream`.
- MCP tool `get_job_log {job_id, tail?}` returning the log as text.
- Hosts report their specs in every heartbeat (CPUs, memory, OS, Docker version, app version), stored in new nullable `hosts` columns and returned by `GET /api/hosts` and `list_hosts`.
- Hosts page `/hosts` with those specs, slots per host and an "Add a host" dialog explaining how a node joins, with a copyable `.env` skeleton.
- `POST /api/repos/webhook {fullName}` and MCP tool `ensure_webhook` to create or repair a repo's `workflow_job` webhook; audit event `repo.webhook`.
- `GET /api/jobs` and `list_jobs` accept `q`, `since`, `running` and `failed`.
- `GET /api/repos` and `list_repos` carry `jobCount` per repo.
- Settings → GitHub: the auth mode, App, installation, repository count and webhook URL, plus a table of required versus granted permissions with why each is needed and what breaks without it; links to edit the App's permissions and accept them on the installation; Re-check. `GET /api/github/status`, `POST /api/github/recheck`; `GET /health` carries `github: {ok, source, missing}`; a warning banner on every page while a permission is missing or no GitHub source is configured.
- Repos → Adopt a repo: a dialog listing the repositories the installation or token can reach (`GET /api/github/repos`, cached 60 s, first 500), filtered as you type, one click adopts; clear error states with the fix when the list cannot be fetched. The free-text adopt form is gone.
- Docker access per runner type (`runner_types.docker`: `none`, `socket`, `dind`; migration `0003_runner_type_docker`): host socket bind-mount with the socket's group, or a privileged `docker:28-dind` sidecar per runner that the reaper, the stale sweep and `kill` remove with the runner; the runner entrypoint waits for `DOCKER_HOST`. Three cards with trade-offs in the type dialog, a Docker column in the table; `upsert_runner_type` and `PUT /api/runner-types/:name` accept `docker`.
- Setting `runner_image_default` (default `ghcr.io/rojosinalma/octohatchery-runner:edge`, Settings → BuildKit): the image preselected when a template is created.
- Templates: the slots matrix updates live from `runner` and `slot` events (`GET /templates?partial=slots`), after a spawn and after a saved cell; a field being edited is never overwritten.
- Image inventory: every node reports on each heartbeat which wanted images (every template's image, `runner_image_default`, `docker:28-dind`) its engine holds, into the new `host_images` table (migration `0004_host_images`, both dialects); `GET /api/images` and `GET /api/hosts/:name/images`.
- Image pulls: `POST /api/hosts/:name/images/pull {reference}` and MCP `pull_image {host, reference}` queue a pull (`image_pulls` table) that the node owning the host claims on its next scheduler tick and runs in the background, one at a time; outcome recorded with the engine's error, audit events `image.pull`, `image.pulled`, `image.pull_failed`; finished pulls purged with `retention_days`; stranded `running` pulls failed on node restart. Only wanted references can be pulled.
- Templates → Images tab (`/templates/images`): one row per wanted image, one column per host, cells `present` (digest, size, build time), `missing` (with the last pull error) or `pulling`; icon-only Pull now per cell, Pull on all hosts per row, an Add image dialog that picks from the listed images missing on a host (no free text). Live through the new `image` SSE event.
- Template dialog: image options say where the image is missing (`· missing on tiny`); when the picked image is missing on a host with slots for the template, a warning offers Pull on <host> inline.
- Overview → Recent jobs: the Jobs table as a card under the Hosts card (ten newest, the same status / repo / search / quick filters under a `j_` query prefix, a pager with page numbers and a picker for last 10 / 20 / 50 / all (all = paged by 100), "All jobs →" with the same filters), refreshed live on `job` and `runner` events; picker, pager and filters swap the card in place without a page load; `GET /?partial=jobs` returns the card alone.
- Jobs page paging: 25 rows per page, `?page=` and `?per=` (10, 25, 50, 100) in the URL with the filters, a pager with the range in view and a per-page select; `GET /api/jobs` accepts `page` and `per` and returns `total`, `page`, `per`.
- Job steps: `jobs.steps` (migration `0005_job_steps`, both dialects) stores GitHub's `workflow_job.steps[]` from the `in_progress` and `completed` webhooks and from `GET /repos/{owner}/{repo}/actions/jobs/{id}` when the job's log is finalised (authoritative timestamps); finished jobs without steps are backfilled by the sweep (five per pass); `GET /api/jobs/:id` returns `steps`.
- Job page steps view: the log reads like GitHub's — one collapsed row per step with chevron, status icon, name, line count and duration; a failed or running step is open; lines are placed under the step running at their timestamp (a job without steps shows one "Log" row); inside a step the gutter is `mm:ss` since the job started, blank lines are dropped, progress runs are reduced to their last line, `##[command]` lines are styled as commands, `##[group]` blocks fold as a second level; Expand all / Collapse all; an outcome line under the title (`succeeded 12 min ago in 2m 20s`); live lines land in the running step and a `job` event re-renders the steps block keeping what you opened (`GET /jobs/:id?partial=log`); `?raw=1` stays the flat view.
- Job log groups: `##[group]` … `##[endgroup]` (and `##[section]Starting/Finishing:`) blocks fold into collapsible sections with title, line count and duration, in the server-rendered log and in lines appended live; `##[error]` / `##[warning]` lines are toned and an error opens its group; Expand all / Collapse all; `?raw=1` for the flat view; Copy keeps the markers.
- Overview Runners table: runner name links to `/jobs?runner=<name>` (new `runner` filter on `GET /api/jobs`, `list_jobs` and the Jobs page, shown as a clearable chip), host to `/hosts#<name>`, template to `/templates#<name>`; the same links on the job page facts. Host and template rows carry their name as `id` and are highlighted when reached by anchor.

### Changed

- PostgreSQL tables now live in the schema `DATABASE_SCHEMA` (default `octohatchery`) with the migrations journal inside it, instead of `public` with the journal in `drizzle`. Upgrading: nothing to do. When `DATABASE_SCHEMA` is unset and the tables are found in `public` (and not in `octohatchery`), OctoHatchery keeps using `public`, the `drizzle` journal and the old leader lock, and logs a warning once; set `DATABASE_SCHEMA=public` to silence it, or adopt a database to move. Leader locks of other schemas are `octohatchery-leader:<schema>`. See [docs/operations.md](docs/operations.md#upgrade).
- Runner image: `build-essential` and `pkg-config` for native extensions, passwordless `sudo` for `runner` (the image now sets `USER runner`, keeping its supplementary groups), and a UTF-8 locale (`LANG`/`LC_ALL=C.UTF-8`), matching GitHub-hosted runners.
- Runner tools are baked into the runner image instead of a shared per-host volume: Ruby 3.3.12 and 3.4.11 (each with Bundler 2.5.22, 2.6.9 and 4.0.22) in the `ruby/setup-ruby` tool-cache layout and Bun 1.4.3 in `~/.bun/bin`, so the setup actions skip the download. Each tool is its own image (`runner/tools/<tool>/`, published as `ghcr.io/rojosinalma/octohatchery-tool-<tool>`), built before the runner image, which copies its files in; the runner build takes `TOOLS_REGISTRY` and `TOOLS_TAG` build args. Runners no longer mount `octohatchery-tool-cache` at `/opt/hostedtoolcache`: concurrent `setup-ruby` jobs wrote into the same Ruby there and broke each other's Bundler. Upgrading: update the runner image with the app; the old volume is unused and can be removed with `docker volume rm octohatchery-tool-cache` once no runner from an older version is left.

- Templates dialog: the Image field is a select of the default image and every image in use, with "Other…" to type a new one; editing preselects the template's image.
- Loading states: the runs-on actions, the adopt rows and the spawn buttons show a spinner and are disabled while the request runs; the sibling runs-on button is disabled too and both come back on failure.
- Overview: one Hosts card with hosts as columns; a one-line header per host (status dot, name, `leader` badge, `offline` / `Docker unreachable` only when true, specs and last heartbeat), a `N of M slots busy` line and one pill per slot per template (a bar beyond 12 slots). Navbar order is Overview, Repos, Jobs, Templates, Hosts, Events, Settings.
- Overview: every live runner sits in its slot. Slot circles are right-aligned on each template row; a runner is a capsule ending in its filled circle (job and repo, `waiting for a job` or `starting`; links to the job; × kills it after a confirmation), so a busier row grows to the left. The separate Runners table is gone. The page fits the window: Recent jobs takes the remaining height and its table scrolls inside the card.
- Overview: hosts split the Hosts card equally, up to three columns per row with rows filled evenly; a narrow column puts the specs under the host name.
- Dashboard: runner types are called templates on the pages (`/templates`, `/runner-types` redirects there); the API and MCP names are unchanged.
- Repos and Templates: the action columns are icon-only buttons with tooltips (runs-on, Add / Repair webhook, Unadopt; Edit, Delete).
- Hosts: columns Host, Slots, CPUs, Memory (GB), OS, Docker, Docker version, App version, Last seen; the leader badge is small and spaced from the name.
- Settings: sections and sidebar in the order Appearance, GitHub, BuildKit (was "Runners"), Live updates, Retention, Scheduler, Logging, Other, About; "Other" appears only when unknown settings exist.
- Jobs page: columns Runner, Status, Job, Repo, Queued, Duration, Run; a status select, a search box and quick filters (Running now, Failed, Last 24 h, This week).
- Validation errors from the API and the pages name the parameter and the accepted values (`query per: expected one of 10, 25, 50, 100`) instead of the first line of a JSON blob.
- Repos page: Jobs column, labelled action buttons on one row (runs-on, Add/Repair webhook, Unadopt), drawn validation on the adopt form.
- Runner types: labels edited as chips with the always-added labels shown first; Environment before Mounts in the table and the dialog.
- `apply_runs_on`: checks the GitHub permissions the mode needs before writing and fails naming the missing ones and the GitHub page to fix them; `pr` mode verifies the pull request exists and deletes its branch again on any failure; failures carry GitHub's own message; `commit` mode returns `htmlUrl`. The runs-on dialog shows the result with a link to the pull request or commit, and keeps GitHub's exact error inside the dialog.
- Repos: the webhook column says `GitHub App` in App mode.
- GitHub App manifest and docs list `workflows: write` (GitHub requires it to change files under `.github/workflows`).

### Fixed

- A runner is no longer killed while it runs a job. GitHub gives a just-in-time runner any queued job of its repo that matches its labels, so with several jobs queued at once a job often runs on the runner claimed for its neighbour. OctoHatchery now moves the job to the runner GitHub names in the `in_progress` (or `completed`) webhook, and the neighbour to the freed runner, or back to the queue. Before, finishing one job could remove the container still running the other one, and the stale-runner sweep could remove a busy runner it still thought idle; GitHub then failed the job with "The self-hosted runner lost communication with the server". Each move leaves a `job.rebound` audit event.
- A job cancelled before it started no longer takes down the runner claimed for it. That runner is still registered with GitHub and often picks up the next queued job; it now stays up without a job, and the stale-runner sweep removes it if nothing comes.
- Live job logs follow the same binding: lines go to the job the runner really runs, and that job gets GitHub's final log.
- The stale-runner sweep asks GitHub first and keeps a runner GitHub reports busy; a spawn that finishes after GitHub already started a job on it keeps the runner `busy`.

## [0.1.0] - 2026-10-19

First scaffold.

### Added

- Scheduler that claims queued `workflow_job` events for adopted repositories and starts one ephemeral, just-in-time registered runner per job on a host with a free slot.
- Runner types as database rows: image, labels, CPU and memory caps, mounts, environment and secret names resolved at spawn time.
- Slots per host and per type, with `single` mode (SQLite or PostgreSQL) and `cluster` mode (PostgreSQL, several nodes, leader-elected housekeeping).
- GitHub authentication through a GitHub App or a personal access token.
- Repository adoption with automatic webhook registration, and `apply_runs_on` to show, propose or commit the `runs-on` change in a repository's workflows.
- JSON API under `/api/`, server-rendered dashboard (Overview, Jobs, Repos, Runner types, Events, Settings), MCP endpoint at `/mcp`, `/health`, Prometheus `/metrics` and an SSE stream at `/events/stream`.
- Runner image `ghcr.io/rojosinalma/octohatchery-runner` based on GitHub's `actions-runner`, with `gh`, Docker CLI and buildx, git-lfs, jq, curl and unzip, plus a `buildkitd` sidecar in the compose file for container builds inside jobs.
- Audit log (`events`) and retention purge for finished jobs, runners and events.

[Unreleased]: https://github.com/rojosinalma/octohatchery/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rojosinalma/octohatchery/releases/tag/v0.1.0
