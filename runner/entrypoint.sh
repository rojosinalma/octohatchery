#!/bin/bash
# Starts one ephemeral GitHub Actions runner from a just-in-time config and exits when the job is done.
set -euo pipefail

if [[ -z "${RUNNER_JITCONFIG:-}" ]]; then
  echo "entrypoint: RUNNER_JITCONFIG is empty; this image is started by the orchestrator with a JIT config" >&2
  exit 64
fi

# Docker-in-Docker: the orchestrator starts a daemon sidecar next to this runner and points DOCKER_HOST at it.
# The daemon needs a few seconds; wait for it so the first `docker` step of the job does not fail.
if [[ -n "${DOCKER_HOST:-}" ]]; then
  for _ in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      echo "entrypoint: docker daemon at $DOCKER_HOST is ready"
      break
    fi
    sleep 1
  done
  if ! docker info >/dev/null 2>&1; then
    echo "entrypoint: docker daemon at $DOCKER_HOST did not answer within 30 s; docker steps in this job will fail" >&2
  fi
fi

# Point docker buildx at the shared buildkitd when the orchestrator provides one.
if [[ -n "${BUILDKIT_HOST:-}" ]]; then
  if docker buildx create --name octohatchery --driver remote "$BUILDKIT_HOST" --use >/dev/null 2>&1; then
    echo "entrypoint: buildx builder 'octohatchery' -> $BUILDKIT_HOST"
  else
    echo "entrypoint: could not create buildx builder for $BUILDKIT_HOST; docker build falls back to the default builder" >&2
  fi
fi

exec ./run.sh --jitconfig "$RUNNER_JITCONFIG"
