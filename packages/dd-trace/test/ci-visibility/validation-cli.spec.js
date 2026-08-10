'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const {
  filterFrameworks,
  normalizeFrameworkTarget,
  parseArgs,
} = require('../../../../ci/test-optimization-validation/cli')
const {
  EXECUTION_LOCK_FILENAME,
} = require('../../../../ci/test-optimization-validation/execution-lock')
const { createManifestScaffold } = require('../../../../ci/test-optimization-validation/manifest-scaffold')
const { DD_MAJOR } = require('../../../../version')
const {
  createRepositoryFixture,
  removeFixture,
  withRepositoryFixture,
} = require('./validation-test-helpers')

const PACKAGE_ROOT = path.resolve(__dirname, '../../../..')
const VALIDATOR = path.join(PACKAGE_ROOT, 'ci', 'validate-test-optimization.js')
const CYPRESS_UNSUPPORTED_VERSION = DD_MAJOR >= 6 ? '11.2.0' : '6.6.0'

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
    const fallbackRelativePath = path.join('test', 'fallback.spec.js')
    const fallback = path.join(fixture.root, fallbackRelativePath)
    fs.writeFileSync(
      fixture.runner,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'runner executed')\n`
    )
    fs.writeFileSync(fallback, [
      "require('supertest')",
      "require('../dist/app')",
      "describe('fallback', () => { it('works', () => {}) })",
      '',
    ].join('\n'))
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
      assert.match(planned.stdout, /## Approval Summary/)
      assert.match(planned.stdout, /Required host capabilities: localhost socket/)
      assert.match(planned.stdout, /only the displayed `node <repository-contained-runner> <one-test-file>`/)
      assert.match(planned.stdout, /Installed package check: The installed dd-trace package loaded/)
      assert.match(planned.stdout, /CI pre-approval result: incomplete:/)
      assert.match(planned.stdout, /eligible for approved clean preflight; runtime prerequisites are unverified/)
      assert.match(planned.stdout, /Fallback tests, tried in order only if the representative does not pass cleanly/)
      assert.ok(planned.stdout.includes(fallbackRelativePath))
      assert.match(planned.stdout, /Fallback Basic Reporting command 1:[\s\S]*fallback\.spec\.js/)
      assert.ok(planned.stdout.includes(`\`${fallbackRelativePath}\` (localhost, build output required)`))
      assert.match(planned.stdout, /Advanced execution policy: each generated scenario has one clean verification/)
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
      const approval = JSON.parse(fs.readFileSync(path.join(
        fixture.root,
        'dd-test-optimization-validation-results',
        'approval.json'
      )))
      assert.ok(approval.commands.some(command => {
        return command.id.endsWith('basic-reporting:fallback-1') && command.argv.includes(fallback)
      }))
    } finally {
      fs.rmSync(marker, { force: true })
      removeFixture(fixture.root)
    }
  })

  it('writes a final static-only report without approval when no framework can run', function () {
    this.timeout(20_000)
    withRepositoryFixture({ framework: 'cypress' }, fixture => {
      const packageJsonPath = path.join(fixture.root, 'package.json')
      const installedPackageJsonPath = path.join(fixture.root, 'node_modules', 'cypress', 'package.json')
      for (const filename of [packageJsonPath, installedPackageJsonPath]) {
        const packageJson = JSON.parse(fs.readFileSync(filename))
        if (filename === packageJsonPath) packageJson.devDependencies.cypress = CYPRESS_UNSUPPORTED_VERSION
        else packageJson.version = CYPRESS_UNSUPPORTED_VERSION
        fs.writeFileSync(filename, `${JSON.stringify(packageJson)}\n`)
      }
      assert.strictEqual(runCli(fixture.root, ['--init-manifest', '--framework', 'cypress']).status, 0)
      const out = path.join(fixture.root, 'dd-test-optimization-validation-results')
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(path.join(out, 'execution-plan.md'), 'obsolete approved command\n')
      const planned = runCli(fixture.root, ['--print-plan'])
      const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8')

      assert.strictEqual(planned.status, 2, planned.stderr)
      assert.match(planned.stdout, /final static-only report was written/)
      assert.doesNotMatch(planned.stdout, /CUSTOMER APPROVAL PLAN/)
      assert.strictEqual(fs.existsSync(path.join(out, 'approval.json')), false)
      assert.match(report, /UNSUPPORTED VERSION/)
      assert.match(report, /\*\*Report state: FINAL\*\*/)
      assert.doesNotMatch(report, /Approved execution plan/)
      assert.strictEqual(fs.existsSync(path.join(out, EXECUTION_LOCK_FILENAME)), false)
    })
  })

  it('reuses a valid existing manifest without overwriting it', function () {
    this.timeout(20_000)
    withRepositoryFixture({ framework: 'mocha' }, fixture => {
      const manifestPath = path.join(fixture.root, 'dd-test-optimization-validation-manifest.json')
      assert.strictEqual(runCli(fixture.root, ['--init-manifest']).status, 0)
      const original = fs.readFileSync(manifestPath)

      const repeated = runCli(fixture.root, ['--init-manifest'])

      assert.strictEqual(repeated.status, 0, repeated.stderr)
      assert.match(repeated.stdout, /Existing validation manifest is valid for this repository/)
      assert.match(repeated.stdout, /refresh only its ciWiring evidence if needed/)
      assert.deepStrictEqual(fs.readFileSync(manifestPath), original)
    })
  })

  it('refuses to replace an invalid existing manifest and names only that recovery path', () => {
    withRepositoryFixture({ framework: 'mocha' }, fixture => {
      const manifestPath = path.join(fixture.root, 'dd-test-optimization-validation-manifest.json')
      fs.writeFileSync(manifestPath, '{ invalid json\n')
      const repeated = runCli(fixture.root, ['--init-manifest'])

      assert.strictEqual(repeated.status, 2)
      assert.match(repeated.stderr, /existing validation manifest cannot be reused/i)
      assert.ok(repeated.stderr.includes(`remove only ${manifestPath}`))
      assert.match(repeated.stderr, /did not delete or replace it/)
      assert.strictEqual(fs.readFileSync(manifestPath, 'utf8'), '{ invalid json\n')
    })
  })

  it('shows structurally invalid CI evidence as incomplete before approval', function () {
    this.timeout(20_000)
    const ciSource = [
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: acme/remote-test-action@v1',
      '',
    ].join('\n')
    withRepositoryFixture({ framework: 'mocha', ciSource }, fixture => {
      assert.strictEqual(runCli(fixture.root, ['--init-manifest']).status, 0)
      const manifestPath = path.join(fixture.root, 'dd-test-optimization-validation-manifest.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath))
      manifest.frameworks[0].ciWiring = {
        command: 'node ./node_modules/mocha/bin/mocha.js test/example.spec.js',
        configFile: path.join(fixture.root, '.github', 'workflows', 'test.yml'),
        initialization: { evidence: ['No initialization is visible.'], status: 'not_configured' },
        job: 'test',
        reviewComplete: true,
        step: 'uses: acme/remote-test-action@v1',
        transport: { evidence: ['No transport is visible.'], mode: 'none' },
        unresolved: [],
        workingDirectory: fixture.root,
      }
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      const planned = runCli(fixture.root, ['--print-plan'])

      assert.strictEqual(planned.status, 0, planned.stderr)
      assert.match(
        planned.stdout,
        /CI pre-approval result: incomplete: The recorded command and step could not be bound structurally/
      )
      assert.match(planned.stdout, /Approve executing exactly the plan above/)
    })
  })

  it('refuses to replace an existing execution lock while printing a plan', function () {
    this.timeout(20_000)
    withRepositoryFixture({ framework: 'mocha' }, fixture => {
      const out = path.join(fixture.root, 'dd-test-optimization-validation-results')
      const lockPath = path.join(out, EXECUTION_LOCK_FILENAME)
      assert.strictEqual(runCli(fixture.root, ['--init-manifest']).status, 0)
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(lockPath, 'existing lock\n')

      const planned = runCli(fixture.root, ['--print-plan'])

      assert.strictEqual(planned.status, 2)
      assert.ok(planned.stderr.includes(lockPath))
      assert.match(planned.stderr, /confirming no validation process is active/)
      assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), 'existing lock\n')
      assert.strictEqual(fs.existsSync(path.join(out, 'approval.json')), false)
    })
  })

  it('holds the execution lock through runnable plan preflight and publication', async () => {
    const fixture = createRepositoryFixture({ framework: 'mocha' })
    const calls = []
    const consoleLog = sinon.stub(console, 'log')
    const out = path.join(fixture.root, 'dd-test-optimization-validation-results')
    const manifest = {
      __path: path.join(fixture.root, 'dd-test-optimization-validation-manifest.json'),
      frameworks: [{ id: 'mocha:fixture', status: 'runnable' }],
      repository: { root: fixture.root },
    }
    const isolatedCli = proxyquire('../../../../ci/test-optimization-validation/cli', {
      './execution-lock': {
        acquireExecutionLock () {
          calls.push('acquire')
          return { path: path.join(out, EXECUTION_LOCK_FILENAME) }
        },
        releaseExecutionLock () {
          calls.push('release')
        },
      },
      './manifest-loader': { loadManifest: () => manifest },
      './package-check': {
        checkInstalledPackage () {
          calls.push('package-check')
          return { diagnosis: 'ok', ok: true }
        },
      },
      './plan-writer': {
        formatExecutionPlanArtifacts (input) {
          calls.push('publish')
          assert.deepStrictEqual(input.expectedProjectFiles, [])
          return { plan: 'approval plan' }
        },
        getExecutionPlanPath: () => path.join(out, 'execution-plan.md'),
      },
      './safe-files': {
        ensureSafeDirectory () {
          calls.push('ensure-directory')
        },
      },
      './scenarios/ci-wiring': {
        runCiWiring ({ projectFileSources }) {
          calls.push('ci-preflight')
          assert.deepStrictEqual([...projectFileSources], [])
          return { status: 'error' }
        },
      },
    })
    try {
      await isolatedCli.main(['--print-plan', '--manifest', manifest.__path, '--out', out])

      assert.deepStrictEqual(calls, [
        'ensure-directory',
        'acquire',
        'package-check',
        'ci-preflight',
        'publish',
        'release',
      ])
    } finally {
      consoleLog.restore()
      removeFixture(fixture.root)
    }
  })

  it('preserves a non-runnable framework blocker when the installed package check fails', async () => {
    const fixture = createRepositoryFixture({ framework: 'cypress' })
    const out = path.join(fixture.root, 'dd-test-optimization-validation-results')
    const manifest = {
      __path: path.join(fixture.root, 'dd-test-optimization-validation-manifest.json'),
      frameworks: [{
        blockerCategory: 'UNSUPPORTED_VERSION',
        framework: 'cypress',
        id: 'cypress:fixture',
        notes: ['The installed Cypress version is unsupported.'],
        status: 'unsupported_by_validator',
      }],
      repository: { root: fixture.root },
    }
    let reportInput
    const originalExitCode = process.exitCode
    const consoleLog = sinon.stub(console, 'log')
    const isolatedCli = proxyquire('../../../../ci/test-optimization-validation/cli', {
      './approval': { assertApprovalDigest () {} },
      './approval-artifacts': {
        loadApprovedPlan: () => ({
          material: {
            manifest: { path: manifest.__path },
            selection: { frameworks: [], scenario: 'basic-reporting' },
            validation: {
              keepTemporaryFiles: false,
              offlineFixtureNonce: 'fixture-nonce',
              outputDirectory: out,
              verbose: false,
            },
          },
        }),
      },
      './ci-discovery': { annotateCiDiscovery () {} },
      './execution-lock': {
        acquireExecutionLock: () => ({ path: path.join(out, EXECUTION_LOCK_FILENAME) }),
        releaseExecutionLock () {},
      },
      './generated-files': {
        cleanupGeneratedFiles: async () => ({ directoriesRemoved: 0, filesRemoved: 0, status: 'completed' }),
      },
      './manifest-loader': { loadManifest: () => manifest },
      './package-check': {
        checkInstalledPackage: () => ({
          diagnosis: 'The installed package did not load.',
          ok: false,
          recommendation: 'Reinstall the package.',
        }),
      },
      './report-writer': {
        writePendingReport () {},
        async writeReport (input) { reportInput = input },
      },
      './safe-files': { ensureSafeDirectory () {} },
      './static-diagnosis': {
        getStaticBlocker: () => undefined,
        runStaticDiagnosis: () => ({ report: {}, reportPath: path.join(out, 'diagnosis.json') }),
      },
    })
    try {
      await isolatedCli.main([
        '--run-approved-plan', path.join(out, 'approval.json'),
        '--sha256', 'a'.repeat(64),
      ])

      const frameworkStatus = reportInput.results.find(result => result.scenario === 'all')
      const basicReporting = reportInput.results.find(result => result.scenario === 'basic-reporting')
      assert.strictEqual(frameworkStatus.evidence.frameworkStatus, 'unsupported_by_validator')
      assert.strictEqual(frameworkStatus.evidence.blockerCategory, 'UNSUPPORTED_VERSION')
      assert.strictEqual(basicReporting.evidence.blockerCategory, 'UNSUPPORTED_VERSION')
      assert.strictEqual(reportInput.results.some(result => result.evidence.installedPackageIncomplete), false)
    } finally {
      process.exitCode = originalExitCode
      consoleLog.restore()
      removeFixture(fixture.root)
    }
  })

  it('preserves project setup when an approved direct runner becomes unavailable', async () => {
    const fixture = createRepositoryFixture({ framework: 'mocha' })
    const out = path.join(fixture.root, 'dd-test-optimization-validation-results')
    const manifest = createManifestScaffold({ root: fixture.root, frameworks: new Set(['mocha']) })
    Object.defineProperty(manifest, '__path', {
      value: path.join(fixture.root, 'dd-test-optimization-validation-manifest.json'),
    })
    let reportInput
    const originalExitCode = process.exitCode
    const consoleLog = sinon.stub(console, 'log')
    const isolatedCli = proxyquire('../../../../ci/test-optimization-validation/cli', {
      './approval': { assertApprovalDigest () {} },
      './approval-artifacts': {
        loadApprovedPlan: () => ({
          material: {
            manifest: { path: manifest.__path },
            selection: { frameworks: [], scenario: 'efd' },
            validation: {
              keepTemporaryFiles: false,
              offlineFixtureNonce: 'fixture-nonce',
              outputDirectory: out,
              verbose: false,
            },
          },
        }),
      },
      './ci-discovery': { annotateCiDiscovery () {} },
      './executable': { getUnavailableExecutable: () => fixture.runner },
      './execution-lock': {
        acquireExecutionLock: () => ({ path: path.join(out, EXECUTION_LOCK_FILENAME) }),
        releaseExecutionLock () {},
      },
      './generated-files': {
        cleanupGeneratedFiles: async () => ({ directoriesRemoved: 0, filesRemoved: 0, status: 'completed' }),
      },
      './manifest-loader': { loadManifest: () => manifest },
      './package-check': { checkInstalledPackage: () => ({ ok: true }) },
      './report-writer': {
        writePendingReport () {},
        async writeReport (input) { reportInput = input },
      },
      './safe-files': { ensureSafeDirectory () {} },
      './static-diagnosis': {
        getStaticBlocker: () => undefined,
        runStaticDiagnosis: () => ({ report: {}, reportPath: path.join(out, 'diagnosis.json') }),
      },
    })
    try {
      await isolatedCli.main([
        '--run-approved-plan', path.join(out, 'approval.json'),
        '--sha256', 'a'.repeat(64),
      ])

      const notReached = reportInput.results.filter(result => {
        return result.frameworkId === manifest.frameworks[0].id && ['basic-reporting', 'efd'].includes(result.scenario)
      })
      assert.deepStrictEqual(notReached.map(result => result.evidence.blockerCategory), [
        'PROJECT_SETUP_REQUIRED',
        'PROJECT_SETUP_REQUIRED',
      ])
    } finally {
      process.exitCode = originalExitCode
      consoleLog.restore()
      removeFixture(fixture.root)
    }
  })

  it('does not publish an approval failure without owning the execution lock', function () {
    this.timeout(20_000)
    withRepositoryFixture({ framework: 'mocha' }, fixture => {
      const out = path.join(fixture.root, 'dd-test-optimization-validation-results')
      const lockPath = path.join(out, EXECUTION_LOCK_FILENAME)
      const reportPath = path.join(out, 'report.md')
      const pendingReport = 'active validation pending\n'
      assert.strictEqual(runCli(fixture.root, ['--init-manifest']).status, 0)
      assert.strictEqual(runCli(fixture.root, ['--print-plan', '--scenario', 'basic-reporting']).status, 0)
      const approvalPath = path.join(out, 'approval.json')
      const approval = fs.readFileSync(approvalPath)
      const digest = require('node:crypto').createHash('sha256').update(approval).digest('hex')
      fs.writeFileSync(lockPath, 'active validation lock\n')
      fs.writeFileSync(reportPath, pendingReport)
      fs.appendFileSync(path.join(fixture.root, 'dd-test-optimization-validation-manifest.json'), '\n')

      const executed = runCli(fixture.root, [
        '--run-approved-plan', approvalPath,
        '--sha256', digest,
      ])

      assert.strictEqual(executed.status, 3)
      assert.match(executed.stderr, /changed after approval/)
      assert.strictEqual(fs.readFileSync(reportPath, 'utf8'), pendingReport)
      assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), 'active validation lock\n')
    })
  })

  it('reports a lock-release failure instead of finalizing the earlier result', function () {
    this.timeout(20_000)
    const out = 'dd-test-optimization-validation-results'
    const lockPath = path.join(out, EXECUTION_LOCK_FILENAME)
    const fixture = createRepositoryFixture({
      framework: 'mocha',
      runnerSource: [
        "const fs = require('node:fs')",
        "const path = require('node:path')",
        `const lockPath = path.join(process.cwd(), ${JSON.stringify(lockPath)})`,
        'try {',
        '  if (fs.lstatSync(lockPath).isFile()) {',
        '    fs.unlinkSync(lockPath)',
        '    fs.mkdirSync(lockPath)',
        '  }',
        '} catch {}',
        "console.log('1 passing')",
        '',
      ].join('\n'),
    })
    try {
      assert.strictEqual(runCli(fixture.root, ['--init-manifest']).status, 0)
      assert.strictEqual(runCli(fixture.root, ['--print-plan', '--scenario', 'basic-reporting']).status, 0)
      const outputDirectory = path.join(fixture.root, out)
      const approvalPath = path.join(outputDirectory, 'approval.json')
      const approval = fs.readFileSync(approvalPath)
      const digest = require('node:crypto').createHash('sha256').update(approval).digest('hex')

      const executed = runCli(fixture.root, [
        '--run-approved-plan', approvalPath,
        '--sha256', digest,
      ])
      const report = fs.readFileSync(path.join(outputDirectory, 'report.md'), 'utf8')

      assert.strictEqual(executed.status, 3)
      assert.match(executed.stderr, /changed validation execution lock/)
      assert.match(report, /changed validation execution lock/)
      assert.match(report, /Validator exit code: 3/)
      assert.strictEqual(fs.statSync(path.join(fixture.root, lockPath)).isDirectory(), true)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('describes an omitted Mocha reporter without calling it Vitest typechecking', function () {
    this.timeout(20_000)
    withRepositoryFixture({ framework: 'mocha', script: 'mocha --reporter dot' }, fixture => {
      assert.strictEqual(runCli(fixture.root, ['--init-manifest']).status, 0)
      const planned = runCli(fixture.root, ['--print-plan'])

      assert.strictEqual(planned.status, 0, planned.stderr)
      assert.match(planned.stdout, /`--reporter` selects only Mocha report presentation/)
      assert.doesNotMatch(planned.stdout, /`--typecheck` is excluded/)
    })
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

  it('explains the scoped permission needed by browser-backed validation', function () {
    this.timeout(20_000)
    withRepositoryFixture({ framework: 'cypress' }, fixture => {
      assert.strictEqual(runCli(fixture.root, ['--init-manifest']).status, 0)
      const planned = runCli(fixture.root, ['--print-plan'])

      assert.strictEqual(planned.status, 0, planned.stderr)
      assert.match(planned.stdout, /Browser permission: this approved validation command launches the project browser/)
      assert.match(planned.stdout, /request its narrow permission for the exact checksum-bound validator command/)
      assert.match(planned.stdout, /do not change or broaden the command/)
    })
  })

  it('writes a final CI-only report without approval', function () {
    this.timeout(20_000)
    withRepositoryFixture({ framework: 'mocha' }, fixture => {
      assert.strictEqual(runCli(fixture.root, ['--init-manifest']).status, 0)
      const planned = runCli(fixture.root, ['--print-plan', '--scenario', 'ci-wiring'])
      const out = path.join(fixture.root, 'dd-test-optimization-validation-results')
      const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8')

      assert.strictEqual(planned.status, 2, planned.stderr)
      assert.match(planned.stdout, /selected CI-only audit does not require local execution/)
      assert.match(planned.stdout, /final static-only report was written/)
      assert.doesNotMatch(planned.stdout, /CUSTOMER APPROVAL PLAN/)
      assert.strictEqual(fs.existsSync(path.join(out, 'approval.json')), false)
      assert.match(report, /CI audit is incomplete/)
      assert.match(report, /\*\*Report state: FINAL\*\*/)
    })
  })

  it('does not evaluate local runner availability during a CI-only run', function () {
    this.timeout(20_000)
    const fixture = createRepositoryFixture({ framework: 'mocha' })
    try {
      assert.strictEqual(runCli(fixture.root, ['--init-manifest']).status, 0)
      fs.rmSync(fixture.runner)
      const planned = runCli(fixture.root, ['--print-plan', '--scenario', 'ci-wiring'])
      const out = path.join(fixture.root, 'dd-test-optimization-validation-results')
      const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8')

      assert.strictEqual(planned.status, 2, planned.stderr)
      assert.doesNotMatch(report, /direct runner is unavailable|runner-unavailable/)
      assert.match(report, /CI audit is incomplete/)
      assert.match(report, /Cleanup: completed/)
      assert.strictEqual(fs.existsSync(path.join(out, 'approval.json')), false)
      assert.strictEqual(fs.existsSync(path.join(out, EXECUTION_LOCK_FILENAME)), false)
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
      const out = path.join(fixture.root, 'dd-test-optimization-validation-results')
      const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8')

      assert.strictEqual(planned.status, 2, planned.stderr)
      assert.match(report, /No supported CI configuration file was found by bounded repository discovery/)
      assert.doesNotMatch(report, /validator orchestration error/)
      assert.strictEqual(fs.existsSync(path.join(out, 'approval.json')), false)
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
