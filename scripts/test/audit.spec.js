'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const repoRoot = path.join(__dirname, '..', '..')
const auditScript = path.join(repoRoot, 'scripts', 'audit.js')
const bunVersion = require('../../package.json').devDependencies.bun

/**
 * @param {string} id
 * @param {string} severity
 */
function advisory (id, severity) {
  return { id: 1, url: `https://github.com/advisories/${id}`, severity, title: `${id} title` }
}

describe('scripts/audit.js', () => {
  let fixtureDirectory

  beforeEach(() => {
    fixtureDirectory = fs.mkdtempSync(path.join(tmpdir(), 'dd-trace-audit-'))
  })

  afterEach(() => {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true })
  })

  it('passes when every advisory at or above the threshold is accepted', () => {
    const result = runAudit({
      report: {
        'some-package': [advisory('GHSA-aaaa-aaaa-aaaa', 'high')],
        'noisy-package': [advisory('GHSA-cccc-cccc-cccc', 'low')],
      },
      allow: [{ id: 'GHSA-aaaa-aaaa-aaaa', package: 'some-package', reason: 'upstream ships no patched release' }],
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('fails on an advisory at the threshold that is not accepted', () => {
    const result = runAudit({
      report: { 'some-package': [advisory('GHSA-bbbb-bbbb-bbbb', 'high')] },
      allow: [],
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /unaccepted high advisory GHSA-bbbb-bbbb-bbbb in some-package/)
  })

  it('ignores an advisory below the directory threshold', () => {
    const result = runAudit({
      report: { 'some-package': [advisory('GHSA-cccc-cccc-cccc', 'moderate')] },
      allow: [],
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('fails on an accepted advisory that is no longer reported', () => {
    // The reason this wrapper exists: `bun audit --ignore <id>` takes ids it never saw without complaining, so a
    // suppression keeps hiding an advisory long after the dependency was patched and nothing reports the entry is dead.
    const result = runAudit({
      report: {},
      allow: [{ id: 'GHSA-dddd-dddd-dddd', package: 'gone', reason: 'was unpatched when this was added' }],
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /GHSA-dddd-dddd-dddd \(gone\) is no longer reported/)
  })

  it('fails when an accepted advisory carries no reason', () => {
    const result = runAudit({
      report: { 'some-package': [advisory('GHSA-eeee-eeee-eeee', 'high')] },
      allow: [{ id: 'GHSA-eeee-eeee-eeee', package: 'some-package', reason: '  ' }],
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /needs a reason/)
  })

  it('fails when an audited directory has no allowlist entry', () => {
    const result = runAudit({ report: {}, allow: [], directory: 'unlisted' })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /has no entry in/)
  })

  it('fails when bun produces no output rather than reporting a clean tree', () => {
    const result = runAudit({ report: {}, allow: [], bunOutput: '' })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /produced no output/)
  })

  /**
   * Runs the real script against a stub `bun` so the assertions cover the wrapper's decisions rather than whatever the
   * repository's own lockfiles happen to report today.
   *
   * @param {{ report: object, allow: object[], directory?: string, bunOutput?: string }} options
   * @returns {import('node:child_process').SpawnSyncReturns<string>}
   */
  function runAudit ({ report, allow, directory = 'audited', bunOutput }) {
    const allowlistPath = path.join(fixtureDirectory, 'audit-allowlist.json')
    fs.writeFileSync(allowlistPath, JSON.stringify({ directories: { audited: { level: 'high', allow } } }))
    fs.mkdirSync(path.join(fixtureDirectory, 'audited'), { recursive: true })

    // `getBunBinary()` accepts the `bun` on PATH only when it reports the pinned version, so the stub answers
    // `--version` as well as `audit --json`.
    const stubDirectory = path.join(fixtureDirectory, 'bin')
    fs.mkdirSync(stubDirectory, { recursive: true })
    const stub = path.join(stubDirectory, 'bun')
    fs.writeFileSync(stub, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      `  echo ${bunVersion}`,
      '  exit 0',
      'fi',
      "cat <<'REPORT'",
      bunOutput ?? JSON.stringify(report),
      'REPORT',
    ].join('\n'))
    fs.chmodSync(stub, 0o755)

    return spawnSync(process.execPath, [auditScript, '--allowlist', allowlistPath, directory], {
      cwd: fixtureDirectory,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${stubDirectory}:${process.env.PATH}` },
    })
  }
})
