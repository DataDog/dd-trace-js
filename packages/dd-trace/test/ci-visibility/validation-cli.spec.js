'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const {
  filterFrameworks,
  normalizeFrameworkTarget,
  parseArgs,
} = require('../../../../ci/test-optimization-validation/cli')
const {
  createRepositoryFixture,
  removeFixture,
} = require('./validation-test-helpers')

const PACKAGE_ROOT = path.resolve(__dirname, '../../../..')
const VALIDATOR = path.join(PACKAGE_ROOT, 'ci', 'validate-test-optimization.js')

describe('test optimization validation CLI', () => {
  it('uses only published files and runtime dependencies', () => {
    const packageJson = require(path.join(PACKAGE_ROOT, 'package.json'))
    const runtimePackages = new Set([
      packageJson.name,
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.optionalDependencies || {}),
    ])
    const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')))
    const sourceFiles = [
      path.join(PACKAGE_ROOT, 'ci', 'diagnose.js'),
      path.join(PACKAGE_ROOT, 'ci', 'init.js'),
      path.join(PACKAGE_ROOT, 'ci', 'validate-test-optimization.js'),
      path.join(PACKAGE_ROOT, 'register.js'),
      ...listJavaScriptFiles(path.join(PACKAGE_ROOT, 'ci', 'test-optimization-validation')),
    ]
    const failures = []

    for (const sourceFile of sourceFiles) {
      const source = fs.readFileSync(sourceFile, 'utf8')
      for (const match of source.matchAll(/\brequire(?:\.resolve)?\(\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1]
        if (specifier.startsWith('.')) {
          try {
            const resolved = require.resolve(path.resolve(path.dirname(sourceFile), specifier))
            const relative = path.relative(PACKAGE_ROOT, resolved).split(path.sep).join('/')
            if (!isPublishedValidationPath(relative)) failures.push(`${sourceFile} -> ${relative}`)
          } catch {
            failures.push(`${sourceFile} -> ${specifier} (missing)`)
          }
        } else if (!builtins.has(specifier.replace(/^node:/, '')) &&
          !runtimePackages.has(getPackageName(specifier))) {
          failures.push(`${sourceFile} -> ${specifier} (development dependency)`)
        }
      }
    }

    assert.deepStrictEqual(failures, [])
  })

  it('normalizes selection and makes Basic Reporting a prerequisite for advanced checks', () => {
    assert.strictEqual(normalizeFrameworkTarget(' vitest:root: '), 'vitest:root')
    assert.deepStrictEqual([...parseArgs(['--scenario', 'efd']).scenarios], ['basic-reporting', 'efd'])
    assert.deepStrictEqual([...parseArgs(['--scenario', 'ci-wiring']).scenarios], ['ci-wiring'])
    assert.throws(() => parseArgs(['--scenario', 'unknown']), /Unknown scenario/)
    assert.throws(() => parseArgs(['--unknown']), /Unknown argument/)
  })

  it('selects frameworks by exact id or framework kind', () => {
    const frameworks = [
      { id: 'vitest:root', framework: 'vitest' },
      { id: 'mocha:root', framework: 'mocha' },
      { id: 'vitest:workspace', framework: 'vitest' },
    ]

    assert.deepStrictEqual(filterFrameworks(frameworks, new Set(['mocha:root'])), [frameworks[1]])
    assert.deepStrictEqual(filterFrameworks(frameworks, new Set(['vitest'])), [frameworks[0], frameworks[2]])
    assert.throws(() => filterFrameworks(frameworks, new Set(['jest'])), /No framework matched/)
  })

  it('initializes, validates, and prints one complete approval plan without executing project code', function () {
    this.timeout(20_000)
    const fixture = createRepositoryFixture({ framework: 'mocha' })
    const marker = path.join(fixture.root, 'should-not-run')
    fs.writeFileSync(
      fixture.runner,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'runner executed')\n`
    )
    const packageJsonPath = path.join(fixture.root, 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath))
    packageJson.scripts.test =
      `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'script executed')"`
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson)}\n`)

    try {
      const initialized = runCli(fixture.root, ['--init-manifest', '--framework', 'mocha'])
      assert.strictEqual(initialized.status, 0, initialized.stderr)
      assert.match(initialized.stdout, /Created a data-only validation manifest/)
      assert.match(initialized.stdout, /No project code ran/)

      const manifestPath = path.join(fixture.root, 'dd-test-optimization-validation-manifest.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath))
      assert.strictEqual(manifest.schemaVersion, '2.0')
      assert.strictEqual(JSON.stringify(manifest).includes('"argv"'), false)
      assert.strictEqual(fs.existsSync(marker), false)

      const validated = runCli(fixture.root, ['--validate-manifest'])
      assert.strictEqual(validated.status, 0, validated.stderr)
      assert.match(validated.stdout, /manifest is valid/)

      const planned = runCli(fixture.root, ['--print-plan'])
      assert.strictEqual(planned.status, 0, planned.stderr)
      assert.match(planned.stdout, /===== CUSTOMER APPROVAL PLAN =====/)
      assert.match(planned.stdout, /only the displayed `node <repository-contained-runner> <one-test-file>`/)
      assert.match(planned.stdout, /eligible for approved clean preflight; runtime prerequisites are unverified/)
      assert.match(planned.stdout, /Approve executing exactly the plan above\?/)
      assert.match(
        planned.stdout,
        /--run-approved-plan (?:"[^"\r\n]*approval\.json"|\S*approval\.json) --sha256 [a-f0-9]{64}/
      )
      assert.strictEqual((planned.stdout.match(/CUSTOMER APPROVAL PLAN/g) || []).length, 2)
      assert.strictEqual(fs.existsSync(marker), false)
      assert.ok(fs.existsSync(path.join(
        fixture.root,
        'dd-test-optimization-validation-results',
        'execution-plan.md'
      )))
    } finally {
      fs.rmSync(marker, { force: true })
      removeFixture(fixture.root)
    }
  })

  it('prints a usable plan when a runner disappears after manifest creation', function () {
    this.timeout(20_000)
    const fixture = createRepositoryFixture({ framework: 'mocha' })
    try {
      assert.strictEqual(runCli(fixture.root, ['--init-manifest']).status, 0)
      fs.rmSync(fixture.runner)
      const planned = runCli(fixture.root, ['--print-plan'])

      assert.strictEqual(planned.status, 0, planned.stderr)
      assert.match(planned.stdout, /local validation will be incomplete/)
      assert.match(planned.stdout, /Run exactly this command after approval/)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('prints a CI-only plan with no approved project command', function () {
    this.timeout(20_000)
    const fixture = createRepositoryFixture({ framework: 'mocha' })
    try {
      assert.strictEqual(runCli(fixture.root, ['--init-manifest']).status, 0)
      const planned = runCli(fixture.root, ['--print-plan', '--scenario', 'ci-wiring'])
      const approval = JSON.parse(fs.readFileSync(path.join(
        fixture.root,
        'dd-test-optimization-validation-results',
        'approval.json'
      )))

      assert.strictEqual(planned.status, 0, planned.stderr)
      assert.match(planned.stdout, /static CI audit only; no project test command is selected/)
      assert.doesNotMatch(planned.stdout, /Basic Reporting command/)
      assert.deepStrictEqual(approval.commands, [])
      assert.deepStrictEqual(approval.executables, [])
      assert.deepStrictEqual(approval.generatedFiles, [])
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('does not evaluate local runner availability during a CI-only run', function () {
    this.timeout(20_000)
    const fixture = createRepositoryFixture({ framework: 'mocha' })
    try {
      assert.strictEqual(runCli(fixture.root, ['--init-manifest']).status, 0)
      fs.rmSync(fixture.runner)
      const planned = runCli(fixture.root, ['--print-plan', '--scenario', 'ci-wiring'])
      assert.strictEqual(planned.status, 0, planned.stderr)

      const out = path.join(fixture.root, 'dd-test-optimization-validation-results')
      const approvalPath = path.join(out, 'approval.json')
      const approval = fs.readFileSync(approvalPath)
      const digest = require('node:crypto').createHash('sha256').update(approval).digest('hex')
      const executed = runCli(fixture.root, [
        '--run-approved-plan', approvalPath,
        '--sha256', digest,
      ])
      const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8')

      assert.strictEqual(executed.status, 2, executed.stderr)
      assert.doesNotMatch(report, /direct runner is unavailable|runner-unavailable/)
      assert.match(report, /CI audit is incomplete/)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('reports missing CI evidence as incomplete instead of an orchestration failure', function () {
    this.timeout(20_000)
    const fixture = createRepositoryFixture({ framework: 'mocha' })
    try {
      assert.strictEqual(runCli(fixture.root, ['--init-manifest']).status, 0)
      const manifestPath = path.join(fixture.root, 'dd-test-optimization-validation-manifest.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath))
      delete manifest.frameworks[0].ciWiring
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      const planned = runCli(fixture.root, ['--print-plan', '--scenario', 'ci-wiring'])
      assert.strictEqual(planned.status, 0, planned.stderr)

      const out = path.join(fixture.root, 'dd-test-optimization-validation-results')
      const approvalPath = path.join(out, 'approval.json')
      const approval = fs.readFileSync(approvalPath)
      const digest = require('node:crypto').createHash('sha256').update(approval).digest('hex')
      const executed = runCli(fixture.root, [
        '--run-approved-plan', approvalPath,
        '--sha256', digest,
      ])
      const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8')

      assert.strictEqual(executed.status, 2, executed.stderr)
      assert.match(report, /CI audit is incomplete because it is missing CI file, job, exact command/)
      assert.doesNotMatch(report, /validator orchestration error/)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('requires the checksum-bound approval command for live validation', () => {
    const fixture = createRepositoryFixture({ framework: 'mocha' })
    try {
      assert.strictEqual(runCli(fixture.root, ['--init-manifest']).status, 0)
      const attempted = runCli(fixture.root, [])

      assert.strictEqual(attempted.status, 3)
      assert.match(attempted.stderr, /requires the checksum-bound command/)
    } finally {
      removeFixture(fixture.root)
    }
  })
})

/**
 * Runs the packaged validator in a fixture repository.
 *
 * @param {string} cwd fixture root
 * @param {string[]} args CLI arguments
 * @returns {import('node:child_process').SpawnSyncReturns<string>} process result
 */
function runCli (cwd, args) {
  return spawnSync(process.execPath, [VALIDATOR, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 20_000,
  })
}

/**
 * Lists JavaScript files below a directory.
 *
 * @param {string} directory directory
 * @returns {string[]} files
 */
function listJavaScriptFiles (directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) return listJavaScriptFiles(filename)
    return entry.isFile() && entry.name.endsWith('.js') ? [filename] : []
  })
}

/**
 * Returns a package name from a module specifier.
 *
 * @param {string} specifier module specifier
 * @returns {string} package name
 */
function getPackageName (specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * Checks whether a relative file is shipped in the package.
 *
 * @param {string} filename package-relative file
 * @returns {boolean} whether published
 */
function isPublishedValidationPath (filename) {
  return filename === 'package.json' ||
    filename === 'loader-hook.mjs' ||
    filename === 'register.js' ||
    filename === 'version.js' ||
    filename.startsWith('ci/') ||
    filename.startsWith('ext/') ||
    filename.startsWith('packages/dd-trace/') ||
    filename.startsWith('vendor/dist/')
}
