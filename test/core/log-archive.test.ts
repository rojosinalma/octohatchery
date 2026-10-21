import { describe, expect, test } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { job87Flat as flatFromZip, job87Zip } from './job87'
import { comparableLines, MAX_ARCHIVE_BYTES, pickJobSteps, sanitiseJobName } from '../../src/lib/github/log-archive'
import { parseAnnotations, restClient } from '../../src/lib/github/rest'

const stamp = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, '0')}.0000000Z`
const file = (lines: string[]) => strToU8('\uFEFF' + lines.map((l, i) => `${stamp(i)} ${l}`).join('\n') + '\n')

describe('run-attempt log archive', () => {
  test('job 87: the folder named after the job, one file per step in number order, system.txt and the flat file left out', () => {
    const pick = pickJobSteps(job87Zip(), 'lint')
    expect(pick.ok).toBe(true)
    if (!pick.ok) return
    expect(pick.folder).toBe('lint')
    expect(pick.steps.map((s) => s.number)).toEqual([1, 2, 3, 4, 8, 9])
    const text = pick.steps.map((s) => s.text).join('')
    expect(text).not.toContain('Evaluating lint.if') // system.txt
    const standard = comparableLines(pick.steps.find((s) => s.number === 4)!.text)
    expect(standard).toHaveLength(96)
    expect(standard[0]).toBe('##[group]Run bundle exec standardrb')
    expect(standard.at(-1)).toBe('##[error]Process completed with exit code 1.')
    expect(comparableLines(pick.steps.find((s) => s.number === 9)!.text)).toEqual(['Cleaning up orphan processes'])
  })

  test('step files match by their leading number; names are never trusted', () => {
    const zip = zipSync({ 'build/2_Run a_b with a very long name that GitHub cut sh.txt': file(['two']), 'build/10_x.txt': file(['ten']), 'build/1_.txt': file(['one']), 'build/notes.txt': file(['no']), 'build/sub/3_y.txt': file(['nested']) })
    const pick = pickJobSteps(zip, 'build')
    expect(pick.ok && pick.steps.map((s) => [s.number, comparableLines(s.text)])).toEqual([
      [1, ['one']],
      [2, ['two']],
      [10, ['ten']],
    ])
  })

  test('folder name as GitHub sanitises it; without a name match the content decides (matrix jobs)', () => {
    const named = zipSync({ 'deploy_prod/1_Set up job.txt': file(['a']) })
    expect(sanitiseJobName('deploy/prod')).toBe('deploy_prod')
    expect(pickJobSteps(named, 'deploy/prod')).toMatchObject({ ok: true, folder: 'deploy_prod' })

    const matrix = zipSync({
      'test (ubuntu-latest, 1_/1_Set up job.txt': file(['set up', 'node 18']),
      'test (ubuntu-latest, 2_/1_Set up job.txt': file(['set up', 'node 20']),
    })
    // A cut-short matrix name matches no folder: without the job's own log there is nothing to decide with.
    expect(pickJobSteps(matrix, 'test (ubuntu-latest, 20)')).toMatchObject({ ok: false, reason: expect.stringContaining('no folder named') })
    const flat = [`${stamp(0)} set up`, `${stamp(1)} node 20`, ''].join('\n')
    expect(pickJobSteps(matrix, 'test (ubuntu-latest, 20)', flat)).toMatchObject({ ok: true, folder: 'test (ubuntu-latest, 2_' })
    // Timestamps differ between the archive and the job log; only the text is compared.
    expect(pickJobSteps(matrix, 'x', `2026-01-01T09:09:09.1234567Z set up\n2026-01-01T09:09:09.2Z node 18`)).toMatchObject({ ok: true, folder: 'test (ubuntu-latest, 1_' })
    expect(pickJobSteps(matrix, 'x', `${stamp(0)} something else`)).toMatchObject({ ok: false, reason: expect.stringContaining('no folder holds') })
    // job 87 found by content when the stored name does not match
    expect(pickJobSteps(job87Zip(), 'renamed', flatFromZip())).toMatchObject({ ok: true, folder: 'lint' })
  })

  test('a wrong or oversized archive is a reason, never a throw', () => {
    expect(pickJobSteps(strToU8('<html>not a zip</html>'), 'lint')).toMatchObject({ ok: false, reason: expect.stringContaining('not a readable zip archive') })
    expect(pickJobSteps(zipSync({ '0_lint.txt': file(['flat only']) }), 'lint')).toEqual({ ok: false, reason: 'archive holds no step files' })
    expect(pickJobSteps(new Uint8Array(MAX_ARCHIVE_BYTES + 1), 'lint')).toMatchObject({ ok: false, reason: expect.stringContaining('over the') })
  })
})

describe('check-run annotations', () => {
  test('schema-checked per item, capped, messages cut, empty fields null', () => {
    const out = parseAnnotations(
      [
        { path: '.github', start_line: 1, end_line: 1, annotation_level: 'failure', title: '', message: 'Process completed with exit code 1.' },
        { path: 'lib/a.rb', start_line: 4, end_line: 6, annotation_level: 'warning', title: 'Style/GlobalVars', message: 'x'.repeat(5000) },
        { annotation_level: 'bogus', message: 'dropped' },
        { path: 'b', annotation_level: 'notice', message: 'kept' },
        { annotation_level: 'notice', message: 'over the cap' },
      ],
      3,
    )
    expect(out).toEqual([
      { level: 'failure', message: 'Process completed with exit code 1.', title: null, path: '.github', startLine: 1, endLine: 1 },
      { level: 'warning', message: 'x'.repeat(2000), title: 'Style/GlobalVars', path: 'lib/a.rb', startLine: 4, endLine: 6 },
      { level: 'notice', message: 'kept', title: null, path: 'b', startLine: null, endLine: null },
    ])
    expect(() => parseAnnotations({ message: 'not a list' }, 5)).toThrow('expected a list')
  })
})

describe('rest client: run-attempt archive download', () => {
  test('asks GitHub without following the redirect, downloads the zip from Location, refuses past the cap', async () => {
    const zip = job87Zip()
    const server = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === '/gone' ? new Response('', { status: 410 }) : new Response(zip, { headers: { 'content-type': 'application/zip' } })) })
    const asked: { route: string; params: Record<string, unknown> }[] = []
    let location = `http://127.0.0.1:${server.port}/archive.zip`
    const octokit = {
      request: async (route: string, params: Record<string, unknown>) => {
        asked.push({ route, params })
        return { status: 302, headers: { location }, data: '' }
      },
    }
    const client = restClient('pat', async () => octokit as never, {} as never)
    try {
      const got = await client.getRunAttemptLogs('acme/widgets', 9001, 2, 10 * 1024 * 1024)
      expect(got.byteLength).toBe(zip.byteLength)
      expect(asked).toEqual([{ route: 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/logs', params: { owner: 'acme', repo: 'widgets', run_id: 9001, attempt_number: 2, request: { redirect: 'manual' } } }])
      await expect(client.getRunAttemptLogs('acme/widgets', 9001, 2, 1000)).rejects.toThrow('over the 1000 byte cap')
      location = `http://127.0.0.1:${server.port}/gone`
      await expect(client.getRunAttemptLogs('acme/widgets', 9001, 2, 1000)).rejects.toMatchObject({ status: 410 })
    } finally {
      server.stop(true)
    }
  })
})
