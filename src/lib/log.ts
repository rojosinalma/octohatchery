import { settings } from './settings'

export type Level = 'debug' | 'info' | 'warn' | 'error'
export type Logger = Record<Level, (message: string, ...rest: unknown[]) => void>

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function enabled(level: Level): boolean {
  const configured = settings.peek('log_level', 'info') as Level
  return ORDER[level] >= (ORDER[configured] ?? ORDER.info)
}

function format(rest: unknown[]): string {
  return rest
    .map((r) => (r instanceof Error ? `${r.message}\n${r.stack ?? ''}` : typeof r === 'string' ? r : JSON.stringify(r)))
    .join(' ')
}

/** Stdout logger with a `[subsystem]` prefix; the level comes from the `log_level` setting. */
export function log(subsystem: string): Logger {
  const write = (level: Level, message: string, rest: unknown[]) => {
    if (!enabled(level)) return
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${subsystem}] ${message}${rest.length ? ' ' + format(rest) : ''}\n`
    // The only place that writes to stdout/stderr directly.
    if (level === 'error' || level === 'warn') process.stderr.write(line)
    else process.stdout.write(line)
  }
  return {
    debug: (m, ...r) => write('debug', m, r),
    info: (m, ...r) => write('info', m, r),
    warn: (m, ...r) => write('warn', m, r),
    error: (m, ...r) => write('error', m, r),
  }
}
