# Runner image for OctoHatchery: the official GitHub Actions runner plus the tools most jobs expect.
# Built as ghcr.io/rojosinalma/octohatchery-runner:<tag>; see README.md in this folder.
FROM ghcr.io/actions/actions-runner:2.338.0

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

USER 0

# Ubuntu does not keep old package versions, so pinning apt versions would break the build after
# every upstream update. The base image tag pins the OS release instead.
# GitHub CLI comes from its apt repo, the Docker CLI and buildx plugin from Docker's (no daemon).
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg jq git-lfs unzip \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod go+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh docker-ce-cli docker-buildx-plugin \
    && git lfs install --system \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Shared tool cache (actions/setup-* downloads) mounted from a per-host volume by the orchestrator.
ENV RUNNER_TOOL_CACHE=/opt/hostedtoolcache
RUN install -d -o runner -g runner -m 0755 /opt/hostedtoolcache

COPY --chown=runner:runner --chmod=0755 entrypoint.sh /entrypoint.sh

# runner is uid 1001 in the base image.
USER 1001:1001
WORKDIR /home/runner

ENTRYPOINT ["/entrypoint.sh"]
