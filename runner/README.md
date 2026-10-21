# Runner image

This is the container image OctoHatchery starts for every job. It is the official
[GitHub Actions runner image](https://github.com/actions/runner/pkgs/container/actions-runner)
with the tools most workflows expect on top.

## What is inside

- `ghcr.io/actions/actions-runner:2.338.0` as the base: Ubuntu, the runner binary, user `runner` (uid 1001).
- `gh` (GitHub CLI), `git-lfs`, `jq`, `curl`, `unzip`.
- `build-essential` and `pkg-config`, so native gems and npm/pip packages with C extensions install
  (Ruby's `nio4r`, `puma`, `bigdecimal`, for example).
- Passwordless `sudo` for `runner`, as on GitHub-hosted runners, so `sudo apt-get install` steps work.
- `LANG=C.UTF-8` and `LC_ALL=C.UTF-8`, as on GitHub-hosted runners, so tools read source files as UTF-8.
- Docker CLI and the buildx plugin. No Docker daemon: builds go to a remote buildkitd over `BUILDKIT_HOST`.
- `RUNNER_TOOL_CACHE=/opt/hostedtoolcache`, owned by `runner`. The orchestrator mounts a per-host volume
  there so `actions/setup-node`, `setup-python` and friends download each version once per host.
- `/entrypoint.sh`, which starts the runner from a just-in-time config and exits when the job is done.

## How the orchestrator starts it

The orchestrator passes everything through environment variables:

| Variable | Set by | Meaning |
|---|---|---|
| `RUNNER_JITCONFIG` | orchestrator | Single-use runner registration from GitHub. Required. The entrypoint exits with code 64 when it is empty. |
| `RUNNER_TOOL_CACHE` | image | Where setup actions cache tool versions. |
| `BUILDKIT_HOST` | orchestrator | Address of the shared buildkitd, for example `tcp://octohatchery-buildkitd:1234`. Optional. |
| the type's `env` | runner type | Plain values you configured on the runner type. |
| the type's `secretEnv` | node | Secret values read from the node at start time, never stored in the database. |

When `BUILDKIT_HOST` is set, the entrypoint runs
`docker buildx create --name octohatchery --driver remote "$BUILDKIT_HOST" --use`. When that fails
(buildkitd down, wrong address) it logs the problem and still starts the runner, so jobs without a
build step keep working.

The runner takes one job and exits. The orchestrator removes the container afterwards.

## Build it yourself

```sh
docker build -t ghcr.io/rojosinalma/octohatchery-runner:<tag> runner/
docker push ghcr.io/rojosinalma/octohatchery-runner:<tag>
```

Then set `image` on the runner type to that tag. Releases of OctoHatchery publish the same image
with the release tag.

## Using buildx in a job

The builder named `octohatchery` is already selected inside the runner, so a plain
`docker build` or `docker buildx build` goes to the shared buildkitd. If you prefer the
official action, point it at the same endpoint:

```yaml
- uses: docker/setup-buildx-action@v3
  with:
    driver: remote
    endpoint: ${{ env.BUILDKIT_HOST }}
```

`docker run` does not work inside a runner: there is no daemon. Push the image and run it
elsewhere, or use a service container defined in the workflow.

## Making your own runner image

Any image works as long as its entrypoint honours `RUNNER_JITCONFIG`. The smallest custom
image extends this one:

```dockerfile
FROM ghcr.io/rojosinalma/octohatchery-runner:<tag>
USER 0
RUN apt-get update && apt-get install -y --no-install-recommends <your packages> \
    && rm -rf /var/lib/apt/lists/*
USER 1001:1001
```

If you start from another base, keep three things:

1. Run as a non-root user and own `RUNNER_TOOL_CACHE`.
2. Start the runner with `./run.sh --jitconfig "$RUNNER_JITCONFIG"` and exit when it returns.
3. Do not bake secrets in. Put their names in the runner type's `secretEnv` and the values in the node's `.env`.

Create a runner type that points at your image (dashboard, API or the `upsert_runner_type` MCP tool)
and give it slots on a host. See [docs/runner-types.md](../docs/runner-types.md).
