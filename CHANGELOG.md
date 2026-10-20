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

### Changed

- Overview: one Hosts card with a section per host and that host's slots underneath; navbar order is Overview, Repos, Jobs, Runner types, Hosts, Events, Settings.
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
