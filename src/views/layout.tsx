import { type PropsWithChildren } from '@kitajs/html'
import type { GitHubStatus } from '../lib/github/permissions'
import { BrandMark, Icon } from './parts'

export type NavKey = 'overview' | 'repos' | 'jobs' | 'runner-types' | 'hosts' | 'events' | 'settings'

export const NAV: { key: NavKey; href: string; label: string; icon: string }[] = [
  { key: 'overview', href: '/', label: 'Overview', icon: 'bi-speedometer2' },
  { key: 'repos', href: '/repos', label: 'Repos', icon: 'bi-github' },
  { key: 'jobs', href: '/jobs', label: 'Jobs', icon: 'bi-briefcase' },
  { key: 'runner-types', href: '/runner-types', label: 'Runner types', icon: 'bi-cpu' },
  { key: 'hosts', href: '/hosts', label: 'Hosts', icon: 'bi-hdd-rack' },
  { key: 'events', href: '/events', label: 'Events', icon: 'bi-journal-text' },
  { key: 'settings', href: '/settings', label: 'Settings', icon: 'bi-gear' },
]

export type Theme = { skin?: string; palette?: string; mode?: string }

export type LayoutProps = PropsWithChildren<{
  title: string
  active: NavKey
  /** `tailor-head.html` content, vendored by `tailor apply`; read once by the route. */
  tailorHead: string
  version: string
  /** Server-side theme choice (settings `ui_skin`, `ui_palette`, `ui_mode`), seeded into the flash cache on first visit. */
  theme?: Theme
  /** Optional `.t-shell-side` content (settings page). */
  side?: JSX.Element
  repoUrl?: string
  /** Cached GitHub check; drives the warning banner when a permission is missing or no source is configured. */
  github?: Pick<GitHubStatus, 'source' | 'missing'>
}>

/** One banner under the navbar on every page while GitHub access is incomplete; nothing when it is fine. */
export const GitHubBanner = ({ github }: { github?: Pick<GitHubStatus, 'source' | 'missing'> }) => {
  if (!github || (github.source !== 'none' && github.missing.length === 0)) return null
  const text =
    github.source === 'none'
      ? 'GitHub access is not configured (GITHUB_AUTH=none): nothing can be adopted and no runner can register.'
      : `GitHub access lacks ${github.missing.join(', ')}. Some actions will fail until the permissions are granted.`
  return (
    <div class="t-alert page-banner" data-tone="warning" role="alert" id="github-banner">
      <Icon id="bi-exclamation-triangle" />
      <div class="t-alert-body" safe>
        {text}
      </div>
      <div class="t-alert-actions">
        <a class="t-btn" data-size="sm" href="/settings#github">
          GitHub settings
        </a>
      </div>
    </div>
  )
}

const SAFE_ID = /^[a-z0-9-]+$/
const seedTheme = (theme: Theme) =>
  `(function(){try{var t=${JSON.stringify(Object.fromEntries(Object.entries(theme).filter(([, v]) => v && SAFE_ID.test(v))))};for(var k in t){if(t[k]&&!localStorage.getItem('octohatchery.'+k))localStorage.setItem('octohatchery.'+k,t[k])}}catch(e){}})();`

export const Layout = ({ title, active, tailorHead, version, theme = {}, side, repoUrl, github, children }: LayoutProps) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title safe>{`${title} · OctoHatchery`}</title>
      <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      <script>{seedTheme(theme)}</script>
      {tailorHead}
      <link rel="stylesheet" href="/public/app.css" />
    </head>
    <body>
      <div class="t-shell">
        <header class="t-navbar t-shell-nav">
          <a class="t-navbar-brand" href="/">
            <BrandMark />
            OctoHatchery
          </a>
          <ul class="t-navbar-nav">
            {NAV.map((n) => (
              <li>
                <a class="t-navbar-link" href={n.href} aria-current={n.key === active ? 'page' : undefined}>
                  <Icon id={n.icon} />
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
          <div class="t-navbar-end">
            <span class="t-dot" data-status="muted" id="live-dot" data-tip="Live updates: connecting"></span>
          </div>
        </header>
        {side ? <aside class="t-shell-side">{side}</aside> : null}
        <main class="t-shell-main t-page">
          <GitHubBanner github={github} />
          {children}
        </main>
        <footer class="t-footer t-shell-foot">
          <a class="t-footer-repo" href={repoUrl ?? 'https://github.com/rojosinalma/octohatchery'} data-tip="Repository" aria-label="Repository">
            <Icon id="bi-github" />
          </a>
          <div class="t-footer-end">
            <div data-tailor-pickers="mode"></div>
            <span class="t-footer-version" safe>
              {`v${version}`}
            </span>
          </div>
        </footer>
      </div>
      <div class="t-toasts" id="t-toasts" aria-live="polite" aria-atomic="false"></div>
      <dialog class="t-dialog" id="t-confirm" data-variant="confirm" data-tone="danger" aria-labelledby="t-confirm-title">
        <div class="t-dialog-header">
          <h2 class="t-dialog-title" id="t-confirm-title">
            <span class="t-icon">▲</span>
            <span>Are you sure?</span>
          </h2>
          <button class="t-dialog-close" aria-label="Close" data-dialog-close>
            ×
          </button>
        </div>
        <div class="t-dialog-body" id="t-confirm-body"></div>
        <div class="t-dialog-footer">
          <button class="t-btn" data-dialog-close>
            Cancel
          </button>
          <button class="t-btn" data-variant="danger" id="t-confirm-ok">
            Confirm
          </button>
        </div>
      </dialog>
      <script src="/public/app.js" defer></script>
    </body>
  </html>
)
