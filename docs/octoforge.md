# Running under Octoforge

[Octoforge](https://github.com/rojosinalma/octoforge) is a small app that groups the octo GitHub tools. It
shows one card per tool, creates GitHub Apps or tokens for them and hands those over, and can host every
tool's data in one shared database. OctoHatchery is one of those tools ("members").

All of this is optional. Without `OCTOFORGE_TOKEN` OctoHatchery behaves exactly as it does on its own, and
every `/api/octoforge/*` path answers 404.

## Enabling it

Set the same random value in Octoforge's `.env` and in OctoHatchery's `.env`:

```sh
OCTOFORGE_TOKEN=<a long random string, for example: openssl rand -hex 32>
```

Restart the node. In a cluster, set it on every node.

With `OCTOFORGE_TOKEN` set, a node can start without any GitHub variables (`GITHUB_AUTH`, `GITHUB_APP_ID`,
`GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET` all unset). It then has no GitHub access: the dashboard says so,
adopting a repo and spawning a runner fail with "no GitHub credential yet", and the node waits for Octoforge
to deliver a credential.

## The manifest

`octoforge.json` at the root of this repository describes what OctoHatchery needs: the GitHub App
permissions and events, the token scopes, the database engines it supports and the names of its
environment variables. The same document is served at `GET /api/octoforge/manifest`. The App permissions
are the ones in [github-app-manifest.json](github-app-manifest.json); a test keeps the two in step.

## Routes

Every route except `GET /manifest` needs `Authorization: Bearer <OCTOFORGE_TOKEN>`. A missing or wrong
token gets 401. Answers use the usual `{ok, message, ...data}` shape.

| Route | Does |
|---|---|
| `GET /api/octoforge/manifest` | The `octoforge.json` document. No token needed. |
| `GET /api/octoforge/status` | `{contract, version, github: {mode, source, app_id?, login?}, database: {engine, schema?, source}}`. `source` is `env`, `octoforge` or `none`. Never a secret. |
| `PUT /api/octoforge/github` | Hands over a GitHub credential (below). |
| `DELETE /api/octoforge/github` | Drops the handed-over credential; the node goes back to its `.env` values. |
| `POST /api/octoforge/database/adopt` | Moves OctoHatchery's data into a shared database (see [Database](#database)). |
| `DELETE /api/octoforge/database` | Drops the adopted database setting; the next start uses `DATABASE_URL` again. |

Each change is recorded as an audit event with actor `octoforge` (`github.delivered`, `github.dropped`,
`database.adopted`, `database.dropped`), without any secret.

## GitHub credentials

`PUT /api/octoforge/github` takes one of two bodies:

```json
{ "mode": "pat", "token": "github_pat_…" }
{ "mode": "app", "app_id": 123456, "private_key": "-----BEGIN RSA PRIVATE KEY-----\n…", "webhook_secret": "…", "installation_id": 7890 }
```

`installation_id` is optional, as `GITHUB_APP_INSTALLATION_ID` is. OctoHatchery checks the credential with
GitHub first: `GET /user` for a token, `GET /app` with a signed JWT for an App. If GitHub refuses it, the
answer is 400 with GitHub's reason; if GitHub cannot be reached, 502. In both cases nothing is stored.

On success the answer carries the token's `login` or the App's `app_slug` and `restart_required: false`:
the node switches to the new credential at once.

How it is stored, plainly: the credential goes into the `settings` table under the key `octoforge_github`,
**in plain text**. Anyone who can read the database can read the token or the App's private key. Protect
the database the way you protect `.env`. The key never shows up in `GET /api/settings`, the MCP
`get_settings` tool or the Settings page, and `PUT /api/settings/octoforge_github` is refused.

Rules that follow from it:

- A handed-over credential wins over the `.env` values. `DELETE /api/octoforge/github` removes it and the
  node goes back to `.env` (or to no GitHub access if `.env` has none).
- A token comes without a webhook secret. OctoHatchery uses `GITHUB_WEBHOOK_SECRET` when it is set, and
  otherwise generates one, stores it under `octoforge_webhook_secret` (also hidden) and registers repo
  webhooks with it. Webhooks registered before the switch keep their old secret: use the repo's **Repair webhook**
  button on the Repos page (or `POST /api/repos/webhook`) to update them.
- An App brings its own webhook secret; deliveries are verified against it from then on.
- In a cluster, Octoforge calls one node. Every node reads the shared `settings` table on each scheduler pass
  (every few seconds, settings are cached for 5 s), so all nodes use the new credential within about 15
  seconds, without a restart. The node logs `[github] credential changed: <mode> from <source>`.
- Settings → GitHub shows "(delivered by Octoforge)" next to the mode, and `GET /api/github/status` carries
  `credentialSource`.

## Database

On its own, OctoHatchery keeps its data where `DATABASE_URL` points: a SQLite file by default, or a
PostgreSQL database. Octoforge can move that data into a shared database, where every tool gets its own
PostgreSQL schema (or its own SQLite file in a shared folder) and still runs its own migrations.

### Schemas

On PostgreSQL, OctoHatchery keeps its tables in the schema named by `DATABASE_SCHEMA` (default
`octohatchery`), and its migrations journal (`__drizzle_migrations`) sits in that same schema. Every connection
opens with `search_path` set to it, so several tools can share one database without seeing each other's
tables. The schema is created when it is missing. A role that owns its schema but cannot create schemas in the
database works too. SQLite ignores `DATABASE_SCHEMA`.

Installs from before `DATABASE_SCHEMA` have their tables in `public`. See
[operations.md](operations.md#upgrade) for how those are detected and how to move them.

### Adopting a database

`POST /api/octoforge/database/adopt` with `{"url": "postgres://…", "schema": "octohatchery", "copy": true}`:

1. OctoHatchery opens `url`, creates `schema` when it is missing and runs its migrations there.
2. With `copy: true` (the default) every table of the new database must be empty, or the call fails with
   409 and names the tables that hold rows. Then every row is copied, table by table with parents first,
   keeping the ids. Booleans and numbers are converted between SQLite and PostgreSQL, and PostgreSQL
   sequences are moved past the copied ids.
3. The copy runs in one transaction on the new database, from one consistent snapshot of the current one.
   Afterwards the row count of every table is compared with the source. If any count differs, the
   transaction is rolled back, the call fails with 409 and nothing changes.
4. The URL and schema are written to `DATA_DIR/octoforge-database.json` (mode 0600, written to a temporary
   file first and then renamed).
5. The answer lists the row count per table and says `restart_required: true`.

Nothing changes until you restart: the node keeps using its current database. Rows written between the
copy and the restart stay in the old database, so adopt while the node is quiet (no jobs running) and
restart straight away.

A `url` that is not `sqlite:` or `postgres://`, or a schema that is not a lowercase name (letters, digits,
`_`, not starting with `pg_`), gets 400. A database that cannot be reached gets 503. In cluster mode a
SQLite `url` is refused, because a file cannot be shared between nodes. The URL is never logged or
returned. The log shows one `[db] adopt: <table> <rows>` line per table and a summary.

### The override file

At start-up, `DATA_DIR/octoforge-database.json` wins over `DATABASE_URL` and `DATABASE_SCHEMA`:

```json
{ "url": "postgres://octohatchery:…@db:5432/octoforge?sslmode=require", "schema": "octohatchery", "adopted_at": "2026-10-21T10:00:00.000Z" }
```

The start-up log says which one was used (`from DATABASE_URL` or `from octoforge-database.json`), with the
password masked. A file that cannot be read, or that names SQLite while `MODE=cluster`, stops the start with
a reason. Fix the file or delete it. The file holds the database password: keep `DATA_DIR` as private as
`.env`. `GET /api/octoforge/status` reports `database: {engine, schema, source}`, where `source` is
`octoforge` when the file was used.

### Clusters

All nodes share one database, and each node reads its own `DATA_DIR`:

1. Call adopt with `copy: true` on one node. That copies the data.
2. Call adopt with the same `url` and `schema` and `copy: false` on every other node. That only checks the
   new database and writes the file.
3. Restart every node.

### Rolling back

The old database is never changed by an adoption. To go back, call `DELETE /api/octoforge/database` on each
node (it removes the override file) and restart it. Rows written after the adoption stay in the adopted
database only.
