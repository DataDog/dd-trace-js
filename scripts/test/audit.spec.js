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
  return { url: `https://github.com/advisories/${id}`, severity, title: `${id} title` }
}

describe('scripts/audit.js', () => {
  let fixtureDirectory

  beforeEach(() => {
    fixtureDirectory = fs.mkdtempSync(path.join(tmpdir(), 'dd-trace-audit-'))
  })

  afterEach(() => {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true })
  })

  it('uses high as the default and accepts only matching exceptions', () => {
    const result = runAudit({
      report: {
        'accepted-package': [advisory('GHSA-aaaa-aaaa-aaaa', 'high')],
        'below-threshold': [advisory('GHSA-bbbb-bbbb-bbbb', 'moderate')],
      },
      policy: {
        allow: [{
          id: 'GHSA-aaaa-aaaa-aaaa',
          package: 'accepted-package',
          reason: 'upstream has no patched release',
        }],
      },
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('supports lowering the threshold for a shipped dependency tree', () => {
    const result = runAudit({
      report: { 'some-package': [advisory('GHSA-cccc-cccc-cccc', 'moderate')] },
      policy: { level: 'moderate' },
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /unaccepted moderate advisory GHSA-cccc-cccc-cccc in some-package/)
  })

  it('defaults a directory missing from the policy to no exceptions', () => {
    const result = runAudit({
      report: { 'some-package': [advisory('GHSA-dddd-dddd-dddd', 'high')] },
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /unaccepted high advisory GHSA-dddd-dddd-dddd in some-package/)
  })

  it('fails on stale and unnecessary exceptions', () => {
    const stale = runAudit({
      report: {},
      policy: {
        allow: [{ id: 'GHSA-eeee-eeee-eeee', package: 'gone', reason: 'was previously unpatched' }],
      },
    })
    const belowThreshold = runAudit({
      report: { noisy: [advisory('GHSA-ffff-ffff-ffff', 'moderate')] },
      policy: {
        allow: [{ id: 'GHSA-ffff-ffff-ffff', package: 'noisy', reason: 'does not need an exception' }],
      },
    })

    assert.strictEqual(stale.status, 1)
    assert.match(stale.stderr, /GHSA-eeee-eeee-eeee \(gone\) is no longer reported/)
    assert.strictEqual(belowThreshold.status, 1)
    assert.match(belowThreshold.stderr, /GHSA-ffff-ffff-ffff \(noisy\) is below the high threshold/)
  })

  for (const [label, policy, error] of [
    [
      'a package mismatch',
      { allow: [{ id: 'GHSA-aaaa-aaaa-aaaa', package: 'wrong-package', reason: 'wrong package' }] },
      /GHSA-aaaa-aaaa-aaaa expects package wrong-package, but Bun reported accepted-package/,
    ],
    [
      'an empty reason',
      { allow: [{ id: 'GHSA-aaaa-aaaa-aaaa', package: 'accepted-package', reason: ' ' }] },
      /GHSA-aaaa-aaaa-aaaa .* needs a reason/,
    ],
    [
      'a duplicate id',
      {
        allow: [
          { id: 'GHSA-aaaa-aaaa-aaaa', package: 'accepted-package', reason: 'first' },
          { id: 'GHSA-aaaa-aaaa-aaaa', package: 'accepted-package', reason: 'second' },
        ],
      },
      /Duplicate exception GHSA-aaaa-aaaa-aaaa/,
    ],
  ]) {
    it(`rejects ${label}`, () => {
      const result = runAudit({
        report: { 'accepted-package': [advisory('GHSA-aaaa-aaaa-aaaa', 'high')] },
        policy,
      })

      assert.strictEqual(result.status, 1)
      assert.match(result.stderr, error)
    })
  }

  it('fails on an advisory severity it cannot rank', () => {
    const result = runAudit({
      report: { 'some-package': [advisory('GHSA-gggg-gggg-gggg', 'medium')] },
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /GHSA-gggg-gggg-gggg .* unknown severity 'medium'/)
  })

  it('fails on invalid invocation and command failures', () => {
    const noDirectory = runAudit({ report: {}, omitDirectory: true })
    const missingDirectory = runAudit({ report: {}, directory: 'missing', createDirectory: false })
    const signaled = runAudit({ report: {}, bunSignal: 'TERM' })
    const unknownLevel = runAudit({ report: {}, policy: { level: 'medium' } })

    assert.strictEqual(noDirectory.status, 1)
    assert.match(noDirectory.stderr, /Pass at least one directory/)
    assert.strictEqual(missingDirectory.status, 1)
    assert.match(missingDirectory.stderr, /ENOENT/)
    assert.strictEqual(signaled.status, 1)
    assert.match(signaled.stderr, /exited on SIGTERM/)
    assert.strictEqual(unknownLevel.status, 1)
    assert.match(unknownLevel.stderr, /Unknown level 'medium'/)
  })

  it('fails when Bun does not produce a complete advisory report', () => {
    const noOutput = runAudit({ report: {}, bunOutput: '' })
    const invalidJson = runAudit({ report: {}, bunOutput: 'not json' })
    const noUrl = runAudit({ report: { 'some-package': [{ severity: 'high', title: 'missing URL' }] } })
    const failed = runAudit({ report: {}, bunStatus: 1 })

    assert.strictEqual(noOutput.status, 1)
    assert.match(noOutput.stderr, /produced no output/)
    assert.strictEqual(invalidJson.status, 1)
    assert.match(invalidJson.stderr, /Could not parse/)
    assert.strictEqual(noUrl.status, 1)
    assert.match(noUrl.stderr, /has no URL/)
    assert.strictEqual(failed.status, 1)
    assert.match(failed.stderr, /failed without reporting an advisory/)
  })

  /**
   * @param {object} options
   * @param {Record<string, object|object[]>} options.report
   * @param {{ level?: string, allow?: Array<{ id: string, package: string, reason: string }> }} [options.policy]
   * @param {string} [options.bunOutput]
   * @param {number} [options.bunStatus]
   * @param {string} [options.bunSignal]
   * @param {string} [options.directory]
   * @param {boolean} [options.createDirectory]
   * @param {boolean} [options.omitDirectory]
   * @returns {import('node:child_process').SpawnSyncReturns<string>}
   */
  function runAudit ({
    report,
    policy,
    bunOutput,
    bunStatus = 0,
    bunSignal,
    directory = 'audited',
    createDirectory = true,
    omitDirectory = false,
  }) {
    const allowlistPath = path.join(fixtureDirectory, 'audit-allowlist.json')
    fs.writeFileSync(allowlistPath, JSON.stringify(policy ? { [directory]: policy } : {}))
    if (createDirectory) fs.mkdirSync(path.join(fixtureDirectory, directory), { recursive: true })

    const stubDirectory = path.join(fixtureDirectory, 'bin')
    fs.mkdirSync(stubDirectory, { recursive: true })
    const stub = path.join(stubDirectory, 'bun')
    fs.writeFileSync(stub, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      `  echo ${bunVersion}`,
      '  exit 0',
      'fi',
      ...(bunSignal ? [`kill -${bunSignal} $$`] : []),
      "cat <<'REPORT'",
      bunOutput ?? JSON.stringify(report),
      'REPORT',
      `exit ${bunStatus}`,
    ].join('\n'))
    fs.chmodSync(stub, 0o755)

    const arguments_ = [auditScript, '--allowlist', allowlistPath]
    if (!omitDirectory) arguments_.push(directory)
    return spawnSync(process.execPath, arguments_, {
      cwd: fixtureDirectory,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${stubDirectory}:${process.env.PATH}` },
    })
  }
})
