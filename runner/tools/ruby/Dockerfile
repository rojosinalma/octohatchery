# Ruby tool image for the OctoHatchery runner: prebuilt Rubies from ruby/ruby-builder in the layout
# ruby/setup-ruby expects ($RUNNER_TOOL_CACHE/Ruby/<version>/<arch> plus an <arch>.complete marker),
# each with the listed Bundler versions installed. The final image holds only that tree; the runner
# image copies it in (see ../../README.md).
# Bump a version: edit RUBY_VERSIONS or BUNDLER_VERSIONS and push to main.
# Built as ghcr.io/rojosinalma/octohatchery-tool-ruby:<tag>.

# Same base as the runner image, so the Rubies are checked against the libraries they will run with.
FROM ghcr.io/actions/actions-runner:2.338.0 AS build

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Root only in this build stage; the final stage is scratch and has no user.
# hadolint ignore=DL3002
USER 0

ARG RUBY_VERSIONS="3.3.12 3.4.11"
ARG BUNDLER_VERSIONS="2.5.22 2.6.9 4.0.22"
ARG TARGETARCH

# The binaries are built for the prefix /opt/hostedtoolcache/Ruby/<version>/<arch>, so they must live
# exactly there. The tarball holds the <arch>/ folder.
RUN case "${TARGETARCH:-amd64}" in \
        amd64) arch=x64 ;; \
        arm64) arch=arm64 ;; \
        *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && for v in ${RUBY_VERSIONS}; do \
        dir="/opt/hostedtoolcache/Ruby/${v}" \
        && install -d "${dir}" \
        && curl -fsSL "https://github.com/ruby/ruby-builder/releases/download/ruby-${v}/ruby-${v}-ubuntu-24.04-${arch}.tar.gz" \
            | tar -xz -C "${dir}" \
        && touch "${dir}/${arch}.complete" \
        && for b in ${BUNDLER_VERSIONS}; do \
            "${dir}/${arch}/bin/gem" install bundler -v "${b}" --no-document; \
        done \
        && "${dir}/${arch}/bin/ruby" -e 'require "yaml"; require "openssl"; require "zlib"; puts "#{RUBY_DESCRIPTION} #{OpenSSL::OPENSSL_LIBRARY_VERSION}"' \
        && for b in ${BUNDLER_VERSIONS}; do \
            "${dir}/${arch}/bin/bundle" "_${b}_" --version; \
        done; \
    done

FROM scratch
COPY --from=build /opt/hostedtoolcache/Ruby/ /opt/hostedtoolcache/Ruby/
