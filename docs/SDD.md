# OctoHatchery — software design document

This document describes how OctoHatchery is built and why. It is the reference for anyone changing the code. The "Design decisions" table at the end is append-only: a change to the stack, the data model, the modes, the security model or the stable interfaces gets a new dated row, never an edit to an old one.

## 1. Purpose

OctoHatchery turns queued GitHub Actions jobs into short-lived, single-use self-hosted runners. It serves accounts that cannot share one runner across repositories (personal accounts register runners per repository) and anyone who wants a clean container per job without paying for hosted minutes. It takes `workflow_job` events from the repositories you adopt, matches the job's labels to a runner type, picks a host with a free slot for that type, registers a just-in-time (JIT) runner with GitHub, starts a container with that configuration, and removes everything when the job ends.

Non-goals, on purpose:

- No built-in authentication. A reverse proxy with SSO is the gate.
- No Kubernetes and no Actions Runner Controller. Docker on plain hosts.
- No execution of workflow steps. GitHub's runner binary does that inside the container.
- No automatic host discovery or scaling. A host appears when you start a node on it.
- No unasked edits to workflows. `apply_runs_on` runs only when you call it.

## 2. Context

```
 GitHub ──webhooks (workflow_job, HMAC)──▶ OctoHatchery node(s) ──REST (JIT config, webhooks, workflow edits)──▶ GitHub
                                                │
   browser / scripts / agents ──HTTPS via proxy─┤  dashboard · /api · /mcp · /health · /metrics · /events/stream
                                                │
                                                ├── Docker daemon (local socket)  → runner containers
                                                ├── buildkitd sidecar              → container builds inside jobs
                                                └── database (SQLite or PostgreSQL)
```

External systems: GitHub (REST and webhooks, authenticated as a GitHub App or with a personal access token), one Docker daemon per node, one database. Clients: a browser for the dashboard, scripts over the JSON API, agents over MCP, monitoring over `/health` and `/metrics`.

## 3. Architecture

### 3.1 Node

A node is one `app` container plus one `buildkitd` sidecar, started by `compose.yaml` on one host. The `app` process runs everything: HTTP server (API, dashboard, MCP, webhook, SSE, health, metrics), the scheduler loop for its host, and, when it holds the lease, the leader sweep. There is no separate worker, queue broker or cron.

The `app` container reaches the host's Docker daemon through the mounted socket (or `DOCKER_HOST`). Runners it starts join the node's compose network so they can reach `buildkitd` at `BUILDKIT_HOST`.

### 3.2 Modules

```
src/index.ts           mounts the Elysia plugins and listens
src/lib/               logic: scheduler, sweep, joblog, github, backends, settings, bus, log, service facade
src/db/                Drizzle schema, migrations, drivers (postgres, sqlite)
src/routes/            HTTP: validate → lib → { ok, message, ...data }
src/mcp/               MCP server and one file per tool, each a thin call into lib
src/views/             server-rendered pages (JSX, no SPA)
runner/                runner image (Dockerfile + entrypoint)
test/<area>/           bun tests per area
```

`src/lib/service.ts` is the single facade the routes, the MCP tools and the views call. It owns validation of business rules, writes the `events` audit row for every mutation (with the actor), emits change notifications on the in-process bus, and throws `ServiceError` with a code (`not_found`, `invalid`, `conflict`, `unavailable`) that the HTTP layer maps to 404, 400, 409 or 503.

### 3.3 Registries

Each extension point is a registry: one file per entry, one lookup by name, and a new entry is one new file plus one registration line.

| Registry | Entries today | Selected by |
|---|---|---|
| GitHub auth `src/lib/github/auth/` | `app`, `pat` | `GITHUB_AUTH` |
| Container backend `src/lib/backends/` | `docker` | fixed for now, `DOCKER_HOST` points it at a daemon |
| Database driver `src/db/drivers/` | `postgres`, `sqlite` | scheme of `DATABASE_URL` |
| MCP tools `src/mcp/tools/` | one file per tool | file name |

Runner types are not a registry. They are rows in `runner_types`, created from the dashboard, the API or MCP, so adding one needs no code and no restart.

### 3.4 Scheduler (per node)

Each node runs one loop for its own host. On every tick it:

1. Counts free slots per type for this host (`slots.count` minus runners of that type on this host in state `spawning`, `idle` or `busy`).
2. Opens a transaction and selects queued jobs whose labels match a type with a free slot here, with `FOR UPDATE SKIP LOCKED` on PostgreSQL (SQLite is single-writer, so a plain transaction is enough). Labels are matched only against known runner types; a job with unknown labels is marked `ignored` with a reason.
3. Marks each selected job `claimed` with this host, inserts a `runners` row in state `spawning`, and commits.
4. Outside the transaction, asks GitHub for a JIT runner configuration for the job's repository with labels `self-hosted`, `<type>`, `<host>` plus the type's extra labels, then asks the backend to start a container from the type's image with the configuration in `RUNNER_JITCONFIG`.
5. Reaps: lists containers labelled `octohatchery.runner=true` on this host, reconciles them with the `runners` table (exited container → `exited`, missing container → `failed` or `removed`), and removes exited containers.
6. Starts the oldest queued image pull for this host when none is running here; the pull runs in the background so the tick keeps claiming jobs, records `done` or `failed` with the engine's error, refreshes `host_images` and announces the change on the bus.

A failure in any step is logged with its stack trace, the affected rows are moved to `failed` with the reason, and the loop continues on the next tick. The loop never exits on an error and backs off while the database or Docker is unreachable.

On restart a node re-attaches to its running runners by container label, so an upgrade does not kill jobs in flight, and it reaps orphans whose rows are gone.

### 3.5 Leader sweep

One node at a time holds the leader lease: a PostgreSQL advisory lock in cluster mode, trivially the only node in single mode. The leader runs:

- **Migrations** on boot, additive only.
- **Polling fallback** every `poll_interval_s`: lists queued jobs for adopted repositories through the REST API and inserts any the webhook missed.
- **Stale runner removal**: a runner that has been `idle` or `spawning` longer than `stale_runner_minutes` without a job has its container deleted and its GitHub registration revoked.
- **Host liveness**: a host whose node has not updated `last_seen_at` recently is shown `offline`; its slots are not counted as available.
- **Retention purge**: finished `jobs` (with their `job_logs`), `runners`, `events` and finished `image_pulls` older than `retention_days` are deleted.

If the leader dies, the lock is released by PostgreSQL and the next node that tries takes it on its following tick.

### 3.6 Data model

Eleven tables, schema owned by this project, Drizzle migrations, additive only.

| Table | Holds | Notes |
|---|---|---|
| `hosts` | one row per node: name, status, last seen, leader flag, Docker reachable, plus the specs the node reports (CPUs, memory, OS, Docker version, app version; nullable) | registered on start, updated every heartbeat |
| `runner_types` | name, description, labels, image, CPU and memory caps, mounts, env, secret env names, docker access (`none`, `socket`, `dind`) | secrets are names only; values live in the node's environment |
| `slots` | `(host, type) → count` | how many runners of a type a host may run at once |
| `repos` | adopted repositories: full name, private flag, webhook id, adopted at | jobs from repositories not in this table are ignored |
| `jobs` | one row per `workflow_job` this instance may run (adopted repository, `self-hosted` label): repository, GitHub job id, run id, name, labels, status, conclusion, runner, timestamps, log source / size / truncated flag, steps (JSON: number, name, status, conclusion, started/completed at) | status `queued → claimed → in_progress → completed`, or `ignored` (claimed but no matching type, or retries exhausted); jobs of other repositories or for hosted runners get no row |
| `job_logs` | log lines of one job: `(job_id, seq)`, the line's own timestamp, text | written by the node that owns the runner; replaced by GitHub's log when the job ends; deleted with the job |
| `runners` | one row per runner container: name, host, type, container id, state, job, timestamps | state `spawning → idle → busy → exited`, or `failed`, then `removed` |
| `events` | audit log: actor, action, target, detail, time | actors: `user`, `mcp:<client>`, `webhook`, `scheduler`, `sweep` |
| `settings` | key → value | tunables with defaults in code, read at use time with a short cache |
| `host_images` | `(host, reference) → digest, size, built-at, seen-at` for every wanted image a host holds | rewritten by that host's heartbeat; a row disappears when the image or the template that wanted it does |
| `image_pulls` | requested pulls: host, reference, status (`queued → running → done | failed`), error, who asked, when | claimed and run by the node that owns the host; finished rows purged with the retention window |

Timestamps are stored as ISO-8601 UTC strings. `labels`, `mounts`, `env`, `secret_env`, `steps` and `detail` are JSON columns.

### 3.7 Sequence: one job

```
GitHub          webhook route        jobs table      scheduler (host A)     GitHub REST     Docker (host A)
  │ workflow_job queued  │                │                │                      │               │
  ├─────────────────────▶│ verify HMAC    │                │                      │               │
  │                      │ check repo adopted              │                      │               │
  │                      ├─ insert queued ▶│               │                      │               │
  │                      │                 │◀── claim (FOR UPDATE SKIP LOCKED) ───┤               │
  │                      │                 │   job=claimed, runner=spawning       │               │
  │                      │                 │                ├─ generate JIT config ▶│              │
  │                      │                 │                │◀── encoded config ────┤              │
  │                      │                 │                ├─ create + start container ──────────▶│
  │                      │                 │                │   runner=idle                        │
  │ runner registers, picks the job        │                │                      │               │
  │ workflow_job in_progress ─────────────▶│ job=in_progress, runner=busy          │               │
  │ … job runs inside the container …      │                │                      │               │
  │ workflow_job completed ───────────────▶│ job=completed (conclusion)            │               │
  │                      │                 │                │◀── container exits (run.sh once) ────┤
  │                      │                 │                ├─ reap: runner=exited, remove ───────▶│
  │                      │                 │                │   slot free again                    │
```

Every state change emits an event on the in-process bus. The SSE route forwards `runner`, `job`, `event`, `slot` and `image` changes to connected dashboards, so the Overview and Images pages update without polling.

### 3.8 Job logs

The node that owns a runner (the one whose host name matches `runner.host`) follows the container's output from the moment it starts: `docker logs --follow` with timestamps, demultiplexed, split into lines, written to `job_logs` in batches of at most 64 lines or 500 ms, each batch announced on the bus as a `log` event. The runner prints step output to its stdout because every runner gets `ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT=1`. On a node restart the reaper re-attaches to still-running containers it owns, asking the engine for output `since` the last stored timestamp and skipping lines it already has.

When the container exits the same node fetches the job's log from GitHub (`GET /repos/{owner}/{repo}/actions/jobs/{id}/logs`), which is complete and authoritative, and replaces the live lines with it. GitHub answers 404 until the log is ready, so the fetch retries with backoff for about two minutes; after that the live lines stay and the job's `log_source` says `runner`. A job's log is capped by the `log_max_kb` setting: past the cap nothing more is stored, the job is marked truncated and one notice line closes the stored log; the full log stays on GitHub.

The job's steps are stored next to the log (`jobs.steps`): the `in_progress` and `completed` webhook payloads carry `steps[]` and are stored as they arrive; when the container exits the finaliser fetches the job (`GET /repos/{owner}/{repo}/actions/jobs/{id}`) before the log and stores its steps, whose timestamps are authoritative. A failed steps fetch is logged and the log is still finalised. Finished jobs that have a GitHub log but no steps (rows from before this existed, or whose fetch failed) are backfilled by every node's sweep pass, at most five GitHub calls per pass, each job once per process. The dashboard assigns lines to steps by timestamp (`src/views/log-steps.ts`): a line belongs to the last step started at or before its stamp.

Readers on any node see the same thing because the lines are in the database: the JSON endpoint pages by sequence number, the per-job SSE stream sends stored lines first, then live batches (from the bus on the owning node, from a two-second database poll on the others), and `end` once the log is final. The dashboard keeps at most 5000 lines in the DOM.

## 4. Interfaces

All of them run in the same process on the same port.

| Interface | Path | Shape |
|---|---|---|
| JSON API | `/api/hosts`, `/api/hosts/:name/images`, `/api/hosts/:name/images/pull`, `/api/images`, `/api/runner-types`, `/api/slots`, `/api/repos`, `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/log`, `/api/runners`, `/api/events`, `/api/settings`, `/api/github/{status,recheck,repos}` | every response `{ ok, message, ...data }`, errors with the same shape and an HTTP status, never a redirect |
| Dashboard | `/`, `/jobs`, `/jobs/:id`, `/repos`, `/templates`, `/templates/images`, `/hosts`, `/events`, `/settings` | server-rendered HTML, small scripts for fetch, toasts and SSE |
| MCP | `/mcp` | Streamable HTTP; tools `list_hosts`, `list_runners`, `list_jobs`, `get_job_log`, `list_repos`, `adopt_repo`, `unadopt_repo`, `ensure_webhook`, `apply_runs_on`, `list_runner_types`, `upsert_runner_type`, `set_slots`, `spawn`, `kill`, `pull_image`; each tool is one call into the service facade |
| Webhook | `POST /webhooks/github` | `workflow_job` events, `X-Hub-Signature-256` HMAC verified before parsing, payload schema-checked |
| SSE | `GET /events/stream`, `GET /api/jobs/:id/log/stream` | `event: <name>` + `data: <json>`; one shared cap of `sse_max_clients` per node, idle clients dropped after `sse_idle_s`; the job stream sends `line` batches and `end` |
| Health | `GET /health` | 200 only when the database and the local Docker daemon answer; JSON with mode, host, leader flag, slots used and free, queued jobs, busy runners, last webhook time, version, and `github: {ok, source, missing}` (a missing permission is a warning, never a 503) |
| Metrics | `GET /metrics` | Prometheus text: slots, jobs by status, runner spawn and exit counters, webhook counters |

The JSON API, the MCP tool list, the webhook contract, the runner labels and the additive-only schema are the stable contracts. Changing one is a design decision.

## 5. Modes

| | `single` | `cluster` |
|---|---|---|
| Nodes | one | several, one per host |
| Database | SQLite (file) or PostgreSQL | PostgreSQL only; SQLite fails fast at start with a reason |
| Leader | the node itself | advisory lock, re-elected on failure |
| Slots | this host's | each node claims only for its own host |
| Use | one machine, quick start | a pool of hosts sharing one queue |

Both modes run the same code paths. `MODE` only changes the database requirement and how the leader is chosen.

## 6. Security model

- **Exposure.** No authentication is built in. The dashboard, API and MCP endpoint are meant to sit behind a reverse proxy that authenticates users (SSO). `POST /webhooks/github` is the one path that must bypass that proxy, and it is protected by the HMAC check instead.
- **Webhook.** Signature over the raw body with `GITHUB_WEBHOOK_SECRET`, constant-time compare, then schema validation. Unsigned, badly signed or malformed requests are rejected and counted in `/metrics`.
- **Input validation at the boundary.** HTTP and MCP parameters are validated with Elysia schemas. GitHub API responses are schema-checked before they are persisted. Job labels are matched only against known runner types.
- **Secrets.** Bootstrap secrets (`DATABASE_URL`, GitHub App key or token, webhook secret) live in `.env`, read through Bun's dotenv. Runner types store the **names** of secret environment variables; the node resolves values from its own process environment at spawn time. A missing secret fails the spawn with a reason rather than passing an empty string. No secret value is stored in the database, shown in the dashboard or written to logs. JIT configurations and installation tokens are held in memory only as long as needed.
- **Docker trust.** The `app` container has the host's Docker socket. Whoever controls the app controls that daemon. The app host is a trusted host; the proxy in front is what keeps control with you.
- **Runner privileges.** Runners get exactly what their type grants: image, CPU and memory caps (`memswap` equal to memory), `pids_limit`, named tool-cache volume, the type's mounts and environment. No Docker socket, no added capabilities, no host network by default. Container builds inside a job go through the `buildkitd` sidecar over `BUILDKIT_HOST`. A type may opt into Docker for its jobs: `socket` mounts the host's daemon socket (the job then controls every container on the host), `dind` starts a privileged Docker-in-Docker sidecar per runner that dies with it (isolated, slower).
- **GitHub permissions.** The code declares what it needs (`REQUIRED_PERMISSIONS`: key, level, why, what breaks); the node compares that with what the App installation granted (or probes a token) and surfaces gaps on the Settings → GitHub tab, as a banner, in `/health` and before any `apply_runs_on` write. A gap is a warning, never a reason to fail health.
- **Adoption.** Only repositories you adopted can produce jobs. Public repositories can be adopted; the README explains the fork pull-request risk and the GitHub settings that mitigate it.
- **Audit.** Every mutation writes an `events` row with its actor. MCP clients are recorded as `mcp:<client>`.

## 7. Configuration surface

Two layers, documented in full in [operations.md](operations.md#configuration):

- `.env`: bootstrap values and secrets, read once at start. Mode, host name, port, database URL, Docker host, GitHub auth method and credentials, webhook secret, public URL.
- `settings` table: tunables read at use time through `settings.fetch(key, default)` with a cache of at most 5 seconds, editable from the Settings page, the API and MCP without a restart: `poll_interval_s`, `stale_runner_minutes`, `retention_days`, `log_max_kb`, `sse_max_clients`, `sse_idle_s`, `log_level`, `buildkit_host`.

Nothing else is tunable, and nothing is hardcoded per host: anything that differs between installations is in one of those two places.

## 8. Observability

- Logs to stdout with a level and a subsystem prefix: `[http] [scheduler] [github] [docker] [sweep] [joblog] [mcp]`. Every call to GitHub or Docker logs method, target and outcome. Background errors log the full stack trace.
- `/health` for probes, `/metrics` for Prometheus, `events` for the audit trail. There is no alerting code in the app; point your monitoring at `/health`.

## 9. Operations summary

Deploy with `docker compose up -d` per host. Upgrade by pulling the new image and recreating the `app` container; running runners survive because the node re-attaches by label. Back up the database; everything else (runner containers, tool cache, webhooks) is re-creatable. Full procedures, including cluster setup, troubleshooting and teardown, are in [operations.md](operations.md).

## 10. Current scope

Today OctoHatchery supports Docker as the container backend, GitHub Apps and personal access tokens for authentication, SQLite and PostgreSQL as databases, and one runner image that covers container builds and general CI. The registries exist so that a Podman or SSH backend, another auth method or another driver is one file each.

## 11. Design decisions

Append-only. One row per decision, dated. Reopen a decision by adding a new row that names the one it supersedes.

| Decision | Option chosen | Reason | Date |
|---|---|---|---|
| Language | TypeScript on Bun 1.4 | one runtime for server, tests and tooling; `bun build --compile` gives a single binary; large contributor pool for a public tool | 2026-10-19 |
| HTTP framework | Elysia 1.4 | schema validation on every route with `t`, plugin composition for the six surfaces, native Bun performance | 2026-10-19 |
| Database | PostgreSQL for shared state, SQLite for single-node, both through Drizzle with a driver registry chosen by the `DATABASE_URL` scheme | cluster nodes need one shared queue with row locks; single-node users should not need a database server | 2026-10-19 |
| Migrations | Drizzle, additive only, run on boot by the leader | schema is a stable contract; additive keeps older nodes working during a rolling upgrade | 2026-10-19 |
| Background work | in-process scheduler loop per node plus a leader-elected sweep (PostgreSQL advisory lock); no external scheduler, queue broker or cron | the project must be self-contained; the database already serialises claims with `FOR UPDATE SKIP LOCKED` | 2026-10-19 |
| Configuration | `settings` table read at use time (cache ≤ 5 s) for tunables; `.env` via dotenv for bootstrap values and secrets | tunables change without a restart; secrets never enter the database | 2026-10-19 |
| Runtime | containers via `compose.yaml`: `app` + `buildkitd` sidecar per host; `unless-stopped` | one unit per host, same shape on every host, builds inside jobs without Docker-in-Docker | 2026-10-19 |
| Interfaces | JSON API `{ ok, message, ...data }`, server-rendered dashboard, MCP over Streamable HTTP, webhook, SSE, `/health`, `/metrics`, all in one process | one facade serves humans, scripts and agents the same actions; no SPA to maintain | 2026-10-19 |
| Authentication | none built in; a reverse proxy with SSO gates everything except the webhook | avoids a second identity system; every deployment already has a proxy in front | 2026-10-19 |
| Webhook verification | HMAC SHA-256 over the raw body with `GITHUB_WEBHOOK_SECRET`, then schema check | GitHub's standard; the only unauthenticated path must verify origin | 2026-10-19 |
| Container backend | local Docker socket per node (`DOCKER_HOST` configurable) behind a backend registry | simplest working backend; the registry leaves room for Podman or remote hosts | 2026-10-19 |
| GitHub authentication | GitHub App and personal access token, both from day one, behind an auth registry | an App gives scoped, rotating tokens; a PAT is the quickest path for one account | 2026-10-19 |
| Runner identity | one ephemeral JIT runner per job, labels `self-hosted`, `<type>`, `<host>` plus the type's labels | per-job registration is what lets one pool serve many repositories on a personal account | 2026-10-19 |
| Runner types | rows in `runner_types`, not code; secrets referenced by env var name and resolved at spawn time | adding a type must not need a release; secret values stay out of the database | 2026-10-19 |
| Runner privileges | caps from the type, `pids_limit`, named tool-cache volume, no socket, no added capabilities by default | a runner executes untrusted workflow code; the default must be the least privilege that still builds | 2026-10-19 |
| Workflow editing | `apply_runs_on` with modes `snippet`, `pr`, `commit`, only on explicit request | the tool must never change a repository on its own | 2026-10-19 |
| Repository adoption | explicit adoption per repository; unadopted jobs are ignored; public repositories allowed with the fork risk documented | the operator decides which code runs on their hardware | 2026-10-19 |
| Retention | finished `jobs`, `runners`, `events` purged after `retention_days` (default 30) by the sweep | nothing grows unbounded; 30 days covers debugging a flaky pipeline | 2026-10-19 |
| Live updates | SSE with `sse_max_clients` and `sse_idle_s` caps | pushes state to the dashboard without polling; caps keep the connection set bounded | 2026-10-19 |
| Logging | stdout, levels, subsystem prefixes, every external call logged, stack traces on background errors | containers ship stdout; the prefixes make a multi-node log readable | 2026-10-19 |
| Licence | AGPL-3.0-only | hosted forks must stay open | 2026-10-19 |
| CI/CD | GitHub Actions on GitHub-hosted runners, three stages: checks on PR and push, `edge` images from `main`, versioned images and a release on `v*` tags; actions pinned by commit SHA | fork pull requests must never run on private hardware; pinned SHAs make the supply chain reviewable | 2026-10-19 |
| Versioning | semver tags `vX.Y.Z`, `CHANGELOG.md` (Keep a Changelog), image tags `X.Y.Z`, `X.Y`, `latest`, `edge`, `sha-<short>` | every stable point on `main` is a tag and a release with its changelog section | 2026-10-19 |
| Dependencies | pinned in `bun.lock`, frozen install in CI, Dependabot grouped weekly (bun, github-actions, docker) | reproducible builds; grouped updates keep review cheap | 2026-10-19 |
| Job log source | the owning node follows the runner container's stdout (`ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT=1`) while the job runs; GitHub's job log replaces it once the job ends, with ~2 min of retries before falling back to the runner lines | the container is the only live source; GitHub's log is the complete, timestamped record and costs one call per job | 2026-10-20 |
| Job log storage | table `job_logs (job_id, seq, at, line)` plus `jobs.log_source / log_bytes / log_truncated`; capped per job by `log_max_kb` (default 2048) with one notice line; purged with the job | lines in the database make the log readable from every node; a cap keeps a chatty job from growing the database without bound | 2026-10-20 |
| Job log follower | one module (`src/lib/joblog.ts`): follow → store in batches (64 lines / 500 ms) → emit; re-attach from the scheduler's reap with `since` = last stored timestamp; once truncated it drains without storing until the container exits | batching bounds write load and memory; re-attaching from the existing reap avoids a second loop; draining keeps the GitHub fetch aligned with the container's exit | 2026-10-20 |
| Job log delivery | `GET /api/jobs/:id/log?after=` (pages of ≤5000, max 20000), SSE `GET /api/jobs/:id/log/stream` (stored lines, then `line` batches from the bus plus a 2 s database poll for lines written on another node, then `end`), MCP `get_job_log {job_id, tail}` as text; `complete` = final log stored, or job finished and its runner gone for longer than the finalise window | one data path serves scripts, agents and the dashboard on any node; the SSE cap is shared with `/events/stream` | 2026-10-20 |
| Job page | `/jobs/:id` server-rendered: facts, `<pre class="t-code-pre">` with at most 5000 lines in the DOM, follow toggle (off when the user scrolls up), copy button with a toast, source and truncated badges; job names in the Jobs and Runners tables link to it | reading a log is the first thing an operator wants from a job; a bounded DOM keeps long logs usable | 2026-10-20 |
| Followers for hand-spawned runners | runners started with `spawn` have no job row at spawn time and are not followed; only runners claimed for a job get a log | the job row is what the log hangs on; linking idle runners to the job GitHub later hands them is a separate feature | 2026-10-20 |
| Host specs | the heartbeat asks the container engine (`docker info`: CPUs, memory, OS, version) and falls back to the process's own view per field; while the engine is down only the app version is sent and `upsertHost` keeps the stored values (`coalesce`); five nullable columns in `hosts` (`0002_host_specs`) | the engine sees the real machine, the app container only sees itself; nullable columns keep older nodes valid and the schema additive | 2026-10-20 |
| Jobs per repo | `listRepos` returns `jobCount` as a correlated count over `jobs` in the one listing query; it counts the rows that exist (only runnable jobs get a row) | one query instead of one per repo; the count means "jobs this instance handled", which is the design | 2026-10-20 |
| Webhook repair | `POST /api/repos/webhook` / MCP `ensure_webhook` reuse the GitHub client's `ensureWebhook`; with a GitHub App the call records `covered: 'app'` and creates nothing | the App delivers events for every installed repo, so a repo hook would duplicate them; the dashboard disables the button and says why | 2026-10-20 |
| Jobs filters | `listJobs` accepts `q` (case-insensitive `like` over name, repo and runner name via a left join on `runners`, `%`/`_` escaped), `since` (ISO, rejected with `invalid` otherwise), `running` (claimed, in_progress) and `failed` (failure, timed_out, cancelled); the dashboard keeps them in the URL and the quick filters pass `since` as an absolute time (pressed within 10 min of the preset) | one SQL path serves the API, MCP and the page; absolute `since` makes a shared URL mean the same thing later | 2026-10-20 |
| Label chips | the runner-type dialog edits labels as chips over a hidden `labels` field that still posts comma-separated; fixed badges (`self-hosted`, type, host) are markup, not data | the native form keeps working without JS; the fixed badges show what every runner gets without storing it | 2026-10-20 |
| Hosts page | `/hosts` reads `listHosts` + `listSlots`; "Add a host" is a dialog with instructions and an `.env` skeleton, not an API | adding hosts automatically is a non-goal; the dialog turns the empty action into the real procedure | 2026-10-20 |
| GitHub permission model | `src/lib/github/permissions.ts` holds `REQUIRED_PERMISSIONS` (`{key, level, why, breaks, modes?}`); `GitHubClient.permissions()` reports what is granted (App: `GET /app` + `GET /app/installations/{id}` + repo count; PAT: classic scopes mapped, fine-grained probed with cheap reads on one adopted repo, success = `unknown`, 403/404 = `none`); `service.githubStatus()` caches 60 s, one check in flight, 5 s timeout falls back to the last status; `missing[]` lists definite gaps only | the operator must see the gap before a job fails; fine-grained tokens expose no grant list so only absence can be proven; an unreachable GitHub must never raise a false alarm or block a page | 2026-10-20 |
| GitHub status surfaces | Settings → GitHub tab (facts, required/granted table, links to the App's permissions page and the installation, Re-check), `GET /api/github/status`, `POST /api/github/recheck`, `github: {ok, source, missing}` in `/health` (still 200), a warning banner on every page while `missing.length > 0` or source is `none`; rendered from the cached status | one cached fact feeds humans, probes and agents alike; health stays a liveness signal | 2026-10-20 |
| `apply_runs_on` hardening | permissions for the mode are checked first (`RUNS_ON_PERMISSIONS`: pr = contents, workflows, pull_requests; commit = contents, workflows) and the error names the gap and the page to fix it; `pr` works on a branch and deletes it on any failure after creation (also when nothing changed); the pull request is read back (`GET /pulls/{n}`) before `prUrl` is returned; `commit` returns `commitSha` + `htmlUrl`; failures carry GitHub's message with the HTTP status | a half-written branch or an unverified PR leaves the repository in a state the operator cannot see; GitHub's own message is the only useful diagnosis | 2026-10-20 |
| Adopt dialog | the Repos page adopts from a list (`GET /api/github/repos`: App `GET /installation/repositories`, PAT `GET /user/repos?affiliation=…`, paginated, first 500, cached 60 s, `adopted` flagged) filtered client-side; the free-text form is removed; list failures show the cause and the fix (configure access, check permissions, add repos to the installation) | known values are picked, not typed; the credentials already know the set; a typo can no longer adopt a repo GitHub cannot see | 2026-10-20 |
| Runner Docker access | `runner_types.docker text not null default 'none'` ∈ `none`, `socket`, `dind` (`0003_runner_type_docker`, both dialects); `socket` bind-mounts the node's socket path (`DOCKER_HOST` unix socket or `/var/run/docker.sock`) at `/var/run/docker.sock` and adds the socket's gid via `group_add` when it can be stat'ed (else a warning and no group); `dind` starts a `docker:28-dind` sidecar (privileged, `DOCKER_TLS_CERTDIR=`, runner network, labels runner-id + host + `octohatchery.role=dind`, never `octohatchery.runner`) before the runner and sets `DOCKER_HOST=tcp://<runner>-dind:2375`; the runner entrypoint waits up to 30 s for the daemon; the backend gains `spawnSidecar` and `removeByRunnerId`, used by the reaper, the stale sweep, `kill` and spawn failure; shipped types stay `none` | `services:` and `docker run` are common CI needs the no-daemon default cannot serve; the choice and its blast radius must be explicit per type, with the host socket named for what it is; a sidecar keyed by runner id cannot outlive its runner | 2026-10-20 |
| Runner-centred links | the Runners table (Overview) and the job page link the runner name to `/jobs?runner=<name>` (`listJobs.runner`: exact match on `runners.name`, on the API, MCP and the page, shown as a chip with a clear link), the host to `/hosts#<name>` and the template to `/templates#<name>`; host and template rows carry their name as `id` and `tr:target` is highlighted | every name an operator reads should take them to the thing it names; an exact runner filter is cheap (the join already exists for `q`) and a chip explains a filter the toolbar has no control for | 2026-10-20 |
| Image inventory | `host_images (host_id, reference, digest, size_bytes, pulled_at, seen_at)`, unique per host and reference (`0004_host_images`, both dialects); the heartbeat asks the engine for its images (`listImages`: one entry per tag, repo digest, size, creation time) and rewrites this host's rows for the wanted references only — every template's image, `runner_image_default`, the dind sidecar — deleting rows for images no longer present or no longer wanted; a change emits `image` on the bus. `pulled_at` holds the image's build time and is labelled as such: engines do not record pull time | the engine is the only truth about what a host holds, and each node sees only its own engine, so the inventory is per node and refreshed where it is cheap (the heartbeat already talks to the engine); limiting rows to wanted references keeps the table proportional to templates, not to whatever else lives on the host | 2026-10-20 |
| Image pulls | `image_pulls (host_id, reference, status, error, requested_by, created_at, finished_at)`; `POST /api/hosts/:name/images/pull` / MCP `pull_image` validate the reference (same shape as `runner_image_default`, must be a wanted reference, host online), reuse a queued/running row for the same cell, insert `queued` and record `image.pull`; each node's scheduler tick claims the oldest queued pull for its own host when none runs there and runs it in the background (`backend.pull`), then refreshes `host_images`, writes `done`/`failed` with the engine's error, records `image.pulled`/`image.pull_failed` and emits `image`; pulls left `running` by a dead node are failed with a reason on its next start; finished pulls are purged with `retention_days`; `GET /api/images` returns references × hosts × latest pull per cell | the cluster rule is that a node touches only its own engine, so a pull for another host must be a row that host's node picks up; the existing tick is the natural poll and a background pull keeps job claiming unaffected; refusing unknown references keeps the inventory to what templates need and removes a free-text path to arbitrary pulls | 2026-10-20 |
| Jobs paging | `listJobs` takes `page`/`per` (offset paging, `per` ∈ {10, 25, 50, 100} enforced at the route and capped at 100 in the facade; without `per` the old `limit` path is unchanged) and `countJobs(filter)` shares one `where` builder; `GET /api/jobs` returns `total`, `page`, `per`; the Jobs page shows 25 per page with a pager and a per-page select, a page past the end lands on the last one | nothing on the dashboard may be one unbounded list; offset paging is enough for a 30-day retention window and keeps the API one query plus one count | 2026-10-20 |
| Recent jobs card | one `src/views/jobs-table.tsx` (`JobsToolbar`, `JobsTable`, `JobsPager`) parameterised by a `JobsScope` (base path, query-param prefix, id prefix, default page size) renders both `/jobs` and the Overview card; the card uses the `j_` prefix, ten rows, "Show all" = 50 per page still paged, header count + "All jobs →" with the same filters; it is its own live block (`data-partial="jobs"`, `GET /?partial=jobs`) and `app.js` refreshes several `[data-live]` blocks independently, skipping one whose field has focus | one table component keeps the two views identical; a prefix lets two lists share a URL without stepping on each other; a bounded card keeps the Overview a glance, the Jobs page the place to dig | 2026-10-20 |
| Job log groups | `src/views/log-groups.ts` folds `##[group]<title>`…`##[endgroup]` and `##[section]Starting/Finishing: <step>` into one level of `<details class="log-group">` (a new group closes the one before it, an unterminated one runs to the end and stays open), marker lines stay in the DOM hidden (so Copy and the 5000-line cap count stored lines), `##[error]`/`##[warning]` lines carry `data-tone` and an error opens its group; `public/app.js` applies the same rules to streamed lines (the server marks the still-open group without `data-closed`), folds earlier groups as they close and trims the oldest lines across groups; Expand all / Collapse all; `?raw=1` renders the flat view | GitHub's own viewer folds these markers and operators expect it; one level keeps both parsers small and identical; keeping markers in the DOM makes copied text equal to the stored log and the DOM bound honest | 2026-10-20 |
| Validation messages | `validationMessage()` in `src/lib/json.ts` turns Elysia's validation error into `<where> <param>: <summary>` (union literals listed as `expected one of …`) for the API and the pages | in production Elysia's `message` is a JSON blob, so the first line said `{`; errors must carry a reason | 2026-10-20 |
| Templates tabs and Images page | `/templates` and `/templates/images` share one page header and a `.t-tabs` row of links (own URL per tab, nav keeps Templates active); the Images table is `references × hosts` with `present` (digest, size, build time), `missing` (+ last pull error) or `pulling` cells, an icon-only Pull now per cell (`aria-busy` while queued/running, disabled when the host is offline), Pull on all hosts per row and a live block on `image` events (`?partial=1`); Add image is a select of listed references missing on an online host that pulls on each, never free text; the template dialog appends `· missing on <hosts>` to each image option and shows a warning with inline Pull on <host> buttons when the picked image is missing on a host that has slots for the template | a separate page keeps Templates readable while images get the room a matrix needs; links as tabs keep the browser's history and sharing working; the matrix is the place to see and fix a slow first job before it happens; the inventory makes "known values are picked, not typed" possible for images | 2026-10-20 |
| Job steps | `jobs.steps text not null default '[]'` (`0005_job_steps`, both dialects) holds GitHub's `steps[]` (`number, name, status, conclusion, startedAt, completedAt`); the webhook stores them on `in_progress` and `completed` (a `completed` payload without steps keeps the stored ones), the finaliser fetches `GET /repos/{o}/{r}/actions/jobs/{id}` (new client method `getJob`) before the log and stores its steps; `backfillSteps` runs in every node's `sweepOnce` before the leader check, at most 5 calls per pass, each job once per process, over completed jobs with `log_source = 'github'` and empty steps; `GET /api/jobs/:id` returns `steps` | the step list is the structure GitHub's own log viewer hangs on and operators expect it; the webhook gives it live, the job API gives the final second-precision timestamps; a failed fetch must never cost the log; running the backfill on every node lets a non-leader node (the one with the new code first) fill its rows and makes the pass idempotent without coordination | 2026-10-20 |
| Steps view | `src/views/log-steps.ts` (pure): lines are refined first (blank lines dropped, a run of consecutive progress lines — `Received N of M`, leading percentage, `NN% (a/b)` — collapsed to its last line), then assigned to the last step whose `startedAt` ≤ the line's stamp at ms precision (before the first step → first step, after the last → last step, unreadable stamp → the previous line's step, an `##[endgroup]` stays with the step that opened its group), then the one-level `##[group]` folding runs inside each step; a job without steps gets one pseudo-step "Log" with the job's state; `<details class="log-step">` rows carry `data-number/-status/-conclusion/-started/-completed/-count`, a failed or running step opens, the gutter is `mm:ss` since `jobs.started_at` with the absolute stamp as `data-tip`, `##[command]`/`[command]` lines render as `data-cmd` with the marker stripped; durations `0s`, `2m 20s`, `1h 2m` (`shortDuration`) on the rows and on the header outcome line (`<verb> <RelTime> in|for <duration>`); `?raw=1` is the flat view unchanged; `GET /jobs/:id?partial=log` returns `#job-live` (lead, outcome, steps) which `public/app.js` swaps by id on a `job` SSE event for that job, keeping each step's open state and catching up on lines streamed meanwhile (`?after=`); streamed lines go to the step running at their stamp (else the `in_progress` step, else the last), the same refine rules apply, the 5000-line cap trims the oldest lines across steps; the line count shown is the lines in view after refining | GitHub's step list is the reading structure operators know; timestamps are the only join between a log line and a step GitHub gives us, and second-precision step times make the endgroup rule necessary; refining happens before assignment so counts and the DOM bound describe what is shown; a pseudo-step keeps one code path for jobs that predate steps or run on a poll-only path; re-rendering the block server-side on `job` events keeps one renderer for the steps instead of a second one in the browser | 2026-10-20 |
| Overview slots | each template row on a host is the name left and one circle per slot right-aligned (`justify-content: flex-end`); a live runner (`spawning`, `idle`, `busy`, by `createdAt`) is a capsule ending in its slot's filled circle (state tone, job label + repo, link to the job, × kill via `data-action="kill"`), placed before the free circles so a busier row grows to the left; `max(0, used − seated)` claimed circles without a runner; the separate Runners table is gone; the Overview main is a flex column so Recent jobs takes the remaining height (min 18rem) and its `.t-table-wrap` scrolls | the user wants hosts, templates, slots and the runner in each slot in one card and the whole Overview in one window; a runner shown in its own slot answers "what runs where" without a second table; right-aligned circles keep the free capacity in one fixed column across rows | 2026-10-21 |
