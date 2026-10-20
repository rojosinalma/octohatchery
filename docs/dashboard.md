# Dashboard

The dashboard is a server-rendered web UI on the same port as the API (`3000` by default). It has
no build step: pages come from the server as HTML, a small script (`public/app.js`) adds the
actions, toasts and live updates on top. Everything the dashboard does goes through the JSON API,
so what you can click you can also script.

## Screens

| Path | Screen | Fast task |
|---|---|---|
| `/` | Overview | See which hosts are online, how many slots each runner type has left per host, and what every runner is working on right now. Kill a runner. |
| `/jobs` | Jobs | Queue and history. Filter by repo (select) and status (button group); both are query parameters, so a filtered view has a URL. Open the run on GitHub, or the job name for its log. |
| `/jobs/:id` | Job | One job: runner, host, type, labels, timings, and its log — live while the job runs, GitHub's final log afterwards. Follow, copy. |
| `/repos` | Repos | Adopt a repo by `owner/name`. Per adopted repo: copy the `runs-on` snippet for a runner type, open a pull request or commit that changes the workflows, or unadopt. |
| `/runner-types` | Runner types | Create and edit runner types (image, labels, CPUs, memory, mounts, environment, secret names). Set slots per host in a matrix; spawn a runner by hand. |
| `/events` | Events | Audit trail: actor, action, target, detail, time. |
| `/settings` | Settings | Scheduler, retention (including the per-job log size cap), live-update and logging tunables, plus the skin and palette of the dashboard. |

Every page has the same top bar (six sections), a footer with the version and the light/dark
toggle, and a status dot in the top-right corner that shows whether the live connection is up.

### Overview

- One Hosts card with a section per host. The header line shows the status dot, the name (links
  to the Hosts screen), a `leader` badge on the node that runs the sweep, the status, whether
  Docker answers and the last heartbeat. Under it, one row per runner type that has slots on that
  host with a used / total bar. A host without slots says so and links to Runner types.
- Runners: only live runners (`spawning`, `idle`, `busy`). Repo and job link into the jobs
  screen; `Kill` asks for confirmation, then calls `DELETE /api/runners/:id`.
- Empty state: "No hosts yet". A node registers itself on boot, so the first host appears as
  soon as one instance starts with access to a Docker socket.

### Jobs

- Columns: Runner (the runner's name, linking to the job page), Status, Job, Repo (links to the
  list filtered on that repo), Queued, Duration, Run (opens the run on GitHub).
- Filters, all kept in the URL so a view can be shared: a status select
  (`?status=queued|claimed|in_progress|completed|ignored`), a repo select (`?repo=owner/name`),
  a search box (`?q=` matches job name, repo and runner name, case-insensitive; Enter or a short
  pause navigates, `/` focuses it) and quick filters on the right: Running now (`?running=1`),
  Failed (`?failed=1`: failure, timed out or cancelled), Last 24 h and This week (`?since=<ISO>`).
  A pressed quick filter clears itself on the next click. Unknown values are ignored.
- Finished jobs show their conclusion (`success`, `failure`, …) instead of `completed`; a
  failed row is tinted.
- Duration is computed from `startedAt` to `completedAt` (or now).
- The job name links to `/jobs/:id`; so does the job column of the Runners table on the Overview.

### Job

- Header: job name, repo (links to the filtered Jobs list), status or conclusion badge, "Run on
  GitHub". Facts: runner name and state, host and type, labels, queued / started / finished with
  the duration.
- Log: a `<pre>` with one line per row and the time of day in the gutter (the full timestamp is on
  the element). While the job runs the page opens `GET /api/jobs/:id/log/stream?after=<last seq>`
  and appends each `line` batch; at most 5000 lines stay in the page, older ones drop off the top.
  **Follow** keeps the newest lines in view and switches itself off when you scroll up (and on
  again at the bottom). **Copy** puts every line in view on the clipboard and reports the count.
- Source badge: `runner (live)` while the runner prints, `GitHub` once the job finished and GitHub's
  log replaced the live lines (the page reloads the view and says so in a toast), `runner` when
  GitHub did not hand out the log within two minutes, `none` when nothing was collected. A
  `truncated` badge appears when the stored log hit the `log_max_kb` cap; the full log is on GitHub.
- Empty state: "Waiting for the runner to start…" until the first line arrives; a finished job
  without lines says so.

### Repos

- Adopt: `POST /api/repos/adopt {fullName}`. The GitHub App or token must have access to the repo.
  An empty or malformed name is reported under the field; the browser's own bubble never shows.
- Columns: repo, visibility, webhook state (`via App` when a GitHub App delivers the events;
  `active` or `polling` with a token), Jobs (how many job rows the repo has; links to the filtered
  Jobs screen), adopted since, actions.
- Add webhook / Repair webhook: `POST /api/repos/webhook {fullName}` creates the `workflow_job`
  hook on the repo, or updates an existing one, and stores its id. With a GitHub App the button
  is disabled: the App already delivers the events.
- `runs-on`: opens a dialog with one snippet per runner type
  (`runs-on: [self-hosted, <type>]`), a copy button, and two actions that call
  `POST /api/repos/runs-on {fullName, mode, type}`: **Open a pull request** (`mode: pr`) and
  **Commit to default branch** (`mode: commit`, confirmed as a dangerous action).
- Unadopt: confirmed, then `POST /api/repos/unadopt {fullName}`.
- Empty state: "No repos adopted".

### Runner types

- The table lists every type with its labels (`self-hosted` and the type name are always
  added), image, caps, mount and env counts, and the names of secret environment variables.
  Secret values are never shown or stored; they are read from the node's own environment when a
  runner starts.
- The table shows Environment (count) before Mounts (count); hovering either lists the names.
- Edit and New open the same dialog; saving calls `PUT /api/runner-types/:name` with the full
  type. Labels are chips: Enter, comma or space adds one, × removes it; `self-hosted`, the type
  name and the host are shown first as fixed badges because every runner gets them anyway.
  Environment (one `KEY=value` per line) comes before Mounts (one `src:dst[:ro]` per line);
  secret names are comma-separated.
- Slots matrix: a number field per type × host. Leaving the field saves that one cell with
  `PUT /api/slots {host, type, count}`; a failed save reverts the field. The play button calls
  `POST /api/runners/spawn {type, host}` and is disabled for offline hosts.

### Hosts

- One row per node: status dot, name, `leader` badge, Docker reachability, CPUs, memory, OS,
  Docker version, app version, last heartbeat and the slots used / total on that host. The specs
  are what the node's heartbeat reports (`GET /api/hosts` carries them too); a dash means the node
  has not reported yet, for example an older version.
- "Add a host" opens a dialog that explains how a host joins: start a node on it with the same
  database and GitHub settings and its own `HOST_NAME`; it registers itself on its first
  heartbeat. The dialog carries a copyable `.env` skeleton and links to the cluster section of
  the operations guide. There is no API to add a host.

### Events

Every change made from the dashboard, the API, an agent over MCP, a webhook or the scheduler is
one row. The actor badge tells which. Detail is the event's JSON rendered as `key=value`.

### Settings

- One row per setting with a readable label, a help popover (with the default value) and a
  control that saves on change (`PUT /api/settings/:key {value}`); the state cell shows
  saving / saved / failed and a toast reports the outcome. There is no Save button.
- Durations are entered as a number with a unit (s / min / h). `stale_runner_minutes` is stored
  in minutes; the dashboard converts.
- Settings the dashboard does not know appear under "Other" as plain text fields.
- Appearance: skin and palette selects (alphabetical). The choice is stored as the settings
  `ui_skin`, `ui_palette` and `ui_mode`, so every browser that opens the dashboard gets the same
  look; localStorage only caches it to avoid a flash on load.

## Live updates

`app.js` opens an `EventSource` on `/events/stream`. The server sends `runner`, `job`, `slot`
and `event` events whenever a row changes. A page that has a live block (`[data-live]`) listens
to the events named in that attribute and, 300 ms after the last one, fetches the current URL with
`?partial=1`. In partial mode a page returns only its live block:

| Page | `?partial=1` returns | Refreshed on |
|---|---|---|
| `/` | `#overview-live` (hosts, slots, runners) | `runner`, `slot` |
| `/jobs` | `#jobs-live` (the filtered table) | `job` |
| `/events` | `#events-live` | `event` |

The block is replaced in place and re-wired; nothing else on the page moves. The dot in the top bar
is green while the stream is connected and orange while the browser reconnects. The stream has a
cap on clients and an idle timeout (settings `sse_max_clients`, `sse_idle_s`); the browser
reconnects on its own.

Actions never reload the page. After an action that changes a table without a live block (adopt,
unadopt, runner type save/delete), the page's main column is fetched again and swapped.

## Theming

The UI is built on [tailor](https://github.com/rojosinalma/tailor): one markup vocabulary
(`t-*` classes), swappable skins and palettes. `public/tailor/` is vendored by `tailor apply` and
carries a `managed by tailor` header; do not edit it by hand (`tailor sync` refreshes it). The
project's own styles live in `public/app.css` and use only `--t-*` tokens, so every skin and
palette, in dark and light mode, renders them correctly.

- Default: skin `bootstrap`, palette `gruvbox`, mode follows the OS until the toggle is used.
- The footer toggle switches light / dark; `/settings` → Appearance picks skin and palette.
- `?skin=`, `?palette=`, `?mode=` on any URL override the choice for that page load.
- Icons come from the vendored sprite `public/tailor/icons.svg` (Bootstrap Icons subset).
- `public/favicon.svg` is the OctoHatchery mark: a flat octopus on a dark plate, same file for
  both modes.

## Putting it behind SSO

The app has no authentication of its own. Anyone who can reach port `3000` can see the dashboard
and call the API, including destructive actions. Run it behind a reverse proxy that authenticates:

1. Put the whole site behind your identity-aware proxy (Authentik, Authelia, oauth2-proxy,
   Cloudflare Access, Pomerium, Caddy with a forward-auth plugin, …).
2. Exclude exactly one path from authentication: `POST /webhooks/github`. GitHub cannot log in;
   that endpoint verifies the `X-Hub-Signature-256` HMAC instead.
3. Keep `/api/*`, `/mcp` and `/events/stream` behind the same gate as the pages. Agents that use
   the MCP endpoint need a way through the proxy (a service token or header your proxy accepts).
4. Serve the proxy over HTTPS; the `EventSource` connection is a long-lived HTTP request, so set
   the proxy's read timeout above `sse_idle_s` or let the browser reconnect (it does).
5. Do not publish port `3000` directly; bind it to the proxy's network or `127.0.0.1`.

If you only use the dashboard on a trusted LAN, a proxy with HTTP Basic auth is not an option
either: the dashboard never shows browser-native dialogs, and the login would appear as one. Use
a proxy with its own login page.

## Development notes

- Routes: `src/routes/ui.tsx` (Elysia plugin `ui`). Views: `src/views/*.tsx`, rendered with
  `@kitajs/html`; untrusted text goes through the `safe` attribute or `e()`.
- Static files: `public/` is served under `/public/*`; `public/tailor/` also under `/tailor/*`
  (the vendored head snippet expects that path) and `public/favicon.svg` at `/favicon.svg`. Paths
  that resolve outside `public/` are 404.
- Tests: `bun test test/ui` renders every page against a mocked facade, including empty states
  and partials, and probes the static handler with traversal attempts.
