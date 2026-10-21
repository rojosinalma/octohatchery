# Bun tool image for the OctoHatchery runner: the official Bun release binary at ~/.bun/bin/bun of the
# runner user, where oven-sh/setup-bun looks first and reuses it when the version matches. The final
# image holds only that tree; the runner image copies it in (see ../../README.md).
# Bump the version: edit BUN_VERSION and push to main.
# Built as ghcr.io/rojosinalma/octohatchery-tool-bun:<tag>.

FROM ghcr.io/actions/actions-runner:2.338.0 AS build

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Root only in this build stage; the final stage is scratch and has no user.
# hadolint ignore=DL3002
USER 0

ARG BUN_VERSION=1.4.3
ARG TARGETARCH

# The zip is checked against the release's SHASUMS256.txt before it is unpacked.
WORKDIR /tmp/bun
RUN case "${TARGETARCH:-amd64}" in \
        amd64) asset=bun-linux-x64 ;; \
        arm64) asset=bun-linux-aarch64 ;; \
        *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && base="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}" \
    && curl -fsSLO "${base}/${asset}.zip" \
    && curl -fsSLO "${base}/SHASUMS256.txt" \
    && grep " ${asset}.zip\$" SHASUMS256.txt | sha256sum -c - \
    && unzip -q "${asset}.zip" \
    && install -d /home/runner/.bun/bin \
    && install -m 0755 "${asset}/bun" /home/runner/.bun/bin/bun \
    && ln -s bun /home/runner/.bun/bin/bunx \
    && test "$(/home/runner/.bun/bin/bun --version)" = "${BUN_VERSION}"

FROM scratch
COPY --from=build /home/runner/.bun/ /home/runner/.bun/
