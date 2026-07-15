'use strict'

/* eslint-disable no-console */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const os = require('node:os')
const path = require('node:path')

const proxyquire = require('proxyquire').noCallThru().noPreserveCache()

const {
  filterFrameworks,
  main: runValidationCli,
  normalizeFrameworkTarget,
  parseArgs,
} = require('../../../../ci/test-optimization-validation/cli')

const PASSING_VALIDATION_PHASES = {
  './approval': {
    assertApprovalDigest () {},
  },
  './generated-verifier': {
    async verifyGeneratedTestStrategy () {
      return { ok: true }
    },
  },
  './preflight-runner': {
    async runFrameworkPreflight ({ framework }) {
      framework.preflight = {
        ran: true,
        source: 'validator',
        exitCode: 0,
        observedTestCount: 1,
      }
      return { ok: true, preflight: framework.preflight }
    },
  },
}
const APPROVAL_ARGS = [
  '--offline-fixture-nonce', 'a'.repeat(32),
  '--approved-plan-sha256', 'a'.repeat(64),
]

describe('test optimization validation cli', () => {
  it('uses only published files and runtime dependencies', () => {
    const packageRoot = path.resolve(__dirname, '../../../..')
    const packageJson = require(path.join(packageRoot, 'package.json'))
    const runtimePackages = new Set([
      packageJson.name,
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ])
    const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')))
    const sourceFiles = [
      path.join(packageRoot, 'ci', 'diagnose.js'),
      path.join(packageRoot, 'ci', 'init.js'),
      path.join(packageRoot, 'ci', 'validate-test-optimization.js'),
      path.join(packageRoot, 'register.js'),
      ...listJavaScriptFiles(path.join(packageRoot, 'ci', 'test-optimization-validation')),
    ]
    const developmentOnlyImports = []
    const unpublishedImports = []
    const requirePattern = /\brequire(?:\.resolve)?\(\s*['"]([^'"]+)['"]/g

    for (const sourceFile of sourceFiles) {
      const source = fs.readFileSync(sourceFile, 'utf8')
      let match

      while ((match = requirePattern.exec(source)) !== null) {
        const specifier = match[1]

        if (specifier.startsWith('.')) {
          let resolved

          try {
            resolved = require.resolve(path.resolve(path.dirname(sourceFile), specifier))
          } catch {
            unpublishedImports.push(`${path.relative(packageRoot, sourceFile)} -> ${specifier} (missing)`)
            continue
          }

          const relativeTarget = path.relative(packageRoot, resolved).split(path.sep).join('/')
          if (!isPublishedValidationPath(relativeTarget)) {
            unpublishedImports.push(`${path.relative(packageRoot, sourceFile)} -> ${relativeTarget}`)
          }
          continue
        }

        const normalizedSpecifier = specifier.replace(/^node:/, '')
        if (builtins.has(normalizedSpecifier)) continue

        const packageName = getPackageName(specifier)
        if (!runtimePackages.has(packageName)) {
          developmentOnlyImports.push(`${path.relative(packageRoot, sourceFile)} -> ${specifier}`)
        }
      }
    }

    assert.deepStrictEqual(developmentOnlyImports, [])
    assert.deepStrictEqual(unpublishedImports, [])
  })

  it('normalizes copied framework targets with a trailing colon', () => {
    assert.strictEqual(normalizeFrameworkTarget(' vitest:root-unit: '), 'vitest:root-unit')

    const options = parseArgs(['--framework', 'vitest:root-unit:'])

    assert.deepStrictEqual([...options.frameworks], ['vitest:root-unit'])
  })

  it('selects entries by exact id or framework kind', () => {
    const frameworks = [
      { id: 'vitest:root-unit', framework: 'vitest' },
      { id: 'mocha:cjs-module', framework: 'mocha' },
      { id: 'vitest:integration', framework: 'vitest' },
    ]

    assert.deepStrictEqual(filterFrameworks(frameworks, new Set(['vitest:root-unit'])), [
      { id: 'vitest:root-unit', framework: 'vitest' },
    ])
    assert.deepStrictEqual(filterFrameworks(frameworks, new Set(['vitest'])), [
      { id: 'vitest:root-unit', framework: 'vitest' },
      { id: 'vitest:integration', framework: 'vitest' },
    ])
  })

  it('adds basic reporting as a prerequisite for advanced scenario selection', () => {
    const options = parseArgs(['--scenario', 'efd'])

    assert.deepStrictEqual([...options.scenarios], ['basic-reporting', 'efd'])
  })

  it('adds basic reporting as a prerequisite for CI wiring scenario selection', () => {
    const options = parseArgs(['--scenario', 'ci-wiring'])

    assert.deepStrictEqual([...options.scenarios], ['basic-reporting', 'ci-wiring'])
  })

  it('parses a plan approval digest for live validation', () => {
    const digest = 'a'.repeat(64)
    const nonce = 'b'.repeat(32)
    const options = parseArgs(['--offline-fixture-nonce', nonce, '--approved-plan-sha256', digest])

    assert.strictEqual(options.approvedPlanSha256, digest)
    assert.strictEqual(options.offlineFixtureNonce, nonce)
  })

  it('parses the read-only approval digest verification mode', () => {
    const options = parseArgs(['--offline-fixture-nonce', 'b'.repeat(32), '--print-approval-sha256'])

    assert.strictEqual(options.printApprovalSha256, true)
  })

  it('explains the approval hash trust boundary in help output', async () => {
    const logs = []
    const originalLog = console.log
    console.log = message => logs.push(message)

    try {
      await runValidationCli(['--help'])

      assert.match(logs.join('\n'), /--print-approval-sha256/)
      assert.match(logs.join('\n'), /does not verify package origin/)
      assert.match(logs.join('\n'), /lockfile\/integrity metadata or a trusted package tarball/)
    } finally {
      console.log = originalLog
    }
  })

  it('initializes a manifest scaffold without starting live validation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-init-manifest-'))
    const originalCwd = process.cwd()
    const logs = []
    const originalLog = console.log
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      './manifest-scaffold': {
        createManifestScaffold ({ root }) {
          return { schemaVersion: '1.0', repository: { root }, environment: {}, frameworks: [] }
        },
      },
    })

    process.chdir(tmpDir)
    console.log = message => logs.push(message)
    try {
      await main(['--init-manifest'])

      const manifest = JSON.parse(fs.readFileSync(path.join(
        tmpDir,
        'dd-test-optimization-validation-manifest.json'
      )))
      assert.strictEqual(manifest.repository.root, fs.realpathSync(tmpDir))
      assert.match(logs.join('\n'), /without running project code/)
      assert.match(logs.join('\n'), /CI files listed in ciDiscovery/)
      assert.strictEqual(fs.existsSync(path.join(tmpDir, 'dd-test-optimization-validation-results')), false)
    } finally {
      console.log = originalLog
      process.chdir(originalCwd)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('validates a manifest without creating output or starting live validation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const out = path.join(tmpDir, 'results')
    const logs = []
    const originalLog = console.log
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
      './static-diagnosis': {
        runStaticDiagnosis () {
          throw new Error('static diagnosis should not run')
        },
      },
    })

    fs.writeFileSync(manifestPath, `${JSON.stringify(getRunnableManifest(tmpDir), null, 2)}\n`)
    console.log = message => logs.push(message)

    try {
      await main(['--manifest', manifestPath, '--out', out, '--validate-manifest'])

      assert.strictEqual(fs.existsSync(out), false)
      assert.deepStrictEqual(logs, [`Validation manifest is valid: ${manifestPath}`])
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('prints the approval digest without creating output or starting live validation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-approval-digest-'))
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const out = path.join(tmpDir, 'results')
    const digest = 'c'.repeat(64)
    const nonce = 'd'.repeat(32)
    const logs = []
    const digestInputs = []
    const originalLog = console.log
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      './approval': {
        assertApprovalDigest () {
          throw new Error('live approval should not run')
        },
        getApprovalDigest (input) {
          digestInputs.push(input)
          return digest
        },
      },
      './static-diagnosis': {
        runStaticDiagnosis () {
          throw new Error('static diagnosis should not run')
        },
      },
    })

    const manifest = getRunnableManifest(tmpDir)
    manifest.frameworks.push({
      ...manifest.frameworks[0],
      id: 'vitest:other',
    })
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log = message => logs.push(message)

    try {
      await main([
        '--manifest', manifestPath,
        '--out', out,
        '--framework', manifest.frameworks[0].id,
        '--offline-fixture-nonce', nonce,
        '--print-approval-sha256',
      ])

      assert.deepStrictEqual(logs, [digest])
      assert.strictEqual(fs.existsSync(out), false)
      assert.strictEqual(digestInputs.length, 1)
      assert.strictEqual(digestInputs[0].offlineFixtureNonce, nonce)
      assert.deepStrictEqual(digestInputs[0].selectedFrameworkIds, [manifest.frameworks[0].id])
      assert.deepStrictEqual(digestInputs[0].manifest.frameworks.map(framework => framework.id), [
        manifest.frameworks[0].id,
      ])
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reproduces the hash from a framework-scoped execution plan', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-reproduce-digest-'))
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const out = path.join(tmpDir, 'results')
    const logs = []
    const originalLog = console.log
    const manifest = getRunnableManifest(tmpDir)
    const junitDirectory = path.resolve(__dirname, '../../../..', '.junit-tmp')
    const junitShard = path.join(junitDirectory, `validation-cli-${process.pid}.xml`)
    manifest.frameworks.push({
      ...manifest.frameworks[0],
      id: 'jest:other',
    })
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log = message => logs.push(message)

    try {
      await runValidationCli([
        '--manifest', manifestPath,
        '--out', out,
        '--framework', manifest.frameworks[0].id,
        '--print-plan',
      ])
      const presentationReminder = logs.pop()
      const executionPlanPath = path.join(out, 'execution-plan.md')
      const approvalSummaryPath = path.join(out, 'approval-summary.md')
      const plan = fs.readFileSync(executionPlanPath, 'utf8')
      const approvalSummary = fs.readFileSync(approvalSummaryPath, 'utf8')
      const nonce = plan.match(/--offline-fixture-nonce ([a-f0-9]{32})/)?.[1]
      const expectedDigest = plan.match(/Expected SHA-256: `([a-f0-9]{64})`/)?.[1]
      const approvalJsonPath = path.join(out, 'approval.json')
      const coveredFilesPath = path.join(out, 'approval-files.sha256')

      assert.strictEqual(fs.existsSync(approvalJsonPath), true)
      assert.strictEqual(fs.existsSync(coveredFilesPath), true)
      assert.match(presentationReminder, /Customer approval summary written to/)
      assert.ok(presentationReminder.includes(approvalSummaryPath))
      assert.ok(presentationReminder.includes(executionPlanPath))
      assert.match(presentationReminder, /send its complete contents in a user-facing message/)
      assert.doesNotMatch(presentationReminder, /--approved-plan-sha256/)
      assert.doesNotMatch(presentationReminder, /--offline-fixture-nonce [a-f0-9]{32}/)
      assert.doesNotMatch(presentationReminder, /[a-f0-9]{64}/)
      assert.match(approvalSummary, /# Test Optimization Validation Approval Summary/)
      assert.match(approvalSummary, /## Commands/)
      assert.match(approvalSummary, /## Safety and Outputs/)
      assert.match(approvalSummary, /## Approval Command/)
      assert.match(approvalSummary, /--approved-plan-sha256 [a-f0-9]{64}/)
      assert.strictEqual(
        crypto.createHash('sha256').update(fs.readFileSync(approvalJsonPath)).digest('hex'),
        expectedDigest
      )

      fs.mkdirSync(junitDirectory, { recursive: true })
      fs.writeFileSync(junitShard, '<testsuite tests="1"/>\n')

      await runValidationCli([
        '--manifest', manifestPath,
        '--out', out,
        '--framework', manifest.frameworks[0].id,
        '--offline-fixture-nonce', nonce,
        '--print-approval-sha256',
      ])

      assert.strictEqual(logs.pop(), expectedDigest)
      assert.strictEqual(fs.existsSync(out), true)
    } finally {
      console.log = originalLog
      fs.rmSync(junitShard, { force: true })
      if (fs.existsSync(junitDirectory) && fs.readdirSync(junitDirectory).length === 0) {
        fs.rmdirSync(junitDirectory)
      }
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('fails closed before live validation when no approved plan digest is supplied', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const out = path.join(tmpDir, 'results')
    const errors = []
    const originalError = console.error
    const originalExitCode = process.exitCode
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
    })

    fs.writeFileSync(manifestPath, `${JSON.stringify(getRunnableManifest(tmpDir), null, 2)}\n`)
    console.error = error => errors.push(String(error))
    process.exitCode = undefined

    try {
      await main(['--manifest', manifestPath, '--out', out])

      assert.strictEqual(process.exitCode, 1)
      assert.strictEqual(fs.existsSync(out), false)
      assert.match(errors.join('\n'), /requires the --offline-fixture-nonce and --approved-plan-sha256 values/)
    } finally {
      console.error = originalError
      process.exitCode = originalExitCode
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('prints phase progress during live validation without requiring verbose mode', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-progress-'))
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const out = path.join(tmpDir, 'results')
    const logs = []
    const originalLog = console.log
    const originalExitCode = process.exitCode
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
      './report-writer': {
        async writeReport () {},
      },
      './scenarios/basic-reporting': {
        async runBasicReporting ({ framework }) {
          return {
            frameworkId: framework.id,
            scenario: 'basic-reporting',
            status: 'pass',
            diagnosis: 'Basic Reporting passed.',
            evidence: {},
            artifacts: [],
          }
        },
      },
      './setup-runner': {
        async runSetupCommands () {
          return { ok: true }
        },
      },
      './static-diagnosis': {
        getStaticBlocker () {
          return null
        },
        runStaticDiagnosis () {
          return { report: {} }
        },
      },
    })

    fs.writeFileSync(manifestPath, `${JSON.stringify(getRunnableManifest(tmpDir), null, 2)}\n`)
    console.log = message => logs.push(message)
    process.exitCode = undefined

    try {
      await main([
        '--manifest', manifestPath,
        '--out', out,
        '--scenario', 'basic-reporting',
        ...APPROVAL_ARGS,
      ])

      assert.deepStrictEqual(logs, [
        '[test-optimization-validator] jest:root: Test execution without Datadog started.',
        '[test-optimization-validator] jest:root: Test execution without Datadog pass.',
        '[test-optimization-validator] jest:root: Basic Reporting started.',
        '[test-optimization-validator] jest:root: Basic Reporting pass.',
      ])
      assert.strictEqual(process.exitCode, 0)
    } finally {
      console.log = originalLog
      process.exitCode = originalExitCode
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('refuses to use repository.root itself as the validation output directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const errors = []
    const originalError = console.error
    const originalExitCode = process.exitCode
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
    })

    fs.writeFileSync(manifestPath, `${JSON.stringify(getRunnableManifest(tmpDir), null, 2)}\n`)
    console.error = error => errors.push(String(error))
    process.exitCode = undefined

    try {
      await main(['--manifest', manifestPath, '--out', tmpDir, ...APPROVAL_ARGS])

      assert.strictEqual(process.exitCode, 1)
      assert.match(errors.join('\n'), /dedicated child directory inside repository.root/)
    } finally {
      console.error = originalError
      process.exitCode = originalExitCode
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('exits unsuccessfully when a selected advanced feature has only a proposed strategy', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const out = path.join(tmpDir, 'results')
    const manifest = getRunnableManifest(tmpDir)
    const originalExitCode = process.exitCode
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
      './report-writer': {
        async writeReport () {},
      },
      './scenarios/basic-reporting': {
        async runBasicReporting ({ framework }) {
          return {
            frameworkId: framework.id,
            scenario: 'basic-reporting',
            status: 'pass',
            diagnosis: 'Basic Reporting passed.',
            evidence: {},
            artifacts: [],
          }
        },
      },
      './setup-runner': {
        async runSetupCommands () {
          return { ok: true }
        },
      },
      './static-diagnosis': {
        getStaticBlocker () {
          return null
        },
        runStaticDiagnosis () {
          return { report: {} }
        },
      },
    })

    manifest.frameworks[0].generatedTestStrategy = {
      status: 'proposed',
      reason: 'The generated test command has not been verified.',
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    process.exitCode = undefined

    try {
      await main(['--manifest', manifestPath, '--out', out, '--scenario', 'efd', ...APPROVAL_ARGS])

      assert.strictEqual(process.exitCode, 1)
    } finally {
      process.exitCode = originalExitCode
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('skips CI wiring when direct-initialization Basic Reporting fails', async () => {
    const validation = await runCliFixture({
      './scenarios/basic-reporting': {
        async runBasicReporting ({ framework }) {
          return {
            frameworkId: framework.id,
            scenario: 'basic-reporting',
            status: 'fail',
            diagnosis: 'Basic Reporting did not emit events with direct Datadog initialization.',
            evidence: {},
            artifacts: [],
          }
        },
      },
      './scenarios/ci-wiring': {
        async runCiWiring () {
          throw new Error('CI wiring should not run until Basic Reporting passes')
        },
      },
    }, manifest => setReplayableCiWiring(manifest.frameworks[0], manifest.repository.root))

    assert.strictEqual(validation.exitCode, 1)
    assert.deepStrictEqual(validation.results.map(result => `${result.scenario}:${result.status}`), [
      'basic-reporting:fail',
      'ci-wiring:skip',
      'efd:skip',
      'atr:skip',
      'test-management:skip',
    ])
    assert.match(validation.results[1].diagnosis, /Skipped CI wiring validation because Basic Reporting/)
    assert.strictEqual(validation.results[1].evidence.basicReportingStatus, 'fail')
    assert.deepStrictEqual(validation.results[1].evidence.featureEligibility, {
      eligible: false,
      blockedBy: 'basic-reporting',
      reasonCode: 'basic-reporting-failed',
      scenario: 'ci-wiring',
    })
    assert.deepStrictEqual(validation.results[2].evidence.featureEligibility, {
      eligible: false,
      blockedBy: 'basic-reporting',
      reasonCode: 'basic-reporting-failed',
      scenario: 'efd',
    })
  })

  it('does not run CI wiring when only Basic Reporting is selected', async () => {
    const validation = await runCliFixture({
      './scenarios/ci-wiring': {
        async runCiWiring () {
          throw new Error('CI wiring should not run when only Basic Reporting is selected')
        },
      },
    }, manifest => setReplayableCiWiring(manifest.frameworks[0], manifest.repository.root), [
      '--scenario', 'basic-reporting',
    ])

    assert.strictEqual(validation.exitCode, 0)
    assert.deepStrictEqual(validation.results.map(result => `${result.scenario}:${result.status}`), [
      'basic-reporting:pass',
    ])
  })

  it('does not run implicit CI wiring when no replayable command was selected', async () => {
    const validation = await runCliFixture({
      './scenarios/ci-wiring': {
        async runCiWiring () {
          throw new Error('CI wiring should not run without a replayable command')
        },
      },
      './scenarios/early-flake-detection': {
        async runEarlyFlakeDetection ({ framework }) {
          return getPassingScenarioResult(framework, 'efd')
        },
      },
      './scenarios/auto-test-retries': {
        async runAutoTestRetries ({ framework }) {
          return getPassingScenarioResult(framework, 'atr')
        },
      },
      './scenarios/test-management': {
        async runTestManagement ({ framework }) {
          return getPassingScenarioResult(framework, 'test-management')
        },
      },
    }, manifest => {
      manifest.frameworks[0].ciWiring = {
        status: 'unknown',
        reason: 'No replayable CI command was identified.',
      }
    })

    assert.strictEqual(validation.exitCode, 0)
    assert.deepStrictEqual(validation.results.map(result => `${result.scenario}:${result.status}`), [
      'basic-reporting:pass',
      'efd:pass',
      'atr:pass',
      'test-management:pass',
    ])
  })

  it('reports missing CI wiring metadata as incomplete when CI wiring is explicitly selected', async () => {
    const validation = await runCliFixture({}, manifest => {
      manifest.frameworks[0].ciWiring = {
        status: 'unknown',
        reason: 'No replayable CI command was identified.',
      }
    }, ['--scenario', 'ci-wiring'])

    assert.strictEqual(validation.exitCode, 1)
    assert.deepStrictEqual(validation.results.map(result => `${result.scenario}:${result.status}`), [
      'basic-reporting:pass',
      'ci-wiring:error',
    ])
    assert.strictEqual(validation.results[1].diagnosis,
      'CI wiring was not replayed: No replayable CI command was identified. ' +
      'No live CI-wiring conclusion was reached.')
    assert.strictEqual(validation.results[1].evidence.manifestIncomplete, true)
    assert.strictEqual(validation.results[1].evidence.recommendation, 'Add ciWiringCommand to the manifest when ' +
      'a CI test step can be safely replayed locally.')
  })

  it('treats non-runnable discovery entries as non-blocking skipped diagnostics', async () => {
    const validation = await runCliFixture({}, manifest => {
      const root = manifest.repository.root
      manifest.frameworks.unshift({
        id: 'jest:fixture',
        framework: 'jest',
        frameworkVersion: '29.7.0',
        status: 'requires_manual_setup',
        project: { root },
        notes: ['The fixture requires package-specific install and build steps.'],
      }, {
        id: 'node-test:root',
        framework: 'node:test',
        frameworkVersion: '22.0.0',
        status: 'unsupported_by_validator',
        project: { root },
        notes: ['node:test is detected for diagnosis only.'],
      })
    }, ['--scenario', 'basic-reporting'])

    assert.strictEqual(validation.exitCode, 0)
    assert.deepStrictEqual(validation.results.map(result => {
      return `${result.frameworkId}:${result.scenario}:${result.status}`
    }), ['jest:fixture:all:skip', 'node-test:root:all:skip', 'jest:root:basic-reporting:pass'])
    assert.match(validation.results[0].diagnosis, /no runnable validation command/)
    assert.strictEqual(validation.results[0].evidence.frameworkStatus, 'requires_manual_setup')
    assert.match(validation.results[1].diagnosis, /not supported/)
    assert.strictEqual(validation.results[1].evidence.frameworkStatus, 'unsupported_by_validator')
  })

  it('includes Mocha rc files in non-runnable status evidence', async () => {
    const validation = await runCliFixture({}, manifest => {
      const root = manifest.repository.root
      manifest.frameworks = [{
        id: 'mocha:root',
        framework: 'mocha',
        frameworkVersion: '10.0.0',
        status: 'requires_manual_setup',
        project: {
          root,
        },
        notes: [
          'No small representative Mocha command was selected.',
        ],
      }]
      fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
        devDependencies: {
          mocha: '10.0.0',
        },
      }, null, 2)}\n`)
      fs.writeFileSync(path.join(root, '.mocharc.json'), '{}\n')
    })

    assert.strictEqual(validation.exitCode, 1)
    assert.deepStrictEqual(validation.results[0].evidence.configFiles, ['.mocharc.json'])
    assert.deepStrictEqual(validation.results[0].evidence.directDependency, {
      field: 'devDependencies',
      version: '10.0.0',
    })
  })

  it('uses static diagnosis framework config patterns in non-runnable status evidence', async () => {
    const validation = await runCliFixture({}, manifest => {
      const root = manifest.repository.root
      manifest.frameworks = [
        {
          id: 'jest:root',
          framework: 'jest',
          frameworkVersion: '29.7.0',
          status: 'requires_manual_setup',
          project: { root },
          notes: ['No representative Jest command was selected.'],
        },
        {
          id: 'cypress:root',
          framework: 'cypress',
          frameworkVersion: '13.0.0',
          status: 'requires_manual_setup',
          project: { root },
          notes: ['No representative Cypress command was selected.'],
        },
        {
          id: 'cucumber:root',
          framework: 'cucumber',
          frameworkVersion: '10.0.0',
          status: 'requires_manual_setup',
          project: { root },
          notes: ['No representative Cucumber command was selected.'],
        },
      ]
      fs.writeFileSync(path.join(root, 'config-jest.js'), 'module.exports = {}\n')
      fs.writeFileSync(path.join(root, 'cypress.json'), '{}\n')
      fs.writeFileSync(path.join(root, 'cucumber.js'), 'module.exports = {}\n')
    })

    assert.strictEqual(validation.exitCode, 1)
    assert.deepStrictEqual(validation.results.map(result => result.evidence.configFiles), [
      ['config-jest.js'],
      ['cypress.json'],
      ['cucumber.js'],
    ])
  })
})

/**
 * Runs the live CLI against an isolated manifest while replacing external phases.
 *
 * @param {object} stubs proxyquire overrides
 * @param {(manifest: object) => void} [prepare] manifest fixture customization
 * @param {string[]} [args] additional CLI arguments
 * @returns {Promise<{exitCode: number|undefined, results: object[]}>} captured validation result
 */
async function runCliFixture (stubs = {}, prepare = () => {}, args = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
  const manifestPath = path.join(root, 'dd-test-optimization-validation-manifest.json')
  const out = path.join(root, 'results')
  const manifest = getRunnableManifest(root)
  const originalExitCode = process.exitCode
  let results
  const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
    ...PASSING_VALIDATION_PHASES,
    './generated-files': {
      async cleanupGeneratedFiles () {},
    },
    './report-writer': {
      writePendingReport () {},
      async writeReport (report) {
        results = report.results
      },
    },
    './scenarios/basic-reporting': {
      async runBasicReporting ({ framework }) {
        return {
          frameworkId: framework.id,
          scenario: 'basic-reporting',
          status: 'pass',
          diagnosis: 'Basic Reporting passed.',
          evidence: {},
          artifacts: [],
        }
      },
    },
    './setup-runner': {
      async runSetupCommands () {
        return { ok: true }
      },
    },
    './static-diagnosis': {
      getStaticBlocker () {},
      runStaticDiagnosis () {
        return { report: {} }
      },
    },
    ...stubs,
  })

  prepare(manifest)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  process.exitCode = undefined

  try {
    await main(['--manifest', manifestPath, '--out', out, ...args, ...APPROVAL_ARGS])
    return { exitCode: process.exitCode, results }
  } finally {
    process.exitCode = originalExitCode
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function getRunnableManifest (root) {
  return {
    schemaVersion: '1.0',
    repository: {
      root,
      packageManager: 'npm',
      workspaceManager: 'none',
    },
    environment: {
      os: 'darwin',
    },
    frameworks: [
      {
        id: 'jest:root',
        framework: 'jest',
        frameworkVersion: '30.1.3',
        status: 'runnable',
        project: {
          root,
        },
        existingTestCommand: {
          cwd: root,
          argv: ['npm', 'test'],
        },
        preflight: {
          ran: true,
          exitCode: 0,
        },
        ciWiring: {
          status: 'skip',
          reason: 'No CI test job was found in this fixture.',
        },
      },
    ],
  }
}

function setReplayableCiWiring (framework, root) {
  framework.ciWiring = {
    status: 'fail',
    provider: 'github-actions',
    configFile: path.join(root, '.github', 'workflows', 'test.yml'),
    job: 'test',
    step: 'Run tests',
    workingDirectory: root,
    whySelected: 'The step runs the selected representative test command.',
  }
  framework.ciWiringCommand = {
    cwd: root,
    argv: [process.execPath, '-e', 'console.log("1 passing")'],
  }
}

function getPassingScenarioResult (framework, scenario) {
  return {
    frameworkId: framework.id,
    scenario,
    status: 'pass',
    diagnosis: `${scenario} passed.`,
    evidence: {},
    artifacts: [],
  }
}

/**
 * Returns every JavaScript file below a directory.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function listJavaScriptFiles (directory) {
  const files = []

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      files.push(...listJavaScriptFiles(entryPath))
    } else if (entry.name.endsWith('.js')) {
      files.push(entryPath)
    }
  }

  return files
}

/**
 * Returns the installable package name for a module specifier.
 *
 * @param {string} specifier
 * @returns {string}
 */
function getPackageName (specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * Reports whether a path is covered by package.json's published file patterns.
 *
 * @param {string} relativePath
 * @returns {boolean}
 */
function isPublishedValidationPath (relativePath) {
  return relativePath.startsWith('ci/') ||
    relativePath.startsWith('vendor/dist/') ||
    /^packages\/[^/]+\/(?:index\.js|lib\/|src\/)/.test(relativePath) ||
    ['loader-hook.mjs', 'register.js', 'version.js'].includes(relativePath)
}
