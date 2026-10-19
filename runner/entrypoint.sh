#!/bin/bash
# Starts one ephemeral GitHub Actions runner from a just-in-time config and exits when the job is done.
set -euo pipefail

if [[ -z "${RUNNER_JITCONFIG:-}" ]]; then
  echo "entrypoint: RUNNER_JITCONFIG is empty; this image is started by the orchestrator with a JIT config" >&2
  exit 64
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
