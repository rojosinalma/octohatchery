# Contributing

Thanks for taking the time. Here is how I work on OctoHatchery and what I look for in a change.

## Run it locally

You need Bun 1.4 or newer and a Docker daemon you can talk to.

```sh
git clone https://github.com/rojosinalma/octohatchery.git
cd octohatchery
bun install --frozen-lockfile
cp .env.example .env            # fill in MODE=single and a SQLite DATABASE_URL to start
bun --watch src/index.ts        # reloads on every save, listens on port 3000
```

`docker compose up -d` starts the same thing from the published image, plus the `buildkitd` sidecar.

## Before you open a pull request

Run the whole check locally. It is exactly what CI runs:

```sh
bin/verify
```

That scans for leaks, installs with a frozen lockfile, typechecks (`bun run typecheck`), runs the tests (`bun test`) and probes `/health`. A pull request has to pass it.

## Layout and style

- `src/lib/` is the logic. `src/routes/` validates input, calls into `lib` and responds with `{ ok, message, ...data }`. `src/db/` holds the Drizzle schema and migrations. `src/mcp/tools/` has one file per MCP tool. `src/views/` has the server-rendered pages. `runner/` builds the runner image.
- TypeScript strict. Named exports. One concern per file. `async`/`await`, no callback chains. Classes only for errors and adapters.
- Anything that can differ per installation is configuration: `.env` for bootstrap values and secrets, the `settings` table for tunables. Never a hardcoded path, host or port.
- Logs go through `src/lib/log.ts` with a subsystem prefix. Never `console.log` elsewhere.
- Extension points are registries: a new GitHub auth method, container backend, database driver or MCP tool is one new file plus one registration line. Do not special-case inside existing code.
- Secrets never land in the database or the logs. Runner types reference environment variable names; the node resolves the values at spawn time.
- Tests sit in `test/<area>/*.test.ts` and run with `bun test`. Database tests use SQLite in memory.
- Nothing private goes into the repository, and that includes tests. Mocks, fixtures, fakes, snapshots and expected strings use invented names (`acme`, `umbrella`, `node-a`, `example.com`), never the name of a real private project, organisation, repository, customer, person or machine, and never a real address, path, id or token. A log or API response captured for a fixture is scrubbed before it is committed. `bin/verify` checks for local paths, private addresses and LAN-only names, plus your own list of private names in `.git/info/leak-patterns` (one extended regular expression per line; the file is never committed).

Dependencies are pinned in `bun.lock`. Do not run `bun add` in a pull request without saying why the dependency earns its place.

## Commits and pull requests

- Keep commits focused and describe what changed and why, in plain words. I do not require Conventional Commits, but a prefix like `scheduler:` or `docs:` helps.
- **Every commit must be signed** (GPG or SSH signing). Unsigned commits cannot be merged.
- One topic per pull request. Fill in the template, link the issue if there is one, and say how you tested it.
- Add a line to `CHANGELOG.md` under `## [Unreleased]` when the change is visible to users.
- Do not include any attribution to AI tools in commits or code.

## Where decisions live

Architecture, security and data decisions are written down in [docs/SDD.md](docs/SDD.md) under "Design decisions". Read that section before proposing a change to the stack, the database, the modes, the webhook handling, the stable API, or what runners are allowed to do. If your change needs a decision to move, open an issue first so we can talk about it, then append a new row with the date. Existing rows are never edited.

## Releasing

Releases are tags `vX.Y.Z` on `main`. The release workflow builds and pushes the images and creates the GitHub release from the matching `CHANGELOG.md` section. Only I cut releases for now, but a pull request that moves the `[Unreleased]` entries into a new version section is welcome.

## Reporting security issues

Please do not open a public issue. See [SECURITY.md](SECURITY.md).
