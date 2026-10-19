import { runsOnLabels } from './labels'

/** `runs-on: [self-hosted, <type>]` or with a host pin, ready to paste into a workflow. */
export function runsOnSnippet(type: string, host?: string): string {
  return `runs-on: [${runsOnLabels(type, host).join(', ')}]`
}

const HOSTED_SINGLE = /^(ubuntu-[\w.-]+|self-hosted)$/i
const RUNS_ON_LINE = /^(\s*(?:-\s*)?runs-on:\s*)(.*?)(\s*(?:#.*)?)$/

function isHostedValue(value: string): boolean {
  const v = value.trim().replace(/^["']|["']$/g, '')
  if (HOSTED_SINGLE.test(v)) return true
  if (v.startsWith('[') && v.endsWith(']')) {
    const items = v
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
    return items.length > 0 && items.every((i) => HOSTED_SINGLE.test(i))
  }
  return false
}

/**
 * Rewrites `runs-on:` values that target GitHub-hosted Ubuntu runners or a bare `self-hosted`
 * to the given label array. Other values (matrix expressions, windows, macos, custom labels)
 * are kept as they are. Line-based on purpose: it preserves the file's formatting and comments.
 * Block-style lists (`runs-on:` followed by `- item` lines) are rewritten when every item is hosted.
 */
export function rewriteRunsOn(yaml: string, type: string, host?: string): { content: string; changed: number } {
  const target = `[${runsOnLabels(type, host).join(', ')}]`
  const lines = yaml.split('\n')
  let changed = 0
  for (let i = 0; i < lines.length; i++) {
    const m = RUNS_ON_LINE.exec(lines[i]!)
    if (!m) continue
    const [, head, value, tail] = m
    if (value && value.trim() !== '') {
      if (isHostedValue(value)) {
        lines[i] = `${head}${target}${tail ?? ''}`
        changed++
      }
      continue
    }
    // block list: collect following "- x" lines with deeper indent
    const indent = head!.match(/^\s*/)?.[0].length ?? 0
    let j = i + 1
    const items: string[] = []
    while (j < lines.length) {
      const item = /^(\s*)-\s*(.+?)\s*$/.exec(lines[j]!)
      if (!item || item[1]!.length <= indent) break
      items.push(item[2]!)
      j++
    }
    if (items.length && items.every((it) => isHostedValue(it))) {
      lines.splice(i, j - i, `${head}${target}${tail ?? ''}`)
      changed++
    }
  }
  return { content: lines.join('\n'), changed }
}
