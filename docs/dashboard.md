# Dashboard

The dashboard is a server-rendered web UI on the same port as the API (`3000` by default). It has
no build step: pages come from the server as HTML, a small script (`public/app.js`) adds the
actions, toasts and live updates on top. Everything the dashboard does goes through the JSON API,
so what you can click you can also script.

## Screens

| Path | Screen | Fast task |
|---|---|---|
| `/` | Overview | See which hosts are online, how many slots each template has left per host, and what every runner is working on right now. Kill a runner. |
| `/jobs` | Jobs | Queue and history. Filter by repo (select) and status (button group); both are query parameters, so a filtered view has a URL. Open the run on GitHub, or the job name for its log. |
| `/jobs/:id` | Job | One job: runner, host, template, labels, timings, and its log — live while the job runs, GitHub's final log afterwards. Follow, copy. |
| `/repos` | Repos | Adopt a repo from the list GitHub lets the node see. Per adopted repo: copy the `runs-on` snippet for a template, open a pull request or commit that changes the workflows, or unadopt. |
| `/templates` | Templates | Create and edit templates (image, labels, CPUs, memory, mounts, environment, secret names). Set slots per host in a matrix; spawn a runner by hand. |
| `/hosts` | Hosts | Every node with what it reports about itself: slots, CPUs, memory, OS, Docker, versions, last heartbeat. How a host joins. |
| `/events` | Events | Audit trail: actor, action, target, detail, time. |
| `/settings` | Settings | Appearance, GitHub access, BuildKit, live-update, retention (including the per-job log size cap), scheduler and logging tunables. |

The dashboard calls a runner type a **template**: same rows, same API (`/api/runner-types`), same MCP
tools (`list_runner_types`, `upsert_runner_type`); only the page, the navbar and the copy use the word.
`/runner-types` redirects to `/templates` for old links.

Every page has the same top bar (seven sections), a footer with the version and the light/dark
toggle, and a status dot in the top-right corner that shows whether the live connection is up.

### Overview

- One Hosts card, hosts side by side as columns (two on a desktop, stacked on a narrow screen).
  Each column has a one-line header: status dot, name (links to the Hosts screen), a `leader`
  badge on the node that runs the sweep, an `offline` or `Docker unreachable` badge only when
  that is the case, and on the right the specs the node reported (`8 CPU · 32 GB · Docker 27.3.1
  · seen just now`; parts not reported yet are left out). Under it a summary line, `1 of 4 slots
  busy` (orange when every slot is taken), then one row per template that has slots on that host:
  the template name and one pill per slot, filled when a runner occupies it; the row's tooltip
  gives used / total. A template with more than 12 slots on a host shows a bar and the count
  instead. A host without slots says so and links to Templates.
- Runners: only live runners (`spawning`, `idle`, `busy`). Every cell links somewhere: the runner
  name to the jobs list filtered on that runner (`/jobs?runner=<name>`), the host to its row on
  the Hosts screen (`/hosts#<name>`), the template to its row under Templates
  (`/templates#<name>`), repo to the jobs list filtered on the repo, job to the job page. `Kill`
  asks for confirmation, then calls `DELETE /api/runners/:id`.
- Empty state: "No hosts yet". A node registers itself on boot, so the first host appears as
  soon as one instance starts with access to a Docker socket.
- Recent jobs: the Jobs table in a card, newest first, ten rows per page, with the same toolbar
  (status, repo, search, quick filters) and a pager. Its query params carry a `j_` prefix
  (`?j_status=…&j_repo=…&j_q=…&j_page=2`) so they never collide with the rest of the page. The
  header shows how many jobs match the filter and links to the Jobs page with the same filters
  ("All jobs →"). A picker chooses how many to show: last 10 (default), 20, 50 or all; "all" still
  pages in blocks of 100, so the dashboard never renders one unbounded list. The card refreshes on `job` and `runner` events, but not while you
  are typing in its search box.

### Jobs

- Columns: Runner (the runner's name, linking to the job page), Status, Job, Repo (links to the
  list filtered on that repo), Queued, Duration, Run (opens the run on GitHub).
- Filters, all kept in the URL so a view can be shared: a status select
  (`?status=queued|claimed|in_progress|completed|ignored`), a repo select (`?repo=owner/name`),
  a search box (`?q=` matches job name, repo and runner name, case-insensitive; Enter or a short
  pause navigates, `/` focuses it) and quick filters on the right: Running now (`?running=1`),
  Failed (`?failed=1`: failure, timed out or cancelled), Last 24 h and This week (`?since=<ISO>`).
  A pressed quick filter clears itself on the next click. Unknown values are ignored. A runner
  filter (`?runner=<name>`, reached from the Overview or a job page) has no select of its own: it
  shows as a chip in the toolbar with a × that clears it and keeps the other filters.
- Paging: 25 rows per page by default; `?page=` and `?per=` (10, 25, 50 or 100) sit in the URL
  with the filters. Under the table a pager (`« 1 2 … 9 »`, the range in view, a per-page select).
  A changed filter starts over at page 1; a page past the end shows the last one. The JSON API
  takes the same `page` and `per` and answers with `total`, `page` and `per`.
- Finished jobs show their conclusion (`success`, `failure`, …) instead of `completed`; a
  failed row is tinted.
- Duration is computed from `startedAt` to `completedAt` (or now).
- The job name links to `/jobs/:id`; so does the job column of the Runners table on the Overview.

### Job

- Header: job name, repo (links to the filtered Jobs list), status or conclusion badge, "Run on
  GitHub". Facts: runner name and state, host and type, labels, queued / started / finished with
  the duration.
- Log: one line per row and the time of day in the gutter (the full timestamp is on the element).
  While the job runs the page opens `GET /api/jobs/:id/log/stream?after=<last seq>` and appends
  each `line` batch; at most 5000 lines stay in the page, older ones drop off the top.
  **Follow** keeps the newest lines in view and switches itself off when you scroll up (and on
  again at the bottom). **Copy** puts every line in view on the clipboard, group markers included,
  and reports the count.
- Groups: `##[group]<title>` … `##[endgroup]` blocks (and `##[section]Starting:` /
  `##[section]Finishing:` step markers when a log has them) fold into collapsible sections whose
  header shows the title, the number of lines and the time the block took. Marker lines are hidden
  in the grouped view; lines outside a group stay flat. Groups are one level deep: a new group
  closes the one before it. `##[error]` lines are red and open their group by default,
  `##[warning]` lines are orange. While the job runs, the group receiving lines stays open and
  earlier groups fold as they close. **Expand all** / **Collapse all** act on every group;
  **Raw** (`?raw=1`) shows every line as stored, **Grouped** folds them again.
- Source badge: `runner (live)` while the runner prints, `GitHub` once the job finished and GitHub's
  log replaced the live lines (the page reloads the view and says so in a toast), `runner` when
  GitHub did not hand out the log within two minutes, `none` when nothing was collected. A
  `truncated` badge appears when the stored log hit the `log_max_kb` cap; the full log is on GitHub.
- Empty state: "Waiting for the runner to start…" until the first line arrives; a finished job
  without lines says so.

### Repos

- Adopt a repo: a button that opens a dialog listing the repositories the GitHub App installation
  or the token can reach (`GET /api/github/repos`, first 500, cached 60 s), with a filter box,
  a private/public badge and an `adopted` badge on rows already served (disabled). One click calls
  `POST /api/repos/adopt {fullName}`; nothing is typed by hand. The clicked row shows a spinner
  and the other rows are disabled until GitHub answers. When the list cannot be fetched the
  dialog says why and what fixes it: no GitHub access configured → link to Settings → GitHub; GitHub
  refused (401/403) → "Check GitHub permissions"; an App installed on no repositories → link to the
  installation page to add some.
- Columns: repo, visibility, webhook state (`GitHub App` when a GitHub App delivers the events;
  `active` or `polling` with a token), Jobs (how many job rows the repo has; links to the filtered
  Jobs screen), adopted since, actions.
- The actions column holds three icon buttons, each with a tooltip: runs-on, Add / Repair webhook
  (link icon) and Unadopt (bin).
- Add webhook / Repair webhook: `POST /api/repos/webhook {fullName}` creates the `workflow_job`
  hook on the repo, or updates an existing one, and stores its id. With a GitHub App the button
  is disabled: the App already delivers the events.
- `runs-on` (code icon): opens a dialog with one snippet per template
  (`runs-on: [self-hosted, <type>]`), a copy button, and two actions that call
  `POST /api/repos/runs-on {fullName, mode, type}`: **Open a pull request** (`mode: pr`) and
  **Commit to default branch** (`mode: commit`, confirmed as a dangerous action). On success the
  buttons give way to a result line ("Pull request opened" or "Committed <sha>") with a link to
  the pull request or commit. While the request runs, the clicked button shows a spinner and both
  buttons are disabled. On failure the dialog stays open, the buttons come back and GitHub's exact
  message is shown, also as a toast; a missing permission names the GitHub page where to grant it.
- Unadopt (bin icon): confirmed, then `POST /api/repos/unadopt {fullName}`.
- Empty state: "No repos adopted" with the Adopt button.

### Templates

Two tabs under the page title: **Templates** (`/templates`) and **Images** (`/templates/images`).
Each tab is its own URL; the Templates entry in the navbar stays active on both.

- The table lists every template with its labels (`self-hosted` and the template name are always
  added), image, caps, Docker access badge (`none`, `host socket`, `dind`), mount and env counts,
  and the names of secret environment variables.
  Secret values are never shown or stored; they are read from the node's own environment when a
  runner starts.
- The table shows Environment (count) before Mounts (count); hovering either lists the names.
- Edit (pencil) and New open the same dialog; saving calls `PUT /api/runner-types/:name` with the
  full template. Delete (bin) asks first. Labels are chips: Enter, comma or space adds one, ×
  removes it; `self-hosted`, the template name and the host are shown first as fixed badges
  because every runner gets them anyway. Image is a select: the default image (setting
  `runner_image_default`, Settings → BuildKit) and every image a template already uses, with
  **Other…** last to type a new one; editing preselects the template's image.
  Environment (one `KEY=value` per line) comes before Mounts (one `src:dst[:ro]` per line);
  secret names are comma-separated. Docker is three cards (None, Host socket, Docker-in-Docker),
  each with its trade-off; see [runner-types.md](runner-types.md#docker-access).
- Slots matrix: a number field per template × host. Leaving the field saves that one cell with
  `PUT /api/slots {host, type, count}`; a failed save reverts the field. The play button calls
  `POST /api/runners/spawn {type, host}`, shows a spinner while it runs and is disabled for offline
  hosts. The matrix is live: `runner` and `slot` events from `/events/stream` (and a spawn or a
  saved cell) re-fetch `GET /templates?partial=slots` and swap the block in place, so the
  used / free counts follow the runners. A refresh waits while a slot field has focus and runs
  when the field is left, so a number being typed is never overwritten.
- Image select: every option says where the image is missing (`… · missing on tiny`), from the
  inventory the hosts report. When the picked image is missing on a host that has slots for this
  template, a warning appears under the field with one **Pull on <host>** button per host; the
  button queues the pull (`POST /api/hosts/:name/images/pull`), shows a spinner, and turns into a
  `queued on <host>` badge with a toast. A template without slots gets no warning: nothing starts
  there yet.

### Templates → Images

- One row per image the instance wants: the image of every template, the default runner image
  (`runner_image_default`) and the Docker-in-Docker sidecar (`docker:28-dind`). One column per
  host. Rows are never typed in: a reference is listed because a template (or the default) uses
  it, and disappears when nothing does.
- Each cell is one of `present` (green badge with the full digest as tooltip, then short digest ·
  size · when the image was built), `missing` (red; after a failed pull also a `last pull failed`
  badge with the engine's error as tooltip) or `pulling` / `queued` (spinner). Every cell has an
  icon-only **Pull now** button, busy while a pull is queued or running and disabled for an
  offline host; the row has **Pull on all hosts** for every online host.
- **Add image** opens a dialog with a select of the listed images that are missing on at least one
  online host; Pull queues it on every host that lacks it. When nothing is missing the dialog says so.
  To list a new image, create or edit a template that uses it.
- Live: `image` events from `/events/stream` re-fetch `GET /templates/images?partial=1` and swap the
  table in place, so a cell moves from `queued` to `pulling` to `present` while you watch. The
  inventory itself comes from each node's heartbeat (`host_images`), so an image pulled by hand
  on a host shows up within one heartbeat too.

- One row per node: status dot, name and `leader` badge, slots used / total on that host (links
  to Templates), CPUs, memory in GB, OS, Docker reachability, Docker version, app version and the
  last heartbeat. The specs
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
- Sections, in sidebar order: Appearance, GitHub, BuildKit (BuildKit host, Default runner image), Live updates, Retention, Scheduler,
  Logging, Other, About. "Other" lists settings the dashboard does not know as plain text fields
  and exists only while there are any.
- Appearance: skin and palette selects (alphabetical). The choice is stored as the settings
  `ui_skin`, `ui_palette` and `ui_mode`, so every browser that opens the dashboard gets the same
  look; localStorage only caches it to avoid a flash on load.
- GitHub: the auth mode, the App (linked) with its installation, account and repository count,
  the webhook URL, and a table of the permissions OctoHatchery needs — required level, granted
  level, why, and what breaks without it; a missing one is a red row. Buttons: **Re-check**
  (`POST /api/github/recheck`, drops the 60 s cache), **Edit permissions on GitHub** and
  **Accept on the installation**. With `GITHUB_AUTH=none` the tab shows the `.env` lines for both
  modes and links to [github-app.md](github-app.md). The same status is `GET /api/github/status`
  and `github: {ok, source, missing}` in `GET /health`.
- Banner: while a permission is missing or no GitHub source is configured, every page shows a
  warning under the navbar naming the gap and linking to this tab. It is rendered from the cached
  status, so an unreachable GitHub never blocks a page (and shows no banner).

## Live updates

`app.js` opens an `EventSource` on `/events/stream`. The server sends `runner`, `job`, `slot`,
`event` and `image` events whenever a row changes. A page that has a live block (`[data-live]`) listens
to the events named in that attribute and, 300 ms after the last one, fetches the current URL with
`?partial=1`. A page with more than one live block names each with `data-partial` and fetches
`?partial=<name>` for the block the event concerns. In partial mode a page returns only that block:

| Page | `?partial=1` returns | Refreshed on |
|---|---|---|
| `/` | `#overview-live` (hosts, slots, runners) | `runner`, `slot` |
| `/` (`?partial=jobs`) | `#recent-jobs` (the Recent jobs card) | `job`, `runner` |
| `/jobs` | `#jobs-live` (the filtered table and its pager) | `job` |
| `/templates` (`?partial=slots`) | `#slots-live` (the slots matrix) | `runner`, `slot` |
| `/templates/images` | `#images-live` (the image matrix) | `image` |
| `/events` | `#events-live` | `event` |

The block is replaced in place and re-wired; nothing else on the page moves. The dot in the top bar
is green while the stream is connected and orange while the browser reconnects. The stream has a
cap on clients and an idle timeout (settings `sse_max_clients`, `sse_idle_s`); the browser
reconnects on its own.

Actions never reload the page. After an action that changes a table without a live block (adopt,
unadopt, template save/delete), the page's main column is fetched again and swapped.

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
