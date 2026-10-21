# OctoHatchery

[![Checks](https://github.com/rojosinalma/octohatchery/actions/workflows/run-checks.yml/badge.svg)](https://github.com/rojosinalma/octohatchery/actions/workflows/run-checks.yml)
[![Release](https://img.shields.io/github/v/release/rojosinalma/octohatchery?sort=semver)](https://github.com/rojosinalma/octohatchery/releases)
[![Licence: AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue.svg)](LICENSE)

One brain, many hosts, one tentacle per job: self-hosted GitHub Actions runners that appear when a job queues and vanish when it finishes.

OctoHatchery watches the repositories you adopt. When GitHub queues a job that asks for one of your runner types, it starts a fresh, single-use runner container on a host that has a free slot, lets GitHub's runner binary execute the job, then removes the container and its registration. Nothing waits around between jobs, and every job starts from a clean image.

What you get:

- **One ephemeral runner per job.** Each runner is registered just in time with a single-use configuration and is gone after one job.
- **Runner types.** A type is a row, not code: image, CPU and memory caps, extra mounts, environment and the names of secrets to pass in. Jobs pick a type with `runs-on`.
- **Slots per host.** You decide how many runners of each type a host may run at once. The scheduler never spawns past that.
- **Single or cluster mode.** One node with SQLite, or several nodes sharing a PostgreSQL database and claiming jobs for their own hosts.
- **Dashboard, JSON API and MCP.** See slots, runners, jobs and the audit log in a browser, script everything over HTTP, or hand the same controls to an agent through the Model Context Protocol.
- **GitHub App or personal access token.** Use whichever fits your account.

Why I built it: a personal GitHub account cannot share one self-hosted runner across repositories. Runners register per repository, and the only way around that is an organisation, which means moving every repository. Hosted minutes cost money the moment private repositories build container images. OctoHatchery registers a runner for a specific job on demand, so one pool of hosts serves every repository you adopt, personal or organisation, without a permanent runner anywhere.

OctoHatchery is not affiliated with or endorsed by GitHub. GitHub, GitHub Actions and Octocat are trademarks of GitHub, Inc. The octopus here is just a metaphor.

## Requirements

- Docker Engine 24 or newer with Compose v2 on every host that runs runners.
- A GitHub account or organisation, with either a GitHub App you install or a personal access token.
- A public HTTPS URL that GitHub can reach for webhooks, with a reverse proxy in front (see the security notes under Installation).
- Cluster mode only: PostgreSQL 14 or newer.
- Development only: Bun 1.4 or newer.

## Installation

1. Get the compose file and the environment template:

   ```sh
   git clone https://github.com/rojosinalma/octohatchery.git
   cd octohatchery
   cp .env.example .env
   ```

2. Set up GitHub access. [docs/github-app.md](docs/github-app.md) walks through both options: creating a GitHub App from the shipped manifest (recommended) or using a personal access token. Put the resulting values in `.env`.

3. Fill in the rest of `.env`: `MODE` (`single` or `cluster`), `DATABASE_URL`, `HOST_NAME`, `GITHUB_WEBHOOK_SECRET` and the public URL GitHub should call. Every key is documented in [docs/operations.md](docs/operations.md#configuration).

4. Start the node:

   ```sh
   docker compose up -d
   ```

   This starts the app on port 3000 and a `buildkitd` sidecar that runners use for container builds. Open the dashboard, check `/health`, and you are ready to adopt repositories.

For a cluster (several hosts sharing one PostgreSQL database), repeat on each host with the same secrets and a distinct `HOST_NAME`. Details in [docs/operations.md](docs/operations.md#cluster-mode).

### Security notes, read before exposing it

- **There is no login.** The dashboard, API and MCP endpoint trust whoever reaches them. Put OctoHatchery behind a reverse proxy with SSO (Authentik, Authelia, Cloudflare Access, OAuth2 Proxy or similar) and expose only `POST /webhooks/github` without authentication.
- **Webhooks are signed.** Every webhook is checked against `GITHUB_WEBHOOK_SECRET` with HMAC SHA-256 before anything is read from it.
- **The app talks to Docker.** Each node mounts its host's Docker socket (or whatever `DOCKER_HOST` points at). Anyone who controls the app controls that Docker daemon, so treat the app host as trusted.
- **Runners get no Docker by default.** A runner type's **Docker** option decides: `none` (default; builds still go through the shared BuildKit, `services:` and `docker run` fail), `socket` (the host's socket is mounted: every job on that type can control every container on the host, including OctoHatchery) or `dind` (a privileged Docker-in-Docker sidecar per runner, isolated but slower). Use `socket` only for repositories you fully trust; details in [docs/runner-types.md](docs/runner-types.md#docker-access).
- **Permissions are checked, not assumed.** Settings → GitHub compares what the App or token grants with what OctoHatchery needs and says what breaks without each one; a missing permission shows as a banner on every page and in `/health`.
- **Public repositories and forks.** A workflow in a pull request from a fork runs on your hardware if the repository allows it. For public repositories, keep GitHub's "require approval for first-time contributors" setting on, or restrict self-hosted jobs to trusted branches.

## Usage

### Adopt a repository

Open the dashboard, go to **Repos** and press **Adopt a repo**: the dialog lists the repositories your GitHub App installations or token can reach; one click adopts. One App can serve your own account and organisations at once: tick the accounts on **Settings → GitHub** ([docs/github-app.md](docs/github-app.md#serving-several-accounts)). With a token OctoHatchery also registers a webhook for `workflow_job` events; with an App the App's webhook already covers the repo. The same action is available as `POST /api/repos/adopt` and as the MCP tool `adopt_repo`.

### Point a workflow at a runner type

Every runner carries the labels `self-hosted`, its type name and its host name. Pick a type:

```yaml
jobs:
  build:
    runs-on: [self-hosted, generic]
```

Pin a host too when the job needs something only that host has:

```yaml
    runs-on: [self-hosted, generic, build-host-1]
```

The **Repos** page shows the exact snippet for each type. If you prefer, `apply_runs_on` (API or MCP) can open a pull request or commit the change for you.

### Concepts

- **Runner type**: a named recipe for a runner. Image, labels, caps, mounts, env and secret names. Managed from the **Templates** page of the dashboard, the API or MCP.
- **Slot**: the number of runners of one type a host may run at the same time. One slot is taken while a runner spawns, runs and exits.
- **Host**: a node running OctoHatchery with access to a Docker daemon. Hosts register themselves on start.
- **Mode**: `single` runs one node on SQLite or PostgreSQL. `cluster` needs PostgreSQL and lets several nodes claim jobs for their own hosts, with one elected leader running housekeeping.
- **Adoption**: the explicit act of letting a repository use your runners. Jobs from repositories you did not adopt are ignored.
- **`apply_runs_on`**: edits the `runs-on` line in a repository's workflows on request, in one of three modes: `snippet` (just show it), `pr` (open a pull request) or `commit` (commit to the default branch).

### Interfaces

- Dashboard at `/`: Overview, Repos, Jobs (with a live log per job), Templates, Hosts, Events, Settings. See [docs/dashboard.md](docs/dashboard.md).
- JSON API under `/api/`: every response is `{ "ok": true|false, "message": "...", ...data }`.
- MCP at `/mcp` (Streamable HTTP) with the same actions as tools. See [docs/mcp.md](docs/mcp.md).
- `GET /health` for monitoring, `GET /metrics` for Prometheus, `GET /events/stream` for live updates over SSE, `GET /api/jobs/:id/log/stream` for one job's log.

### Documentation

- [docs/github-app.md](docs/github-app.md): GitHub App manifest and setup, personal access token setup.
- [docs/runner-types.md](docs/runner-types.md): the runner image, writing your own types, secrets and mounts.
- [docs/dashboard.md](docs/dashboard.md): the six pages and what each control does.
- [docs/mcp.md](docs/mcp.md): MCP tools and how to connect an agent.
- [docs/operations.md](docs/operations.md): configuration, single and cluster mode, upgrades, backups, troubleshooting, teardown.
- [docs/octoforge.md](docs/octoforge.md): running under Octoforge: the manifest, the member API, handing over GitHub credentials, the shared database and the member switcher.
- [docs/SDD.md](docs/SDD.md): software design document and the design decisions log.

## Development

```sh
bun install --frozen-lockfile
bun --watch src/index.ts      # live reload on port 3000
bun run typecheck
bun test
bin/verify                     # install, typecheck, tests and a health probe, the same as CI
```

Layout: `src/lib/` holds the logic, `src/db/` the schema and migrations, `src/routes/` the HTTP layer, `src/mcp/` the MCP tools, `src/views/` the server-rendered pages and `runner/` the runner image. Tests live in `test/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and [docs/SDD.md](docs/SDD.md) for the design and the decisions behind it.

## License

[AGPL-3.0-only](LICENSE). Copyright 2026 rojosinalma.
