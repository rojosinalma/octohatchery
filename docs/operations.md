# Operations

How to run, upgrade, back up, debug and remove OctoHatchery. The design behind it is in [SDD.md](SDD.md); GitHub credentials are covered in [github-app.md](github-app.md).

## Configuration

Two layers. `.env` holds bootstrap values and secrets and is read once at start. The `settings` table holds tunables that you change at runtime from the Settings page, `PUT /api/settings/:key` or the MCP tools, with no restart.

### `.env`

`.env.example` in the repository lists every key with a placeholder. Copy it to `.env` and fill it in. `.env` is ignored by git and must never be committed.

| Key | Required | Meaning |
|---|---|---|
| `MODE` | yes | `single` or `cluster`. `cluster` refuses to start on SQLite. |
| `HOST_NAME` | yes | The name this node registers as a host and puts on its runners as a label. Unique per node. |
| `PORT` | no | HTTP port inside the container. Default `3000`. |
| `DATABASE_URL` | yes | `sqlite:<path>` for SQLite (for example `sqlite:./data/octohatchery.db`) or `postgres://` URL for PostgreSQL. The scheme selects the driver. Use `sslmode=require` on PostgreSQL over a network. |
| `DATABASE_SCHEMA` | no | PostgreSQL only: the schema that holds the tables and the migrations journal. Default `octohatchery`. A lowercase name (letters, digits, `_`, not starting with `pg_`). Created when missing. Several tools, or several OctoHatchery installs, can share one database with one schema each. SQLite ignores it. See the upgrade note below for installs from before this setting. |
| `DOCKER_HOST` | no | Where the Docker daemon is. Default is the mounted socket `/var/run/docker.sock`. |
| `DIND_CERTS_DIR` | no | Host folder in the layout Docker reads private registry CAs from (`<registry>/ca.crt`, for example `/etc/docker/certs.d`). Mounted read-only at `/etc/docker/certs.d` in every Docker-in-Docker daemon, so jobs can pull from and push to registries signed by that CA. Unset = no mount. An absolute path on the host, not in the app container. |
| `PUBLIC_URL` | yes | The HTTPS URL GitHub reaches you at. Webhooks are registered as `<PUBLIC_URL>/webhooks/github`. |
| `GITHUB_AUTH` | yes | `app` or `pat`. |
| `GITHUB_APP_ID` | with `app` | The GitHub App id. |
| `GITHUB_APP_PRIVATE_KEY` | with `app` | The App's PEM private key, newlines as `\n`. |
| `GITHUB_APP_INSTALLATION_ID` | no | The default installation. Without it the App's installations are discovered; see `github_accounts`. |
| `GITHUB_TOKEN` | with `pat` | A personal access token with repository and runner administration scopes. |
| `GITHUB_WEBHOOK_SECRET` | yes | Random string. OctoHatchery sets it on every webhook it registers and verifies every delivery against it. |
| `OCTOFORGE_TOKEN` | no | Bearer token for the [Octoforge](octoforge.md) member API under `/api/octoforge`. Unset, those routes do not exist. Set, the node may start without any `GITHUB_*` value and wait for Octoforge to hand one over; a handed-over credential wins over the `GITHUB_*` values. |
| any name a runner type lists under secret env | per type | Values for secrets a runner type passes into its containers. Read at spawn time; a missing one fails the spawn with a reason. |

Every node in a cluster needs the same GitHub values and webhook secret, its own `HOST_NAME`, and the same `DATABASE_URL` and `DATABASE_SCHEMA`. Secrets a runner type needs must be present on every host that has a slot for that type.

### `settings` table

| Key | Default | Meaning |
|---|---|---|
| `poll_interval_s` | `300` | How often the leader lists queued jobs over the REST API to catch webhooks that were missed. |
| `stale_runner_minutes` | `5` | A runner without a job for this long is removed and deregistered. |
| `retention_days` | `30` | Finished jobs, runners and events older than this are deleted, together with their stored logs. |
| `dind_cache_max_gb` | `20` | Templates with `dockerCache: repo`: a kept daemon store above this size (images plus build cache) is emptied before its next job. |
| `dind_cache_idle_days` | `7` | Templates with `dockerCache: repo`: the stores of a template and repository with no runner on a host for this many days are removed from that host. `0` keeps them. |
| `log_max_kb` | `2048` | Most log text stored per job. Beyond it the stored log stops with a notice; the full log stays on GitHub. |
| `sse_max_clients` | `20` | Maximum open `/events/stream` connections per node. |
| `sse_idle_s` | `300` | An SSE client that received nothing for this long is disconnected. |
| `log_level` | `info` | `debug`, `info`, `warn` or `error`. |
| `buildkit_host` | `tcp://octohatchery-buildkitd:1234` | `BUILDKIT_HOST` injected into every runner. Points at the sidecar on the compose network. |
| `runner_image_default` | `ghcr.io/rojosinalma/octohatchery-runner:edge` | The image preselected when a template is created on the dashboard. |
| `github_accounts` | empty | GitHub App only: the accounts (comma-separated logins) whose installations are served. Empty serves the default installation, or every installation when `GITHUB_APP_INSTALLATION_ID` is not set. Set it with the checkboxes on Settings → GitHub. |

Settings are read at use time with a cache of at most five seconds, so a change is live within that window on every node.

## Single node

The quickest setup. One host, SQLite, no database server.

```sh
git clone https://github.com/rojosinalma/octohatchery.git
cd octohatchery
cp .env.example .env
```

In `.env` set `MODE=single`, `HOST_NAME` to a short name for this machine, `DATABASE_URL` to a SQLite path inside the data volume (the example file shows the form), your `PUBLIC_URL`, the GitHub values and a webhook secret (`openssl rand -hex 32` makes a good one). Then:

```sh
docker compose up -d
curl -s http://localhost:3000/health
```

`ok: true` means the database opened and Docker answered. Put a reverse proxy with SSO in front, exposing `POST /webhooks/github` without authentication, and adopt your first repository from the dashboard.

`compose.yaml` pulls `ghcr.io/rojosinalma/octohatchery:latest` and starts the `buildkitd` sidecar next to it. The app's data (the SQLite file) lives in a named volume. Runners get their tools from the runner image, not from a volume.

## Cluster mode

Several hosts share one PostgreSQL database and one queue. Each host runs its own node and claims jobs only for its own slots. One node at a time is the leader and does the housekeeping.

1. Create a PostgreSQL database and role for OctoHatchery. Require TLS if the database is on another machine.
2. On each host, clone the repository, copy `.env.example` to `.env`, and set:
   - `MODE=cluster`
   - `HOST_NAME` unique per host, for example `build-1`, `build-2`
   - the same `DATABASE_URL`, `GITHUB_*` values, `GITHUB_WEBHOOK_SECRET` and `PUBLIC_URL` on every host
   - any secret a runner type lists, on every host that will run that type
3. Start the first node with `docker compose up -d`. It takes the leader lock and runs the migrations.
4. Start the other nodes. They register as hosts and show up on the Overview page.
5. Give each host slots per runner type from the Runner types page, `PUT /api/slots` or the MCP tool `set_slots`.

The `PUBLIC_URL` is one address for the whole cluster. Any node can receive a webhook; it only writes a `jobs` row, and whichever node has a free slot claims it. Point your proxy or load balancer at every node.

`/health` on each node reports `leader: true` on exactly one of them.

## Upgrade

1. Read the `CHANGELOG.md` section for the new version, in particular "Upgrade notes".
2. Change the image tag in `compose.yaml` if you pin one, then on each host:

   ```sh
   docker compose pull
   docker compose up -d
   ```

3. Check `/health` and the Overview page on each node.

### Tables in `public` (installs from before `DATABASE_SCHEMA`)

Older versions kept the tables in the `public` schema and the migrations journal in a schema called `drizzle`. When `DATABASE_SCHEMA` is not set, the database has a `hosts` table in `public`, and the schema `octohatchery` has none, OctoHatchery keeps using `public` as before and logs once at start:

```
tables found in schema public; set DATABASE_SCHEMA=public to silence this, or adopt a database to move
```

Nothing moves, and upgraded and older nodes still elect one leader between them. To make it explicit, set `DATABASE_SCHEMA=public` on every node. To move the data into its own schema, adopt a database (see [octoforge.md](octoforge.md#database)): it copies every row into the new schema, checks the counts and switches over on restart. An explicit `DATABASE_SCHEMA` always wins over the detection.

`DATA_DIR/octoforge-database.json`, written by an adoption, overrides `DATABASE_URL` and `DATABASE_SCHEMA` at start. Delete it (or call `DELETE /api/octoforge/database`) and restart to go back.

Running runners keep going through an upgrade: the new node process re-attaches to containers by their `octohatchery.runner` labels and reaps them when they exit. Migrations are additive, so in a cluster you can upgrade nodes one at a time. The runner image is pulled by tag at spawn time; change it on the runner type to roll it out.

## Backups

The database is the only state worth backing up. Use your usual PostgreSQL backup for cluster mode, or copy the SQLite file out of the data volume while the app is stopped in single mode.

Everything else is re-creatable:

- Runner containers are ephemeral by design.
- Webhooks are re-registered when you adopt a repository again, and the leader's polling fallback finds queued jobs even without them.
- `.env` is yours to keep safe; it is not in the database.

## Troubleshooting

Start with `GET /health`. It returns 200 only when the database and Docker both answer, and its JSON tells you which part failed:

| Field | Meaning |
|---|---|
| `ok` | `true` when `db` and `docker` are both `true` |
| `mode`, `host`, `version` | what this node thinks it is |
| `db` | the database answered a trivial query |
| `docker` | the Docker daemon answered `ping` |
| `leader` | this node holds the lease |
| `slots` | per host and type: `count`, `used`, `free` |
| `queued` | jobs waiting for a slot |
| `runnersBusy` | runners currently executing a job |
| `lastWebhookAt` | time of the last valid webhook, `null` if none since start |

Then read the logs, filtered by subsystem:

```sh
docker compose logs -f app | grep '\[scheduler\]'
```

Common failures:

**`docker: false`** The app cannot reach the daemon. Check that `/var/run/docker.sock` is mounted into the `app` container (or that `DOCKER_HOST` is right) and that the socket's group allows the container user. This node claims nothing until Docker is back.

**`db: false`** The database is unreachable. Check `DATABASE_URL`, network and TLS. The scheduler backs off and retries; nothing is lost, jobs stay queued at GitHub and the polling fallback picks them up when the database returns.

**Webhook deliveries fail with 401 or 400** The signature did not match or the payload was not a `workflow_job` event. Compare `GITHUB_WEBHOOK_SECRET` with the secret on the webhook in the repository settings (GitHub → Settings → Webhooks → Recent deliveries shows the response). If you changed the secret, unadopt and adopt the repository to re-register the webhook. Make sure your proxy passes `POST /webhooks/github` through without authentication and without rewriting the body.

**Jobs stay `queued` at GitHub and never appear in OctoHatchery** The repository is not adopted, or the webhook never arrived. Check the Repos page and `lastWebhookAt`. The polling fallback runs every `poll_interval_s`, so a missed webhook costs at most that long.

**Jobs appear as `ignored`** The job's `runs-on` labels did not match any runner type. The Events page shows the labels it asked for. Add the type or fix the workflow.

**Jobs stay `queued` in OctoHatchery** No host has a free slot for the matching type, or every host with slots is offline. Check `slots` in `/health` and the Overview page.

**Runners stuck in `spawning` or `idle`** The container started but the runner did not pick up the job, usually because the JIT configuration expired or GitHub gave the job to another runner. The sweep removes them after `stale_runner_minutes`. If it happens often, look at `[github]` log lines for the JIT call and at the container's own log with `docker logs <container>`.

**A finished job shows conclusion `unknown`** Its runner exited, no `completed` webhook had arrived, and GitHub's job API did not answer either (rate limit, outage, missing permission). OctoHatchery never guesses `failure` from the runner's exit code: an ephemeral runner exits 0 after any job and non-zero only for its own errors. The leader asks GitHub again on its next sweep (newest first, at most 10 jobs per pass, rows from the last 24 hours) and records a `job.reconciled` event on the Events page when the row changes. The same pass fixes jobs left `claimed` or `in_progress` after their runner was gone, which happens when an installation's webhooks arrive late: GitHub names the runner that ran each job, and the row follows it.

**Runner exits immediately** Run `docker logs` on the container before the reaper removes it, or spawn one by hand from the Runner types page and watch it. Typical causes: a secret env name the host does not have (the spawn fails with the name in the reason), an image that cannot be pulled, or a mount path that does not exist on the host.

**Container builds inside jobs fail to reach BuildKit** The runner must be on the same compose network as the `buildkitd` sidecar and `buildkit_host` must match the sidecar's name and port. `docker compose ps` shows whether the sidecar is up.

**Two leaders or no leader** Only in cluster mode. Both nodes must point at the same PostgreSQL database; the advisory lock lives there. A node that lost its connection drops the lease, and another takes it on its next tick.

## Teardown

On each host:

1. Unadopt every repository from the Repos page, `POST /api/repos/unadopt` or the MCP tool `unadopt_repo`. This removes the webhooks.
2. Stop the node and remove its containers and volumes:

   ```sh
   docker compose down --volumes
   ```

   Any runner containers still present are labelled `octohatchery.runner=true`; `docker ps -a --filter label=octohatchery.runner=true -q | xargs -r docker rm -f` removes them.

3. Drop the PostgreSQL database and role if you created them for this, or delete the SQLite volume (already gone with `--volumes`).
4. Uninstall the GitHub App from your account or organisation, or revoke the personal access token, and remove the reverse proxy route.
