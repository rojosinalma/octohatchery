import { describe, expect, test } from 'bun:test'
import { fresh, TEST_HOST } from './helpers'
import { rewriteRunsOn, runsOnSnippet } from '../../src/lib/runs-on'
import { service } from '../../src/lib/service'

const WORKFLOW = `name: ci
on: push
jobs:
  build:
    runs-on: ubuntu-latest  # hosted
    steps:
      - uses: actions/checkout@v4
  mac:
    runs-on: macos-14
  matrix:
    runs-on: \${{ matrix.os }}
  listed:
    runs-on: [self-hosted, linux]
  block:
    runs-on:
      - ubuntu-22.04
    steps: []
  bare:
    runs-on: "self-hosted"
`

describe('runs-on', () => {
  test('snippet with and without host', () => {
    expect(runsOnSnippet('generic')).toBe('runs-on: [self-hosted, generic]')
    expect(runsOnSnippet('deploy', 'node-a')).toBe('runs-on: [self-hosted, deploy, node-a]')
  })

  test('rewriter replaces ubuntu-* and bare self-hosted, keeps macos, matrix and custom label sets', () => {
    const { content, changed } = rewriteRunsOn(WORKFLOW, 'generic')
    expect(changed).toBe(3)
    expect(content).toContain('runs-on: [self-hosted, generic]  # hosted')
    expect(content).toContain('runs-on: macos-14')
    expect(content).toContain('runs-on: ${{ matrix.os }}')
    expect(content).toContain('runs-on: [self-hosted, linux]')
    expect(content).not.toContain('ubuntu-22.04')
    expect(content).not.toContain('"self-hosted"')
    expect(content.split('\n').filter((l) => l.includes('[self-hosted, generic]'))).toHaveLength(3)
    expect(rewriteRunsOn(content, 'generic').changed).toBe(0) // idempotent
  })

  test('applyRunsOn: snippet needs no repo; pr mode rewrites files and opens a PR via the client', async () => {
    const w = await fresh()
    const snippet = await service.applyRunsOn({ fullName: 'acme/app', mode: 'snippet', type: 'generic', host: TEST_HOST }, 'user')
    expect(snippet).toMatchObject({ ok: true, snippet: 'runs-on: [self-hosted, generic, node-a]' })
    await expect(service.applyRunsOn({ fullName: 'acme/app', mode: 'pr', type: 'generic' }, 'user')).rejects.toMatchObject({ code: 'invalid' })

    await service.adoptRepo('acme/app', 'user')
    w.github.files.set('acme/app:.github/workflows/ci.yml', WORKFLOW)
    w.github.files.set('acme/app:.github/workflows/mac.yml', 'jobs:\n  m:\n    runs-on: macos-14\n')
    const pr = await service.applyRunsOn({ fullName: 'acme/app', mode: 'pr', type: 'generic' }, 'user')
    expect(pr.ok).toBe(true)
    expect(pr.files).toEqual(['.github/workflows/ci.yml'])
    expect(pr.prUrl).toContain('/pull/')
    expect(w.github.calls.some((c) => c.method === 'createBranch')).toBe(true)
    expect(w.github.files.get('acme/app:.github/workflows/ci.yml')).toContain('[self-hosted, generic]')

    const nothing = await service.applyRunsOn({ fullName: 'acme/app', mode: 'commit', type: 'generic' }, 'user')
    expect(nothing.ok).toBe(false)
  })
})
