import { hostname } from 'node:os'

export type Mode = 'single' | 'cluster'
export type GitHubAuthKind = 'app' | 'pat' | 'none'
export type BackendKind = 'docker' | 'fake'

export type Config = {
  port: number
  mode: Mode
  databaseUrl: string
  hostName: string
  dockerHost: string | undefined
  backend: BackendKind
  runnerNetwork: string
  githubAuth: GitHubAuthKind
  githubAppId: string | undefined
  githubAppPrivateKey: string | undefined
  githubAppInstallationId: string | undefined
  githubToken: string | undefined
  githubWebhookSecret: string | undefined
  publicUrl: string | undefined
  dataDir: string
  /** Postgres schema from `DATABASE_SCHEMA`; undefined = the default (see src/lib/octoforge/database.ts). */
  databaseSchema: string | undefined
  /** Bearer for the Octoforge member API; unset = the `/api/octoforge` routes do not exist. */
  octoforgeToken: string | undefined
  /**
   * No GitHub variables at all but `OCTOFORGE_TOKEN` set: the node starts without GitHub access and waits for
   * Octoforge to deliver a credential (`PUT /api/octoforge/github`). GitHub calls fail with a reason until then.
   */
  githubAwaitingDelivery: boolean
}

export class ConfigError extends Error {}

/** Database URL schemes the drivers handle; shared with the Octoforge adoption, which validates the same way. */
export const DATABASE_URL_PATTERN = /^(sqlite:|postgres(ql)?:\/\/)/
/** A Postgres schema name we accept: lowercase, unquoted identifier; `pg_` is reserved by Postgres. */
export const SCHEMA_NAME_PATTERN = /^(?!pg_)[a-z_][a-z0-9_]{0,62}$/

const MODES: readonly Mode[] = ['single', 'cluster']
const AUTHS: readonly GitHubAuthKind[] = ['app', 'pat', 'none']
const BACKENDS: readonly BackendKind[] = ['docker', 'fake']

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = (value ?? fallback) as T
  if (!allowed.includes(v)) throw new ConfigError(`${name} must be one of ${allowed.join(', ')}, got "${value}"`)
  return v
}

function intOf(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer, got "${value}"`)
  return n
}

/** Private keys arrive from .env with literal "\n"; restore real newlines. */
function pem(value: string | undefined): string | undefined {
  return value ? value.replace(/\\n/g, '\n') : undefined
}

/** Pure: builds and validates a config from an env map. Throws ConfigError with a reason. */
export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  const mode = oneOf('MODE', env.MODE, MODES, 'single')
  const databaseUrl = env.DATABASE_URL ?? 'sqlite:./data/octohatchery.db'
  if (mode === 'cluster' && databaseUrl.startsWith('sqlite:')) {
    throw new ConfigError('MODE=cluster needs a shared database: set DATABASE_URL to a postgres:// URL')
  }
  if (!DATABASE_URL_PATTERN.test(databaseUrl)) {
    throw new ConfigError(`DATABASE_URL must start with sqlite: or postgres://, got "${databaseUrl}"`)
  }
  const githubAwaitingDelivery = !env.GITHUB_AUTH && !!env.OCTOFORGE_TOKEN && !env.GITHUB_APP_ID && !env.GITHUB_TOKEN
  const githubAuth = githubAwaitingDelivery ? 'none' : oneOf('GITHUB_AUTH', env.GITHUB_AUTH, AUTHS, 'app')
  const cfg: Config = {
    port: intOf('PORT', env.PORT, 3000),
    mode,
    databaseUrl,
    hostName: env.HOST_NAME || hostname(),
    dockerHost: env.DOCKER_HOST || undefined,
    backend: oneOf('CONTAINER_BACKEND', env.CONTAINER_BACKEND, BACKENDS, 'docker'),
    runnerNetwork: env.RUNNER_NETWORK || 'octohatchery_default',
    githubAuth,
    githubAppId: env.GITHUB_APP_ID || undefined,
    githubAppPrivateKey: pem(env.GITHUB_APP_PRIVATE_KEY),
    githubAppInstallationId: env.GITHUB_APP_INSTALLATION_ID || undefined,
    githubToken: env.GITHUB_TOKEN || undefined,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET || undefined,
    publicUrl: env.PUBLIC_URL?.replace(/\/$/, '') || undefined,
    dataDir: env.DATA_DIR || './data',
    databaseSchema: env.DATABASE_SCHEMA || undefined,
    octoforgeToken: env.OCTOFORGE_TOKEN || undefined,
    githubAwaitingDelivery,
  }
  if (cfg.databaseSchema !== undefined && !SCHEMA_NAME_PATTERN.test(cfg.databaseSchema)) {
    throw new ConfigError(`DATABASE_SCHEMA must be a lowercase identifier (a-z, 0-9, _, not starting with pg_), got "${cfg.databaseSchema}"`)
  }
  if (githubAuth === 'app') {
    for (const [k, v] of [
      ['GITHUB_APP_ID', cfg.githubAppId],
      ['GITHUB_APP_PRIVATE_KEY', cfg.githubAppPrivateKey],
    ] as const) {
      if (!v) throw new ConfigError(`GITHUB_AUTH=app needs ${k}`)
    }
    // Optional: names the default installation; without it the App's installations are discovered.
    if (cfg.githubAppInstallationId !== undefined) intOf('GITHUB_APP_INSTALLATION_ID', cfg.githubAppInstallationId, 0)
  }
  if (githubAuth === 'pat' && !cfg.githubToken) throw new ConfigError('GITHUB_AUTH=pat needs GITHUB_TOKEN')
  if (githubAuth !== 'none' && !cfg.githubWebhookSecret) {
    throw new ConfigError('GITHUB_WEBHOOK_SECRET is required so webhook signatures can be verified')
  }
  return cfg
}

let current: Config | undefined

/** Process-wide config, read once from Bun.env on first use. */
export function config(): Config {
  current ??= loadConfig()
  return current
}

/** Tests only: replace the cached config. */
export function setConfig(next: Config | undefined): void {
  current = next
}
