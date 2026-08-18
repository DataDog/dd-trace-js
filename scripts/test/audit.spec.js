'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const yaml = require('yaml')

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
      allow: [{ id: 'GHSA-aaaa-aaaa-aaaa', package: 'some-package', reason: 'No patched release exists.' }],
      bunStatus: 1,
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('fails on an advisory at the threshold that is not accepted', () => {
    const result = runAudit({
      report: { 'some-package': advisory('GHSA-bbbb-bbbb-bbbb', 'high') },
      allow: [],
      bunStatus: 1,
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /unaccepted high advisory GHSA-bbbb-bbbb-bbbb in some-package/)
  })

  it('fails on a severity it cannot rank', () => {
    const result = runAudit({
      report: { 'some-package': advisory('GHSA-ffff-ffff-ffff', 'medium') },
      allow: [],
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /GHSA-ffff-ffff-ffff .* unknown severity 'medium'/)
  })

  it('ignores an advisory below the directory threshold', () => {
    const result = runAudit({
      report: { 'some-package': advisory('GHSA-cccc-cccc-cccc', 'moderate') },
      allow: [],
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('fails when an accepted advisory is no longer reported', () => {
    const result = runAudit({
      report: {},
      allow: [{ id: 'GHSA-dddd-dddd-dddd', package: 'gone', reason: 'It was not patched.' }],
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /GHSA-dddd-dddd-dddd \(gone\) is no longer reported/)
  })

  it('fails when an acceptance names the wrong package', () => {
    const result = runAudit({
      report: { actual: advisory('GHSA-aaaa-aaaa-aaaa', 'high') },
      allow: [{ id: 'GHSA-aaaa-aaaa-aaaa', package: 'stale', reason: 'It was not patched.' }],
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /names stale, but Bun reports actual/)
  })

  it('fails when one advisory is reported for multiple packages', () => {
    const reported = advisory('GHSA-aaaa-aaaa-aaaa', 'high')
    const result = runAudit({
      report: { first: reported, second: reported },
      allow: [],
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /reported for both first and second/)
  })

  for (const [label, allow, expected] of [
    ['carries no reason', [{ id: 'GHSA-eeee-eeee-eeee', package: 'some-package', reason: '  ' }], /needs a reason/],
    [
      'is duplicated',
      [
        { id: 'GHSA-eeee-eeee-eeee', package: 'some-package', reason: 'First.' },
        { id: 'GHSA-eeee-eeee-eeee', package: 'some-package', reason: 'Second.' },
      ],
      /is duplicated/,
    ],
  ]) {
    it(`fails when an accepted advisory ${label}`, () => {
      const result = runAudit({
        report: { 'some-package': advisory('GHSA-eeee-eeee-eeee', 'high') },
        allow,
      })

      assert.strictEqual(result.status, 1)
      assert.match(result.stderr, expected)
    })
  }

  it('fails when an audited directory has no allowlist entry', () => {
    const result = runAudit({ report: {}, allow: [], directory: 'unlisted' })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /has no entry in/)
  })

  it('audits every configured directory when none is requested', () => {
    const result = runAudit({ report: {}, allow: [], useConfiguredDirectories: true })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.match(result.stdout, /No unaccepted advisories in: audited/)
  })

  it('fails when --allowlist has no path', () => {
    const result = spawnSync(process.execPath, [auditScript, '--allowlist'], {
      cwd: fixtureDirectory,
      encoding: 'utf8',
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /--allowlist needs a path/)
  })

  it('fails when a directory has an unknown threshold', () => {
    const result = runAudit({ report: {}, allow: [], level: 'medium' })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /Unknown level 'medium'/)
  })

  it('keeps path, scheduled, manual, and Dependabot audits on one implementation', () => {
    const auditWorkflow = yaml.parse(fs.readFileSync(path.join(repoRoot, '.github/workflows/audit.yml'), 'utf8'))
    const dependabotWorkflow = yaml.parse(
      fs.readFileSync(path.join(repoRoot, '.github/workflows/dependabot-audit.yml'), 'utf8')
    )
    const auditedPaths = [
      '.github/actions/datadog-ci/bun.lock',
      '.github/actions/datadog-ci/package.json',
      '.github/all-green/bun.lock',
      '.github/all-green/package.json',
      '.github/audit-allowlist.json',
      '.github/workflows/audit.yml',
      '.github/workflows/dependabot-audit.yml',
      'bun.lock',
      'docs/bun.lock',
      'docs/package.json',
      'package.json',
      'scripts/audit.js',
      'scripts/bun.js',
      'vendor/bun.lock',
      'vendor/package.json',
    ]

    assert.strictEqual(Object.hasOwn(auditWorkflow.on, 'workflow_call'), true)
    assert.ok(auditWorkflow.on.schedule)
    assert.strictEqual(Object.hasOwn(auditWorkflow.on, 'workflow_dispatch'), true)
    assert.deepStrictEqual(auditWorkflow.on.pull_request.paths.sort(), auditedPaths.sort())
    assert.deepStrictEqual(dependabotWorkflow.on.pull_request['paths-ignore'].sort(), auditedPaths.sort())
    assert.strictEqual(dependabotWorkflow.jobs['dependabot-audit'].if, "github.actor == 'dependabot[bot]'")
    assert.strictEqual(dependabotWorkflow.jobs['dependabot-audit'].uses, './.github/workflows/audit.yml')

    const expectedDirectories = ['.', '.github/actions/datadog-ci', '.github/all-green', 'docs', 'vendor']
    assert.deepStrictEqual(auditWorkflow.jobs.dependencies.strategy.matrix.directory.sort(), expectedDirectories)
    const allowlist = JSON.parse(
      fs.readFileSync(path.join(repoRoot, '.github/audit-allowlist.json'), 'utf8')
    )
    assert.deepStrictEqual(Object.keys(allowlist.directories).sort(), expectedDirectories)
  })

  for (const [label, options, expected] of [
    ['produces no output', { bunOutput: '' }, /produced no output/],
    ['produces invalid JSON', { bunOutput: '{' }, /Could not parse/],
    ['produces an invalid report', { bunOutput: '[]' }, /invalid report/],
    ['reports an advisory without a URL', { report: { package: { severity: 'high' } } }, /has no URL/],
    ['fails without advisories', { report: {}, bunStatus: 2 }, /`bun audit` failed/],
  ]) {
    it(`fails when Bun ${label}`, () => {
      const result = runAudit({ report: {}, allow: [], ...options })

      assert.strictEqual(result.status, 1)
      assert.match(result.stderr, expected)
    })
  }

  /**
   * @param {{
   *   report: Record<string, unknown>,
   *   allow: Array<{ id: string, package: string, reason: string }>,
   *   directory?: string,
   *   level?: string,
   *   bunOutput?: string,
   *   bunStatus?: number,
   *   useConfiguredDirectories?: boolean
   * }} options
   */
  function runAudit ({
    report,
    allow,
    directory = 'audited',
    level = 'high',
    bunOutput,
    bunStatus = 0,
    useConfiguredDirectories = false,
  }) {
    const allowlistPath = path.join(fixtureDirectory, 'audit-allowlist.json')
    fs.writeFileSync(allowlistPath, JSON.stringify({ directories: { audited: { level, allow } } }))
    fs.mkdirSync(path.join(fixtureDirectory, 'audited'), { recursive: true })

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
      `exit ${bunStatus}`,
    ].join('\n'))
    fs.chmodSync(stub, 0o755)

    const arguments_ = [auditScript, '--allowlist', allowlistPath]
    if (!useConfiguredDirectories) arguments_.push(directory)
    return spawnSync(process.execPath, arguments_, {
      cwd: fixtureDirectory,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${stubDirectory}:${process.env.PATH}` },
    })
  }
})
