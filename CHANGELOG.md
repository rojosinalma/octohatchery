# Changelog

All notable changes to OctoHatchery are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

- Templates dialog: the Image field is a select of the default image and every image in use, with "Other…" to type a new one; editing preselects the template's image.
- Loading states: the runs-on actions, the adopt rows and the spawn buttons show a spinner and are disabled while the request runs; the sibling runs-on button is disabled too and both come back on failure.
- Overview: one Hosts card with hosts as columns; a one-line header per host (status dot, name, `leader` badge, `offline` / `Docker unreachable` only when true, specs and last heartbeat), a `N of M slots busy` line and one pill per slot per template (a bar beyond 12 slots). Navbar order is Overview, Repos, Jobs, Templates, Hosts, Events, Settings.
- Dashboard: runner types are called templates on the pages (`/templates`, `/runner-types` redirects there); the API and MCP names are unchanged.
- Repos and Templates: the action columns are icon-only buttons with tooltips (runs-on, Add / Repair webhook, Unadopt; Edit, Delete).
- Hosts: columns Host, Slots, CPUs, Memory (GB), OS, Docker, Docker version, App version, Last seen; the leader badge is small and spaced from the name.
- Settings: sections and sidebar in the order Appearance, GitHub, BuildKit (was "Runners"), Live updates, Retention, Scheduler, Logging, Other, About; "Other" appears only when unknown settings exist.
- Jobs page: columns Runner, Status, Job, Repo, Queued, Duration, Run; a status select, a search box and quick filters (Running now, Failed, Last 24 h, This week).
- Repos page: Jobs column, labelled action buttons on one row (runs-on, Add/Repair webhook, Unadopt), drawn validation on the adopt form.
- Runner types: labels edited as chips with the always-added labels shown first; Environment before Mounts in the table and the dialog.
- `apply_runs_on`: checks the GitHub permissions the mode needs before writing and fails naming the missing ones and the GitHub page to fix them; `pr` mode verifies the pull request exists and deletes its branch again on any failure; failures carry GitHub's own message; `commit` mode returns `htmlUrl`. The runs-on dialog shows the result with a link to the pull request or commit, and keeps GitHub's exact error inside the dialog.
- Repos: the webhook column says `GitHub App` in App mode.
- GitHub App manifest and docs list `workflows: write` (GitHub requires it to change files under `.github/workflows`).

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
