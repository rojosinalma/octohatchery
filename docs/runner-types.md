# Runner types

A runner type is the template a runner container is started from. Types are rows in the database,
not code: you add and change them from the dashboard (Runner types page), the JSON API
(`PUT /api/runner-types/:name`) or the MCP tool `upsert_runner_type`.

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

Every runner also gets:

- the named volume `octohatchery-tool-cache` at `/opt/hostedtoolcache` (`RUNNER_TOOL_CACHE`), one per host,
- `BUILDKIT_HOST` pointing at the node's buildkitd sidecar (setting `buildkit_host`),
- a PID limit of 1024, no Docker socket, no added capabilities.

A type change affects runners started after the change. Running runners finish with their old settings.

## Secrets: names in the type, values on the node

`secretEnv` holds names only, for example `["DEPLOY_TOKEN"]`. When a runner starts, the node reads
each name from its own environment (its `.env` file) and injects the value. If a name is missing on
that node, the spawn fails with a message that names the variable; the runner never starts with an
empty value. The database and the dashboard only ever see the names, so a backup or a screenshot does
not leak anything.

This also means a type with secrets only runs on hosts that have those values. Give such a type slots
only on those hosts.

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
pair: `set_slots {host, type, count}`, the Runner types page, or `PUT /api/slots`.

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
