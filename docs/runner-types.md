# Runner types

A runner type is the template a runner container is started from. Types are rows in the database,
not code: you add and change them from the dashboard (Templates page), the JSON API
(`PUT /api/runner-types/:name`) or the MCP tool `upsert_runner_type`. The dashboard calls them
templates; the API, the MCP tools and this document keep the name runner type.

## Fields

| Field | Meaning |
|---|---|
| `name` | Unique, lowercase, used as a label. `generic`, `deploy`, `gpu`, `arm64`. |
| `description` | Free text for the dashboard. |
| `labels` | Extra labels a job may select in `runs-on`. Every runner already carries `self-hosted`, `<name>` and `<host>`. |
| `image` | The runner image. Default: `ghcr.io/rojosinalma/octohatchery-runner:<tag>`. Any image whose entrypoint honours `RUNNER_JITCONFIG` works; see [runner/README.md](../runner/README.md). |
| `cpus` | CPU limit for the container, for example `2` or `0.5`. |
| `memoryMb` | Memory limit in MB. Swap is capped at the same value. |
| `mounts` | Extra bind mounts, verbatim Docker form `src:dst[:ro]`. Empty by default. |
| `env` | Plain environment variables, stored as given. Never put secrets here. |
| `secretEnv` | Names of environment variables whose values live on the node. |
| `docker` | What a job can do with Docker: `none` (default), `socket` or `dind`. See [Docker access](#docker-access). |
| `runAs` | The user the container runs as: `image` (default) or `root`. See [Run as](#run-as). |

Every runner also gets:

- `RUNNER_TOOL_CACHE=/opt/hostedtoolcache`, where the runner image bakes its tools (see [Tool cache](#tool-cache)),
- `BUILDKIT_HOST` pointing at the node's buildkitd sidecar (setting `buildkit_host`),
- a PID limit of 1024, no added capabilities, and no Docker socket unless the type says `docker: socket`,
- the user its image declares, unless the type says `runAs: root`.

A type change affects runners started after the change. Running runners finish with their old settings.

## Tool cache

Nothing is mounted at `/opt/hostedtoolcache`. The default runner image ships the tools there already:
Ruby versions in the layout `ruby/setup-ruby` looks for, and Bun at `~/.bun/bin`, where
`oven-sh/setup-bun` looks first. A setup step that asks for a baked version uses it without a download.
A version that is not baked in is downloaded into the job's own container and is gone when the job ends.
Each job has its own copy of the tree, so concurrent jobs cannot break each other's tools.
[runner/README.md](../runner/README.md#baked-tools) lists the versions and how to change them.

A shared volume over that path would hide the baked tools and let concurrent jobs write into the same
Ruby, so do not add one in `mounts`.

## Secrets: names in the type, values on the node

`secretEnv` holds names only, for example `["DEPLOY_TOKEN"]`. When a runner starts, the node reads
each name from its own environment (its `.env` file) and injects the value. If a name is missing on
that node, the spawn fails with a message that names the variable; the runner never starts with an
empty value. The database and the dashboard only ever see the names, so a backup or a screenshot does
not leak anything.

This also means a type with secrets only runs on hosts that have those values. Give such a type slots
only on those hosts.

## Docker access

GitHub's `services:` containers, `docker run` steps and `docker compose` all need a daemon the runner
can talk to. Image builds do not: `docker buildx build` goes to the shared `buildkitd` sidecar over
`BUILDKIT_HOST` in every type. The `docker` field picks what else a job gets:

| Option | What happens | Trade-off |
|---|---|---|
| `none` (default) | No daemon. `BUILDKIT_HOST` only. | `services:`, `docker run` and Compose steps fail. Safest. |
| `socket` | The node's Docker socket (`DOCKER_HOST` when it is a unix socket, else `/var/run/docker.sock`) is bind-mounted at `/var/run/docker.sock`, and the runner's user is added to the socket's group. | Everything works and is fast (shared image cache). Every job on this type sees and can stop, start or exec into **every container on the host**, including OctoHatchery itself. Only for types whose repos you fully trust. |
| `dind` | Before the runner, the node starts a `docker:28-dind` sidecar (privileged, plain TCP, same runner network, named `<runner>-dind`, labelled with the runner id and `octohatchery.role=dind`) and points the runner's `DOCKER_HOST` at it. The runner's entrypoint waits up to 30 s for the daemon. The sidecar is removed with the runner by the reaper, the stale sweep and `kill`. | Isolated: the job controls only its own daemon. About 5 s slower to start; images are pulled fresh every job (no shared cache); the sidecar is privileged on the host. |

For `socket`, the node adds the socket's group id to the runner container when it can `stat` the
socket (the socket is mounted into the app container, so this normally works). When it cannot, it
logs a warning and starts the runner without the extra group; the socket must then be readable by the
runner user (uid 1001), for example by making the host's `docker` group world-readable on the socket
or by using `dind` instead.

`dind` needs a runner image whose entrypoint waits for `DOCKER_HOST` (the shipped
`octohatchery-runner` from this change on). An older image starts fine but its first `docker` step
may race the daemon.

The shipped `generic` and `deploy` types start with `none`; pick what each needs in the type dialog.

### `services:` and localhost on containerised runners

GitHub-hosted runners run on a VM, so a `services:` container's published port is reachable on
`localhost`. On a containerised runner the Actions runner publishes service ports on **the Docker
daemon's host**, so what `localhost` means depends on the Docker option of the type:

- **Docker-in-Docker**: the runner shares the sidecar daemon's network namespace
  (`network_mode: container:<sidecar>`), so every port the daemon publishes is on the job's own
  `localhost`, exactly as on a hosted runner. Workflows need no change. `DOCKER_HOST` is
  `tcp://localhost:2375`; the BuildKit sidecar stays reachable by name.
- **Host socket**: the daemon is the node itself, so a published port lands on the node, not in the
  runner, and `localhost:5432` inside a step finds nothing. Either address the node (the runner is on
  the node's compose network; the host's gateway IP is `ip route | awk '/default/ {print $3}'`), or run
  the job inside a container (`container: node:22`): GitHub then puts the job container and its
  services on one network and the service is reachable by its `services:` key (`postgres:5432`).

## Run as

By default a runner runs as the user its image declares. In the shipped image that is `runner`, uid 1001,
which is what GitHub's own runner expects. Set `runAs` to `root` and the container starts as uid 0
(`--user 0:0`) instead.

| Option | What happens |
|---|---|
| `image` (default) | No user is set; the image's `USER` applies. |
| `root` | The container runs as uid 0, gid 0, with `RUNNER_ALLOW_RUNASROOT=1` (the Actions runner refuses root without it). |

Use `root` when a job has to write files that belong to root inside a bind mount: a deploy checkout
owned by root on the host, a shared cache directory created by another root process, or a tool that
insists on root. Running as uid 1001, such a job fails with `permission denied`.

The risk: a root job can read and write every host path the type bind-mounts, with root's rights, and
can change ownership of anything in them. Only use `root` on types whose mounts you would hand to any
job of every adopted repo. With `docker: socket` it adds nothing, since the Docker socket already gives
a job root on the host. With `dind` the sidecar is privileged either way; the runner's user does not
change that.

The socket group (`docker: socket`) is still added for both options. A custom image whose `USER` is
already root behaves like `root` with either option.

## Images

Every node reports, on every heartbeat, which of the wanted images its engine holds: the image of
each type, `runner_image_default` and `docker:28-dind`. The result is on **Templates → Images**
(one row per image, one column per host: present with digest, size and build time, or missing)
and in `GET /api/images` / `GET /api/hosts/:name/images`.

A runner's first start on a host with a missing image pulls it then, which delays that job by the
pull time. To pull ahead, use **Pull now** on a cell, **Pull on all hosts** on a row, the inline
**Pull on <host>** in the type dialog, `POST /api/hosts/:name/images/pull {reference}` or the MCP
tool `pull_image {host, reference}`. A pull is a row in `image_pulls` that the node owning that
host claims on its next scheduler tick and runs in the background (one at a time per node, the
scheduler keeps claiming jobs meanwhile); the outcome (`done` or `failed` with the engine's error)
is recorded, an audit event is written and the matrix updates live. Only wanted references can be
pulled: nothing is typed, images are listed by the templates that use them. A pull left `running`
by a node that died is marked failed when the node comes back; finished pulls are purged with the
retention window.

## Mounts

Mounts are passed to Docker as written. `/srv/cache/npm:/home/runner/.npm` gives every runner a
shared npm cache; `/etc/ssl/certs:/etc/ssl/certs:ro` shares the host's CA bundle. Do not mount the
Docker socket, your home directory or your source tree into a type: a job from any adopted repo could
read it. Mounting a secret file is the same as putting the secret into every job.

## The two shipped types

| Type | Slots | Caps | Purpose |
|---|---|---|---|
| `generic` | several per host | 2 CPU, 4 GB | Build and test jobs for any adopted repo. No secrets. |
| `deploy` | 1 per host | 1 CPU, 1 GB | Jobs that talk to your deployment tooling. `secretEnv` holds the token name, the value lives in each node's `.env`. One slot keeps deployments serial. |

Both use the default runner image. Change them or delete them as you like; they are data.

## Adding a GPU or arm64 type

A type is a set of labels plus the host it may run on, so hardware types are just types with slots on
the right hosts.

GPU:

1. Build an image with the drivers and toolkits your jobs need, based on the default runner image
   (see [runner/README.md](../runner/README.md)).
2. Create the type: name `gpu`, that image, labels `["cuda"]` if you want a second selector, caps that
   fit the host.
3. Add device access through `mounts` (`/dev/dri:/dev/dri` for Intel/AMD) or extend the Docker backend
   with GPU requests if you need NVIDIA's runtime. Keep this to the hosts that have the hardware.
4. Give it slots only on the GPU hosts: `set_slots {host: "gpu-box", type: "gpu", count: 1}`.
5. Workflows select it with `runs-on: [self-hosted, gpu]`.

arm64:

1. Run a node on an arm64 machine; the default runner image is multi-arch, so the same tag works.
2. Create the type `arm64` (the image may be the default one) and give it slots on that host only.
3. Workflows select `runs-on: [self-hosted, arm64]`. Because slots exist only on the arm64 host, jobs
   land there without a host label.

## Slots per host

A slot is one runner that may run at a time for one type on one host. Slots are set per `(host, type)`
pair: `set_slots {host, type, count}`, the Templates page, or `PUT /api/slots`.

- A host with no slot for a type never runs that type.
- A queued job is claimed by the first host that has a free slot for the job's type. If the job names
  a host label, only that host claims it.
- `count` is a cap, not a reservation. Lowering it does not kill running runners; they finish and the
  free count catches up.
- `count: 0` removes the pair.

Pick counts from the host's CPU and memory divided by the type's caps, and leave room for the node
itself and the buildkitd sidecar.

## `runs-on` forms

Every runner carries `self-hosted`, its type name and its host name, plus the type's extra labels.
A job must list `self-hosted` and exactly one type:

```yaml
runs-on: [self-hosted, generic]            # any host with a free generic slot
runs-on: [self-hosted, generic, node-a]    # only node-a
runs-on: [self-hosted, gpu, cuda]          # type gpu, extra label cuda
```

Jobs whose labels do not match a known type are recorded with status `ignored` and never claimed, so a
typo shows up in the Jobs page instead of hanging in GitHub's queue forever.

`apply_runs_on` (MCP, API, dashboard) produces this line for a repo and can open a pull request or
commit it to the workflows for you.
