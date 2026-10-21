import { strFromU8, unzipSync } from 'fflate'

/*
 * GitHub's run-attempt log archive (`GET /repos/{o}/{r}/actions/runs/{run_id}/attempts/{n}/logs`, a zip): one flat
 * file per job at the top (`<i>_<job>.txt`, ignored here) and one folder per job (`<job>/`) holding one file per
 * step, `<step number>_<step name>.txt`, plus `system.txt` (GitHub's own job preparation lines, not part of any step
 * and not shown). Folder names are the job name as GitHub sanitises it for a file system; step file names may be
 * sanitised or cut short, so steps are matched by their leading number only. Pure functions, no I/O.
 */

/** Largest archive accepted, compressed and uncompressed (a run with many chatty jobs stays far below it). */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024

export type StepFile = { number: number; text: string }
export type ArchivePick = { ok: true; folder: string; steps: StepFile[] } | { ok: false; reason: string }

const STEP_FILE_RE = /^(\d+)_.*\.txt$/

/** Characters GitHub replaces in job names when it writes them as folder names. */
export const sanitiseJobName = (name: string): string => name.replace(/[\\/:*?"<>|\r\n\t]/g, '_')

/** Text of a log line without its leading timestamp and byte-order mark; blank lines become ''. */
const textOf = (raw: string): string => raw.replace(/^\uFEFF/, '').replace(/^\d{4}-\d{2}-\d{2}T\S+Z ?/, '')

/** Non-blank line texts (timestamps dropped): what two renderings of the same log agree on. */
export const comparableLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map(textOf)
    .filter((l) => l.trim() !== '')

type Entry = { folder: string; number: number; size: number }

/** Every `<folder>/<n>_<name>.txt` entry, by folder; nested paths, top-level files and `system.txt` are skipped. */
function listSteps(zip: Uint8Array): { byFolder: Map<string, Entry[]>; names: Map<string, string> } {
  const byFolder = new Map<string, Entry[]>()
  const names = new Map<string, string>()
  unzipSync(zip, {
    filter: (f) => {
      const parts = f.name.split('/')
      if (parts.length !== 2 || !parts[0]) return false
      const m = STEP_FILE_RE.exec(parts[1]!)
      if (!m) return false
      const entry = { folder: parts[0], number: Number(m[1]), size: f.originalSize }
      const list = byFolder.get(entry.folder) ?? []
      list.push(entry)
      byFolder.set(entry.folder, list)
      names.set(`${entry.folder}#${entry.number}`, f.name)
      return false // listing only: nothing is inflated in this pass
    },
  })
  return { byFolder, names }
}

/** Inflates one folder's step files, in step-number order; refuses a folder whose declared size passes the cap. */
function readFolder(zip: Uint8Array, folder: string, entries: Entry[], names: Map<string, string>): StepFile[] {
  const declared = entries.reduce((n, e) => n + e.size, 0)
  if (declared > MAX_ARCHIVE_BYTES) throw new Error(`folder "${folder}" holds ${declared} bytes uncompressed, over the ${MAX_ARCHIVE_BYTES} byte cap`)
  const wanted = new Set(entries.map((e) => names.get(`${folder}#${e.number}`)!))
  const files = unzipSync(zip, { filter: (f) => wanted.has(f.name) })
  return [...entries]
    .sort((a, b) => a.number - b.number)
    .map((e) => ({ number: e.number, text: strFromU8(files[names.get(`${folder}#${e.number}`)!] ?? new Uint8Array()) }))
}

/** True when the folder's lines are the flat log's lines (or a prefix of each other, for a capped log). */
function sameLog(steps: StepFile[], flat: string[]): boolean {
  const own = steps.flatMap((s) => comparableLines(s.text))
  const n = Math.min(own.length, flat.length)
  if (n === 0) return false
  for (let i = 0; i < n; i++) if (own[i] !== flat[i]) return false
  return true
}

/**
 * The step files of the job named `jobName`. One folder named like the job (exact, or as GitHub sanitises it) wins;
 * when none or several fit (matrix jobs, cut-short names), `flatLog` (the job's own log as GitHub returns it, or its
 * stored lines) decides: the one folder whose step files hold the same lines wins. Anything else is a reason.
 */
export function pickJobSteps(zip: Uint8Array, jobName: string, flatLog?: string): ArchivePick {
  if (zip.byteLength > MAX_ARCHIVE_BYTES) return { ok: false, reason: `archive is ${zip.byteLength} bytes, over the ${MAX_ARCHIVE_BYTES} byte cap` }
  let listed: ReturnType<typeof listSteps>
  try {
    listed = listSteps(zip)
  } catch (err) {
    return { ok: false, reason: `not a readable zip archive (${err instanceof Error ? err.message : String(err)})` }
  }
  const { byFolder, names } = listed
  if (!byFolder.size) return { ok: false, reason: 'archive holds no step files' }
  const folders = [...byFolder.keys()].sort()
  const sanitised = sanitiseJobName(jobName)
  const byName = folders.filter((f) => f === jobName || f === sanitised)
  try {
    if (byName.length === 1) return { ok: true, folder: byName[0]!, steps: readFolder(zip, byName[0]!, byFolder.get(byName[0]!)!, names) }
    const what = byName.length ? `${byName.length} folders are named "${jobName}"` : `no folder named "${jobName}"`
    if (flatLog === undefined) return { ok: false, reason: `${what} and no log to compare with` }
    // Several folders with the name (or none, e.g. a cut-short matrix name): the content decides among them.
    const candidates = byName.length ? byName : folders
    const declared = candidates.reduce((n, f) => n + byFolder.get(f)!.reduce((m, e) => m + e.size, 0), 0)
    if (declared > MAX_ARCHIVE_BYTES) return { ok: false, reason: `${what}; comparing ${candidates.length} folders would inflate ${declared} bytes, over the ${MAX_ARCHIVE_BYTES} byte cap` }
    const flat = comparableLines(flatLog)
    const matches: { folder: string; steps: StepFile[] }[] = []
    for (const folder of candidates) {
      const steps = readFolder(zip, folder, byFolder.get(folder)!, names)
      if (sameLog(steps, flat)) matches.push({ folder, steps })
    }
    if (matches.length === 1) return { ok: true, ...matches[0]! }
    return { ok: false, reason: `${what}, and ${matches.length ? `${matches.length} folders hold` : 'no folder holds'} the same lines as the job's log` }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
