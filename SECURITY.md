# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's security advisories:

[https://github.com/rojosinalma/octohatchery/security/advisories/new](https://github.com/rojosinalma/octohatchery/security/advisories/new)

Do not open a public issue for anything that could be a vulnerability. Include what you found, how to reproduce it, which version you tested, and what an attacker could do with it.

I aim to acknowledge a report within a week and to publish a fix, or a clear explanation of why it is not a vulnerability, within 30 days of confirming it. You will be credited in the advisory unless you ask not to be.

## Supported versions

The latest minor version receives security fixes. Older minor versions do not. If you run an older version, upgrade first and check whether the problem still exists.

## Scope

OctoHatchery runs containers from configurable images, talks to a Docker daemon and holds GitHub credentials. These are the areas I care most about:

- Webhook signature verification and the handling of unsigned or malformed payloads.
- Leakage of secrets (GitHub App keys, tokens, JIT runner configurations, secret environment values) into logs, the database, the API or the dashboard.
- Jobs from repositories that were not adopted being accepted.
- Runners receiving privileges their type does not grant (socket, capabilities, mounts).
- Injection through job labels, repository names or workflow contents.

Out of scope by design: OctoHatchery has no built-in authentication. Exposure of the dashboard, API or MCP endpoint without a reverse proxy in front is a deployment choice, not a vulnerability. The README and `docs/operations.md` explain how to put SSO in front of it.
