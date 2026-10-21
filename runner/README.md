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
- Ruby and Bun baked in, see [Baked tools](#baked-tools).
- `RUNNER_TOOL_CACHE=/opt/hostedtoolcache`, owned by `runner`, with the baked Rubies inside.
- `/entrypoint.sh`, which starts the runner from a just-in-time config and exits when the job is done.

## How the orchestrator starts it

The orchestrator passes everything through environment variables:

| Variable | Set by | Meaning |
|---|---|---|
| `RUNNER_JITCONFIG` | orchestrator | Single-use runner registration from GitHub. Required. The entrypoint exits with code 64 when it is empty. |
| `RUNNER_TOOL_CACHE` | image and orchestrator | Where setup actions look for tool versions. Nothing is mounted there. |
| `BUILDKIT_HOST` | orchestrator | Address of the shared buildkitd, for example `tcp://octohatchery-buildkitd:1234`. Optional. |
| the type's `env` | runner type | Plain values you configured on the runner type. |
| the type's `secretEnv` | node | Secret values read from the node at start time, never stored in the database. |

When `BUILDKIT_HOST` is set, the entrypoint runs
`docker buildx create --name octohatchery --driver remote "$BUILDKIT_HOST" --use`. When that fails
(buildkitd down, wrong address) it logs the problem and still starts the runner, so jobs without a
build step keep working.

The runner takes one job and exits. The orchestrator removes the container afterwards.

## Baked tools

Each tool has its own small image under [`tools/`](tools), built from `tools/<tool>/Dockerfile`
and published as `ghcr.io/rojosinalma/octohatchery-tool-<tool>`. Its final stage is `FROM scratch`
and holds only the tool's files. The runner image copies those files in with `COPY --from`, so
every job starts with its own copy and nothing is shared between jobs.

| Tool | Versions | Where | Used by |
|---|---|---|---|
| Ruby (prebuilt by [ruby/ruby-builder](https://github.com/ruby/ruby-builder)) | 3.3.12, 3.4.11, each with Bundler 2.5.22, 2.6.9 and 4.0.22 | `/opt/hostedtoolcache/Ruby/<version>/<x64\|arm64>` plus the `.complete` marker | `ruby/setup-ruby` with `ruby-version: "3.3"` or `"3.4"` finds them and skips the download |
| Bun | 1.4.3 | `/home/runner/.bun/bin/bun` and `bunx`, on `PATH` | `oven-sh/setup-bun` with `bun-version: 1.4.3` reuses it |

The tool cache stays writable by `runner`. When a workflow asks for a version that is not baked in,
the setup action downloads it as usual, into that job's container only.

**Bump a version.** Edit the `ARG` at the top of the tool's Dockerfile (`RUBY_VERSIONS`,
`BUNDLER_VERSIONS`, `BUN_VERSION`) and push to `main`. CI builds the tool images first, then the
runner image from the same commit. Keep a Ruby version in step with what `ruby/setup-ruby` resolves
`"3.3"` and `"3.4"` to, or jobs download the newer patch release every time; the runner smoke test
fails when that happens.

**Add a tool.**

1. Add `tools/<tool>/Dockerfile` whose final stage is `FROM scratch` with only the tool's tree.
2. Add `<tool>` to the `tools` matrix in `.github/workflows/publish-image.yml` and `release.yml`.
3. Add a `FROM ${TOOLS_REGISTRY}/octohatchery-tool-<tool>:${TOOLS_TAG} AS <tool>` line and one
   `COPY --from=<tool> --chown=runner:runner` line to `runner/Dockerfile`.

## Build it yourself

The runner image needs the tool images first. `TOOLS_REGISTRY` and `TOOLS_TAG` pick which ones
(defaults: `ghcr.io/rojosinalma` and `edge`). To build everything locally, tag the tool images under
any prefix and build the runner with a builder that reads local images (the `docker` driver;
add `--builder default` when another buildx builder is selected):

```sh
docker build -t local/octohatchery-tool-ruby:dev runner/tools/ruby
docker build -t local/octohatchery-tool-bun:dev runner/tools/bun
docker build --build-arg TOOLS_REGISTRY=local --build-arg TOOLS_TAG=dev \
  -t ghcr.io/rojosinalma/octohatchery-runner:<tag> runner/
docker push ghcr.io/rojosinalma/octohatchery-runner:<tag>
```

Then set `image` on the runner type to that tag. Releases of OctoHatchery publish the same images
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

1. Run as a non-root user and own `RUNNER_TOOL_CACHE`. Bake the tools your jobs need into it, or let the setup actions download them per job.
2. Start the runner with `./run.sh --jitconfig "$RUNNER_JITCONFIG"` and exit when it returns.
3. Do not bake secrets in. Put their names in the runner type's `secretEnv` and the values in the node's `.env`.

Create a runner type that points at your image (dashboard, API or the `upsert_runner_type` MCP tool)
and give it slots on a host. See [docs/runner-types.md](../docs/runner-types.md).
