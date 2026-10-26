# MCP

OctoHatchery exposes every operation as an [MCP](https://modelcontextprotocol.io) server, so an
agent can adopt repos, read the queue, change capacity and start or stop runners with the same
rules the dashboard and the JSON API follow.

## Connecting

The server speaks Streamable HTTP at `<PUBLIC_URL>/mcp`. There is no authentication in the app:
put it behind your reverse proxy and single sign-on like the dashboard. Whatever the proxy lets
through has full control, so give the MCP path the same protection as the UI.

Example for [opencode](https://opencode.ai) (`opencode.jsonc`):

```jsonc
{
  "mcp": {
    "octohatchery": {
      "type": "remote",
      "url": "https://octohatchery.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <token your proxy accepts>"
      }
    }
  }
}
```

Other clients work the same way: give them the URL and any header the proxy needs.

The server keeps one session per connected client (`mcp-session-id` header, set on the
`initialize` answer). Sessions end when the client sends `DELETE`, after 30 minutes without a
request, or when the table is full (64 sessions, oldest goes first). A client that gets a `404`
sends `initialize` again, as the protocol requires. In a cluster each node keeps its own sessions,
so route MCP traffic to one node at a time.

## Actor model

Every change OctoHatchery makes is recorded in the audit log with an actor. Changes made through
MCP get the actor `mcp:<client name>`, where the client name comes from the `clientInfo.name` the
client sends on `initialize` (`mcp:unknown` when it sends none). The dashboard uses `user`,
GitHub `webhook`, and the background loops `scheduler` and `sweep`. Use `list_events` to see who
did what.

## Tools

Read-only:

- `list_hosts`: the nodes, their status, leader flag, whether Docker answers, and what each node reports about its host (CPUs, memory, OS, Docker and app versions).
- `list_runner_types`: runner templates with labels, image, caps, mounts, env and secret names.
- `list_slots`: per host and type, how many runners may run, are running and are free.
- `list_repos`: repos the credentials can see, with the adopted flag.
- `list_jobs {repo?, status?, q?, since?, running?, failed?, runner?, limit?}`: queue and history. `q` is a case-insensitive substring over job name, repo and runner name; `since` an ISO time; `running` keeps claimed and in-progress jobs; `failed` keeps failure, timed out and cancelled; `runner` keeps the jobs of one runner by its exact name.
- `get_job_log {job_id, tail?}`: the last `tail` lines (default 200, max 5000) of a job's log as
  text, oldest first, each with its timestamp. The first line says where the log comes from
  (`runner` while the job runs or when GitHub never handed out its log, `github` once the final log
  replaced the live lines, `collecting` while lines are still arriving), whether it was truncated
  by the `log_max_kb` setting, and whether it is complete.
- `list_runners {host?, state?, limit?}`: runner containers and what they run.
- `list_events {limit?}`: the audit log.
- `get_settings`: runtime settings as key/value strings.
- `health`: snapshot of the answering node, including `github: {ok, source, missing[]}` — missing permissions are a warning, not a failure.

Changes:

- `upsert_runner_type {name, image, cpus, memoryMb, labels?, mounts?, env?, secretEnv?, description?, docker?, runAs?, dockerCache?}`: create or replace a type. `docker` is `none` (default), `socket` (the host's Docker socket is mounted; `services:` and `docker run` work, every job on the type controls the host's containers) or `dind` (a privileged `docker:dind` sidecar per runner; isolated, about 2 s slower to start). `dockerCache` (dind only) is `none` (default: an empty daemon per job) or `repo` (the daemon's images and build cache stay for the next job of the same repository on that host; see [runner-types.md](runner-types.md#docker-cache)). `runAs` is `image` (default: the image's own user) or `root` (uid 0; the job can write any host path the type mounts, and with `socket` it adds nothing).
- `set_slots {host, type, count}`: capacity for one type on one host; `0` removes it.
- `adopt_repo {repo}`: start serving a repo (`owner/name`); creates the webhook when needed.
- `ensure_webhook {repo}`: create or repair the `workflow_job` webhook of an adopted repo and store its id. With a GitHub App nothing is created and the result says `covered: "app"`.
- `apply_runs_on {repo, mode, type, host?, workflows?}`: `snippet` returns YAML only; `pr` opens a pull request; `commit` pushes to the default branch. Before writing it checks the GitHub permissions the mode needs (`pr`: contents, workflows, pull_requests; `commit`: contents, workflows) and fails naming the missing ones and the GitHub page to fix them. `pr` works on a branch, verifies the pull request exists and deletes the branch again on any failure; failures carry GitHub's own message. Returns `prUrl` or `commitSha` + `htmlUrl`.
- `spawn {type, host}`: start one runner by hand.
- `pull_image {host, reference}`: queue a pull of one image on one host; the node on that host runs it on its next tick and the image shows as present on Templates → Images once done. Only images the instance wants can be pulled (a runner type's image, the default runner image, `docker:28-dind`); a pull already queued or running for the same cell is returned as is.
- `set_setting {key, value}`: change one runtime setting.

Destructive (the description says so, and the tool carries `destructiveHint`):

- `kill {runner_id}`: stop and remove a runner; a running job fails.
- `delete_runner_type {name}`: remove a type and its slots.
- `unadopt_repo {repo}`: stop serving a repo and remove its webhook.
- `apply_runs_on` with `mode: pr` or `mode: commit`: writes to the repository.

Every tool returns its result as JSON text, except `get_job_log`, which returns plain text. When the request is wrong (unknown repo, no free slot,
missing secret) the tool answers with `isError: true` and a message that says why.

## Examples

Adopt a repo and get the line to paste into its workflows:

```
adopt_repo { "repo": "acme/widgets" }
→ { "fullName": "acme/widgets", "adopted": true, "webhookId": 4711, ... }

apply_runs_on { "repo": "acme/widgets", "mode": "snippet", "type": "generic" }
→ { "ok": true, "snippet": "runs-on: [self-hosted, generic]" }
```

Pin the jobs of one repo to a host and let the orchestrator open a pull request:

```
apply_runs_on { "repo": "acme/widgets", "mode": "pr", "type": "generic", "host": "node-a" }
→ { "ok": true, "prUrl": "https://github.com/acme/widgets/pull/12", "files": [".github/workflows/ci.yml"] }
```

Read what a job printed (the id comes from `list_jobs`):

```
get_job_log { "job_id": 42, "tail": 50 }
→ # job 42: source=github truncated=false complete=true lines=50
  2026-10-20T10:00:01.1234567Z ##[group]Run tests
  …
```

Find out why a job waits:

```
list_jobs { "status": "queued" }      # which labels does it ask for?
list_slots                            # is there a free slot for that type?
list_runner_types                     # does a type carry those labels at all?
```

## Adding a tool

One file in `src/mcp/tools/` exporting a `defineTool({...})` and one line in
`src/mcp/tools/index.ts`. The tool calls the service layer (`src/lib/service.ts`) and never the
database or GitHub directly, so the API, the dashboard and MCP stay in step.
