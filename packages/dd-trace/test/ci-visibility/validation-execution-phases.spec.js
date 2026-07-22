'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  getExecutableForSpawn,
  getResolvedExecutable,
  getUnavailableExecutable,
  isExplicitExecutablePath,
} = require('../../../../ci/test-optimization-validation/executable')
const { runCommand } = require('../../../../ci/test-optimization-validation/command-runner')
const {
  getLocalValidationCommand,
} = require('../../../../ci/test-optimization-validation/local-command')
const {
  getCommandSuitabilityError,
  getPackageScriptExpansion,
} = require('../../../../ci/test-optimization-validation/command-suitability')
const {
  cleanupGeneratedFiles,
} = require('../../../../ci/test-optimization-validation/generated-files')
const {
  GENERATED_SCENARIOS,
  getGeneratedTestContent,
  getGeneratedTestContractError,
} = require('../../../../ci/test-optimization-validation/generated-test-contract')
const {
  verifyGeneratedTestStrategy,
} = require('../../../../ci/test-optimization-validation/generated-verifier')
const {
  formatExecutionPlan,
} = require('../../../../ci/test-optimization-validation/plan-writer')
const {
  runFrameworkPreflight,
} = require('../../../../ci/test-optimization-validation/preflight-runner')
const {
  getObservedTestCount,
} = require('../../../../ci/test-optimization-validation/test-output')

describe('test optimization validator-owned execution phases', () => {
  it('runs a Datadog-clean preflight with local Jest adjustments', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-'))
    const jestEntrypoint = path.join(root, 'jest.js')
    fs.writeFileSync(
      jestEntrypoint,
      'if (process.env.NODE_OPTIONS || process.env.DD_API_KEY) process.exit(42); ' +
        'console.log("Tests: 1 passed, 1 total")\n'
    )
    const framework = {
      id: 'jest:root',
      framework: 'jest',
      existingTestCommand: {
        cwd: root,
        argv: [
          process.execPath,
          jestEntrypoint,
        ],
        env: {
          DD_API_KEY: 'must-not-reach-preflight',
          NODE_OPTIONS: '-r dd-trace/ci/init',
        },
      },
      preflight: { status: 'pending', maxTestCount: 1 },
    }

    try {
      fs.mkdirSync(path.join(root, 'results'))
      const outcome = await runFrameworkPreflight({
        framework,
        options: { verbose: false },
        out: path.join(root, 'results'),
      })

      assert.strictEqual(outcome.ok, true)
      assert.strictEqual(framework.preflight.source, 'validator')
      assert.strictEqual(framework.preflight.exitCode, 0)
      assert.strictEqual(framework.preflight.observedTestCount, 1)
      assert.match(framework.preflight.command, /--no-watchman/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses inline Datadog initialization before a clean preflight can run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-inline-preflight-'))
    const framework = {
      id: 'mocha:root',
      framework: 'mocha',
      existingTestCommand: {
        cwd: root,
        argv: ['env', 'NODE_OPTIONS=-r dd-trace/ci/init', process.execPath, '-e', 'process.exit(0)'],
      },
      preflight: { status: 'pending', maxTestCount: 1 },
    }

    try {
      await assert.rejects(runFrameworkPreflight({
        framework,
        options: { verbose: false },
        out: path.join(root, 'results'),
      }), /Cannot create a Datadog-clean command.*inline dd-trace preload/)
      assert.strictEqual(fs.existsSync(path.join(root, 'results')), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('stops when the clean preflight exceeds the approved representative scope', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-scope-'))
    const framework = {
      id: 'mocha:root',
      framework: 'mocha',
      existingTestCommand: {
        cwd: root,
        argv: [process.execPath, '-e', 'console.log("100 passing")'],
      },
      preflight: { status: 'pending', maxTestCount: 1 },
    }

    try {
      fs.mkdirSync(path.join(root, 'results'))
      const outcome = await runFrameworkPreflight({
        framework,
        options: { repositoryRoot: root, verbose: false },
        out: path.join(root, 'results'),
      })

      assert.strictEqual(outcome.ok, false)
      assert.strictEqual(outcome.preflight.observedTestCount, 100)
      assert.strictEqual(outcome.preflight.scopeMatched, false)
      assert.match(outcome.failure.diagnosis, /exceeding the approved representative scope of at most 1/)
      assert.strictEqual(outcome.failure.evidence.representativeScopeMismatch, true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a clean preflight that ran a failing test', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-failure-'))
    const framework = {
      id: 'jest:root',
      framework: 'jest',
      existingTestCommand: {
        cwd: root,
        argv: [
          process.execPath,
          '-e',
          'console.error("Error: Cannot find module after the test started"); ' +
            'console.log("Tests: 1 failed, 1 total"); process.exit(1)',
        ],
      },
      preflight: { status: 'pending', maxTestCount: 1 },
    }

    try {
      fs.mkdirSync(path.join(root, 'results'))
      const outcome = await runFrameworkPreflight({
        framework,
        options: { repositoryRoot: root, verbose: false },
        out: path.join(root, 'results'),
      })

      assert.strictEqual(outcome.ok, false)
      assert.strictEqual(outcome.preflight.observedTestCount, 1)
      assert.match(outcome.failure.diagnosis, /ran 1 test but exited 1 without Datadog/)
      assert.strictEqual(outcome.failure.evidence.commandFailure, undefined)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a package-manager filesystem denial as an execution-environment blocker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-package-manager-'))
    const framework = {
      id: 'vitest:root',
      framework: 'vitest',
      existingTestCommand: {
        cwd: root,
        argv: [
          process.execPath,
          '-e',
          'console.error("ERROR EPERM: operation not permitted, mkdir ' +
            '/home/user/.local/share/pnpm/.tools/pnpm"); ' +
            'process.exit(1)',
        ],
      },
      preflight: { status: 'pending', maxTestCount: 1 },
    }

    try {
      fs.mkdirSync(path.join(root, 'results'))
      const outcome = await runFrameworkPreflight({
        framework,
        options: { repositoryRoot: root, verbose: false },
        out: path.join(root, 'results'),
      })

      assert.strictEqual(outcome.ok, false)
      assert.strictEqual(outcome.failure.status, 'blocked')
      assert.strictEqual(outcome.failure.evidence.representativeScopeMismatch, false)
      assert.strictEqual(outcome.failure.evidence.commandFailure.kind, 'package-manager-filesystem-blocked')
      assert.match(outcome.failure.diagnosis, /package manager could not write to its tool or cache directory/)
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /writable package-manager home or cache/)
      assert.doesNotMatch(outcome.failure.diagnosis, /determine how many tests/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a denied project localhost listener as an execution-environment blocker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-local-listener-'))
    const framework = {
      id: 'vitest:root',
      framework: 'vitest',
      existingTestCommand: {
        cwd: root,
        argv: [
          process.execPath,
          '-e',
          'console.error("listen EPERM: operation not permitted 127.0.0.1"); process.exit(1)',
        ],
      },
      preflight: { status: 'pending', maxTestCount: 1 },
    }

    try {
      fs.mkdirSync(path.join(root, 'results'))
      const outcome = await runFrameworkPreflight({
        framework,
        options: { repositoryRoot: root, verbose: false },
        out: path.join(root, 'results'),
      })

      assert.strictEqual(outcome.ok, false)
      assert.strictEqual(outcome.failure.status, 'blocked')
      assert.strictEqual(outcome.failure.evidence.commandFailure.kind, 'local-test-socket-blocked')
      assert.match(outcome.failure.diagnosis, /project test could not start its localhost listener/)
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /Do not request broader permissions/)
      assert.doesNotMatch(outcome.failure.diagnosis, /determine how many tests/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a silent Cypress application abort as an execution-environment blocker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-cypress-launch-'))
    const framework = {
      id: 'cypress:root',
      framework: 'cypress',
      existingTestCommand: {
        cwd: root,
        argv: [process.execPath, '-e', 'process.exit(134)'],
      },
      preflight: { status: 'pending', maxTestCount: 1 },
    }

    try {
      fs.mkdirSync(path.join(root, 'results'))
      const outcome = await runFrameworkPreflight({
        framework,
        options: { repositoryRoot: root, verbose: false },
        out: path.join(root, 'results'),
      })

      assert.strictEqual(outcome.ok, false)
      assert.strictEqual(outcome.failure.status, 'blocked')
      assert.strictEqual(outcome.failure.evidence.commandFailure.kind, 'cypress-application-launch-blocked')
      assert.match(outcome.failure.diagnosis, /application process could not launch/)
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /exact checksum-approved validator command/)
      assert.doesNotMatch(outcome.failure.diagnosis, /determine how many tests/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not treat another framework exiting 134 as a Cypress environment blocker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-non-cypress-abort-'))
    const framework = {
      id: 'vitest:root',
      framework: 'vitest',
      existingTestCommand: {
        cwd: root,
        argv: [process.execPath, '-e', 'process.exit(134)'],
      },
      preflight: { status: 'pending', maxTestCount: 1 },
    }

    try {
      fs.mkdirSync(path.join(root, 'results'))
      const outcome = await runFrameworkPreflight({
        framework,
        options: { repositoryRoot: root, verbose: false },
        out: path.join(root, 'results'),
      })

      assert.strictEqual(outcome.ok, false)
      assert.strictEqual(outcome.failure.status, 'error')
      assert.strictEqual(outcome.failure.evidence.commandFailure, undefined)
      assert.match(outcome.failure.diagnosis, /determine how many tests/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a missing Playwright browser as a setup blocker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-playwright-browser-'))
    const framework = {
      id: 'playwright:root',
      framework: 'playwright',
      status: 'runnable',
      project: { root },
      existingTestCommand: {
        cwd: root,
        argv: [process.execPath, '-e', [
          "console.error(\"browserType.launch: Executable doesn't exist at /missing/chromium\")",
          "console.error('Please run the following command to download new browsers: playwright install')",
          'process.exit(1)',
        ].join(';')],
      },
      preflight: { maxTestCount: 1 },
    }

    try {
      const outcome = await runFrameworkPreflight({
        framework,
        options: { repositoryRoot: root, verbose: false },
        out: root,
      })

      assert.strictEqual(outcome.ok, false)
      assert.strictEqual(outcome.failure.status, 'blocked')
      assert.strictEqual(outcome.failure.evidence.commandFailure.kind, 'playwright-browser-missing')
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /does not download browsers/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports module resolution failures before unknown test-count diagnostics', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-module-resolution-'))
    const framework = {
      id: 'jest:root',
      framework: 'jest',
      existingTestCommand: {
        cwd: root,
        argv: [
          process.execPath,
          '-e',
          'console.error("Error: Cannot find module \'./dist/index.js\'"); process.exit(1)',
        ],
      },
      preflight: { status: 'pending', maxTestCount: 1 },
    }

    try {
      fs.mkdirSync(path.join(root, 'results'))
      const outcome = await runFrameworkPreflight({
        framework,
        options: { repositoryRoot: root, verbose: false },
        out: path.join(root, 'results'),
      })

      assert.strictEqual(outcome.ok, false)
      assert.strictEqual(outcome.failure.status, 'blocked')
      assert.strictEqual(outcome.failure.evidence.commandFailure.kind, 'project-command-initialization-failed')
      assert.match(outcome.failure.diagnosis, /failed during module resolution/)
      assert.doesNotMatch(outcome.failure.diagnosis, /determine how many tests/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('verifies generated scenarios and removes retry state before advanced validation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-generated-'))
    const generatedDirectory = path.join(root, 'tests', 'dd-test-optimization-validation')
    const generatedFile = path.join(generatedDirectory, 'scenarios.test.js')
    const stateFile = path.join(generatedDirectory, '.dd-test-optimization-validation-atr-state')
    const framework = getPlannedFramework(root, generatedFile, stateFile)
    const out = path.join(root, 'results')

    try {
      fs.mkdirSync(out)
      const outcome = await verifyGeneratedTestStrategy({
        framework,
        options: { verbose: false },
        out,
      })

      assert.strictEqual(outcome.ok, true)
      assert.strictEqual(framework.generatedTestStrategy.status, 'verified')
      assert.deepStrictEqual(
        framework.generatedTestStrategy.verification.observedScenarios.map(scenario => scenario.observedTestCount),
        [1, 1, 1]
      )
      assert.strictEqual(fs.existsSync(stateFile), false)
      assert.strictEqual(fs.existsSync(generatedFile), true)

      cleanupGeneratedFiles({ frameworks: [framework] })

      assert.strictEqual(fs.existsSync(generatedFile), false)
      assert.strictEqual(fs.existsSync(generatedDirectory), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('verifies Cypress scenarios without requiring a persistent retry-state file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-generated-cypress-'))
    const generatedDirectory = path.join(root, 'cypress', 'e2e')
    const generatedFiles = {
      'basic-pass': path.join(generatedDirectory, 'dd-test-optimization-validation-basic-pass.cy.js'),
      'atr-fail-once': path.join(generatedDirectory, 'dd-test-optimization-validation-atr-fail-once.cy.js'),
      'test-management-target': path.join(
        generatedDirectory,
        'dd-test-optimization-validation-test-management-target.cy.js'
      ),
    }
    const framework = {
      id: 'cypress:root',
      framework: 'cypress',
      status: 'runnable',
      project: { root },
      generatedTestStrategy: {
        status: 'planned',
        adapter: 'cypress',
        moduleSystem: 'commonjs',
        files: Object.entries(generatedFiles).map(([id, filename]) => ({
          path: filename,
          contentLines: getGeneratedTestContent({
            framework: 'cypress',
            moduleSystem: 'commonjs',
            scenarioId: id,
          }).split('\n'),
        })),
        scenarios: Object.entries(generatedFiles).map(([id, filename]) => ({
          id,
          runCommand: {
            cwd: root,
            argv: [
              process.execPath,
              '-e',
              `console.log('Tests: 1'); process.exit(${id === 'atr-fail-once' ? 1 : 0})`,
              filename,
            ],
          },
          expectedWithoutDatadog: {
            exitCode: id === 'atr-fail-once' ? 1 : 0,
            observedTestCount: 1,
          },
          testIdentities: [{ name: GENERATED_SCENARIOS[id].testName, file: filename }],
        })),
        cleanupPaths: Object.values(generatedFiles),
      },
    }
    const out = path.join(root, 'results')

    try {
      fs.mkdirSync(out)
      const outcome = await verifyGeneratedTestStrategy({
        framework,
        options: { verbose: false },
        out,
      })

      assert.strictEqual(outcome.ok, true)
      assert.strictEqual(framework.generatedTestStrategy.status, 'verified')
      assert.ok(framework.generatedTestStrategy.verification.observedScenarios.every(scenario => {
        return scenario.failOnceStateCreated === undefined
      }))
      cleanupGeneratedFiles({ frameworks: [framework] })
      assert.strictEqual(fs.existsSync(generatedDirectory), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a fail-once scenario that fails before creating its declared state file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-generated-'))
    const generatedFile = path.join(root, 'tests', 'dd-test-optimization-validation.test.js')
    const stateFile = path.join(root, 'tests', '.dd-test-optimization-validation-atr-state')
    const framework = getPlannedFramework(root, generatedFile, stateFile)
    const atrScenario = framework.generatedTestStrategy.scenarios.find(scenario => scenario.id === 'atr-fail-once')
    atrScenario.runCommand.argv = [
      process.execPath,
      '-e',
      'console.error("Tests: 1 failed, 1 total"); process.exit(1)',
    ]

    try {
      fs.mkdirSync(path.join(root, 'results'))
      const outcome = await verifyGeneratedTestStrategy({
        framework,
        options: { verbose: false },
        out: path.join(root, 'results'),
      })

      assert.strictEqual(outcome.ok, false)
      assert.match(outcome.failure.diagnosis, /failed without creating its declared fail-once state file/)
      assert.strictEqual(
        outcome.failure.evidence.scenarios.find(scenario => scenario.id === 'atr-fail-once').failOnceStateCreated,
        false
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('verifies only generated scenarios required by the selected advanced check', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-generated-'))
    const generatedFile = path.join(root, 'tests', 'dd-test-optimization-validation', 'scenarios.test.js')
    const stateFile = path.join(root, 'tests', '.dd-test-optimization-validation-atr-state')
    const framework = getPlannedFramework(root, generatedFile, stateFile)
    const out = path.join(root, 'results')

    try {
      fs.mkdirSync(out)
      const outcome = await verifyGeneratedTestStrategy({
        framework,
        options: {
          scenarios: new Set(['basic-reporting', 'efd']),
          verbose: false,
        },
        out,
      })

      assert.strictEqual(outcome.ok, true)
      assert.deepStrictEqual(
        framework.generatedTestStrategy.verification.observedScenarios.map(scenario => scenario.id),
        ['basic-pass']
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('prints normalized commands and unambiguous paths without executing project code', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-plan-'))
    const manifestPath = path.join(root, 'manifest.json')
    const generatedFile = path.join(root, 'tests', 'dd-test-optimization-validation.test.js')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-test-optimization-validation'))
    framework.project.name = '@example/app'
    framework.existingTestCommand = {
      cwd: root,
      argv: ['npm', 'test', '--', '--runInBand', '--token', 'plan-secret'],
      displayCommand: 'echo harmless-display-command',
      env: {
        BASH_ENV: './project-shell-init',
      },
      outputPaths: [path.join(root, 'coverage')],
    }
    framework.ciWiring = {
      provider: 'github-actions',
      command: 'pnpm test',
      diagnosis: 'The selected CI job does not initialize Test Optimization.',
      initialization: {
        status: 'not_configured',
        evidence: ['NODE_OPTIONS is not set in the selected CI job.'],
      },
    }
    const unsupportedFramework = {
      id: 'karma:browser-example',
      framework: 'karma',
      status: 'unsupported_by_validator',
      project: { name: 'browser-example', root: path.join(root, 'examples', 'browser') },
      notes: ['Karma requires browser execution and is not supported by this validator.'],
    }
    const manifest = {
      __path: manifestPath,
      repository: { root },
      frameworks: [framework, unsupportedFramework],
    }
    const manifestFile = { ...manifest }
    delete manifestFile.__path
    fs.writeFileSync(manifestPath, JSON.stringify(manifestFile))

    try {
      const planOut = path.join(root, 'results-atr')
      const plan = formatExecutionPlan({
        manifest,
        out: planOut,
        selectedFrameworkIds: ['jest:root'],
        requestedScenario: 'atr',
      })
      const fullPlan = formatExecutionPlan({
        manifest,
        out: path.join(root, 'results-all'),
        selectedFrameworkIds: ['jest:root'],
      })
      const ciOnlyPlan = formatExecutionPlan({
        manifest,
        out: path.join(root, 'results-ci'),
        selectedFrameworkIds: ['jest:root'],
        requestedScenario: 'ci-wiring',
      })

      assert.strictEqual(fs.readFileSync(path.join(planOut, 'execution-plan.md'), 'utf8'), `${plan}\n`)
      const approvalSummary = fs.readFileSync(path.join(planOut, 'approval-summary.md'), 'utf8')
      assert.match(approvalSummary, /# Test Optimization Validation Approval Summary/)
      assert.match(approvalSummary, /\*\*Test candidate 1\*\*/)
      assert.match(approvalSummary, /Without Datadog \(confirms the selected test file runs normally\)/)
      assert.match(
        approvalSummary,
        /With Datadog, only if this is the first candidate that passes: run the same command with/
      )
      assert.match(approvalSummary, /Advanced Check: Auto Test Retries/)
      assert.match(approvalSummary, /npm test -- --runInBand --token <redacted> --no-watchman/)
      assert.match(approvalSummary, /test\('atr-fail-once'/)
      assert.doesNotMatch(approvalSummary, /Approve executing/)
      assert.match(approvalSummary, /Files removed after validation/)
      assert.match(approvalSummary, /--run-approved-plan results-atr\/approval\.json --sha256 [a-f0-9]{64}/)
      if (process.platform === 'win32') {
        assert.match(approvalSummary, /certutil -hashfile .*approval\.json"? SHA256/)
        assert.doesNotMatch(approvalSummary, /shasum -a 256 -c/)
      } else {
        assert.match(approvalSummary, /shasum -a 256 .*approval\.json/)
        assert.match(approvalSummary, /shasum -a 256 --quiet -c .*approval-files\.sha256/)
      }
      assert.match(approvalSummary, /do not verify where the installed `dd-trace` package came from/)
      assert.doesNotMatch(approvalSummary, /plan-secret/)
      assert.doesNotMatch(plan, /Agent presentation requirement|command-approval dialog|approval surfaces/)
      assert.doesNotMatch(plan, /complete customer execution plan|command output may be collapsed/)
      assert.match(plan, /--no-watchman/)
      const relativeGeneratedFile = path.relative(root, generatedFile).split(path.sep).join('/')
      assert.match(plan, new RegExp(escapeRegExp(relativeGeneratedFile)))
      assert.doesNotMatch(plan, new RegExp(`Path: .*${escapeRegExp(generatedFile)}`))
      assert.match(plan, /npm test -- --runInBand --token <redacted> --no-watchman/)
      assert.doesNotMatch(plan, /echo harmless-display-command/)
      assert.match(plan, /BASH_ENV=\.\/project-shell-init/)
      assert.match(plan, /Command-created outputs: `coverage` \(must not exist before validation; newly created /)
      assert.match(plan, /NODE_OPTIONS=(?:"-r dd-trace\/ci\/init"|'-r dd-trace\/ci\/init') npm test/)
      assert.match(ciOnlyPlan, /#### CI Configuration Audit/)
      assert.doesNotMatch(ciOnlyPlan, /#### Temporary Tests Created for Advanced Checks/)
      assert.match(plan, /#### Local Test Candidate 1: Without Datadog/)
      assert.match(plan, /#### Local Test Candidate 1: With Datadog When Selected/)
      assert.doesNotMatch(plan, /Optional Exact CI Test Execution/)
      assert.doesNotMatch(plan, /##### C\d|\| Check \| Command \|/)
      assert.match(plan, /#### Temporary Tests Created for Advanced Checks/)
      assert.match(plan, /Advanced Check: Auto Test Retries/)
      assert.doesNotMatch(plan, /Advanced Check: Early Flake Detection/)
      assert.doesNotMatch(plan, /Advanced Check: Test Management/)
      assert.doesNotMatch(plan, /#### Generated Test Verification:/)
      assert.doesNotMatch(fullPlan, /preload probe/)
      assert.match(plan, /3: verify the test alone, discover its identity, then validate the feature/)
      assert.match(plan, /#### Temporary Test Cleanup/)
      assert.match(plan, /Paths are relative to the repository root/)
      assert.match(plan, /##### `tests\/dd-test-optimization-validation\.test\.js`/)
      assert.doesNotMatch(plan, /<details>|<summary>/)
      assert.match(plan, /test\('atr-fail-once'/)
      assert.match(plan, /- Working directory: `\.`/)
      assert.match(plan, /## What Will Be Validated/)
      assert.match(plan, /\*\*Jest tests for @example\/app\*\*: will be validated/)
      assert.match(plan, /\*\*Karma tests for browser-example\*\*: not supported by this validator/)
      assert.match(plan, /## Executables Used/)
      assert.match(plan, /- Node\.js: `/)
      assert.doesNotMatch(plan, /Technical Safeguard: Command Identity|\(SHA-256 `/)
      assert.doesNotMatch(plan, /- Approved executable:|- Executable SHA-256:/)
      assert.match(plan, /## Start the Validation/)
      assert.match(plan, /local validator included with the installed `dd-trace` package/)
      assert.match(plan, /bounded filesystem cache fixtures/)
      assert.match(plan, /does not open a listener or use a network endpoint/)
      assert.match(plan, /During normal operation, `dd-trace` downloads Test Optimization settings/)
      assert.match(plan, /Private response directory:/)
      assert.match(plan, /Each check gets an isolated subdirectory containing bounded Test Optimization settings/)
      assert.doesNotMatch(plan, /\.testoptimization\/cache\/http\/settings\.json|Execution folders:/)
      assert.match(plan, /adds `DD_TRACE_DEBUG=1`/)
      assert.match(plan, /Exact fixture recipes and paths are included in the approval digest/)
      assert.doesNotMatch(plan, /Fixture recipe SHA-256/)
      assert.match(plan, /\.offline-payloads\/payloads\/tests/)
      assert.doesNotMatch(plan, /network listener|HTTP server/)
      assert.match(plan, /does not require real Datadog credentials, inspect credential stores, or upload/)
      assert.doesNotMatch(plan, /- Confirm the selected test command/)
      assert.doesNotMatch(plan, /Credential exposure: unknown/)
      assert.doesNotMatch(fullPlan, /safe-placeholder/)
      assert.doesNotMatch(plan, /plan-secret/)
      const approvalJsonPath = path.join(planOut, 'approval.json')
      const approvalJson = fs.readFileSync(approvalJsonPath)
      const approvalMaterial = JSON.parse(approvalJson)
      const fullApprovalMaterial = JSON.parse(fs.readFileSync(path.join(root, 'results-all', 'approval.json')))
      const planNonce = approvalMaterial.validation.offlineFixtureNonce
      const fullPlanNonce = fullApprovalMaterial.validation.offlineFixtureNonce
      assert.match(planNonce, /^[a-f0-9]{32}$/)
      assert.match(plan, new RegExp(`dd-test-optimization-validation-${planNonce}`))
      assert.notStrictEqual(planNonce, fullPlanNonce)
      assert.match(plan, /--run-approved-plan results-atr\/approval\.json --sha256 [a-f0-9]{64}/)
      assert.doesNotMatch(plan, /--framework jest:root|--scenario atr/)
      assert.deepStrictEqual(approvalMaterial.selection, {
        frameworks: ['jest:root'],
        scenario: 'atr',
      })
      const approvalDigest = plan.match(/--sha256 ([a-f0-9]{64})/)?.[1]
      assert.match(approvalDigest, /^[a-f0-9]{64}$/)
      const coveredFilesPath = path.join(planOut, 'approval-files.sha256')
      const coveredFiles = fs.readFileSync(coveredFilesPath, 'utf8').trim().split('\n').map(line => {
        const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line)
        assert.ok(match)
        return { filename: match[2], sha256: match[1] }
      })
      assert.strictEqual(crypto.createHash('sha256').update(approvalJson).digest('hex'), approvalDigest)
      assert.strictEqual(fs.existsSync(coveredFilesPath), true)
      assert.ok(coveredFiles.some(file => file.filename === manifestPath))
      for (const file of coveredFiles) {
        const actualDigest = crypto.createHash('sha256').update(fs.readFileSync(file.filename)).digest('hex')
        assert.strictEqual(actualDigest, file.sha256)
      }
      assert.match(plan, /Approval details: `results-atr\/approval\.json`/)
      assert.match(plan, /Covered file checksums: `results-atr\/approval-files\.sha256`/)
      if (process.platform === 'win32') {
        assert.match(plan, /certutil -hashfile .*approval\.json"? SHA256/)
      } else {
        assert.match(plan, /shasum -a 256 .*approval\.json/)
      }
      assert.match(plan, new RegExp(`Expected SHA-256: \`${approvalDigest}\``))
      assert.match(plan, /verifies the saved approval JSON against the SHA-256/)
      assert.match(plan, /reconstructs the approval material from the current manifest/)
      assert.ok(approvalMaterial.commands.length > 0)
      assert.ok(approvalMaterial.generatedFiles.some(file => file.path === generatedFile))
      assert.ok(approvalMaterial.validator.coveredFiles.some(file => file.path.endsWith('/approval.js')))
      assert.doesNotMatch(approvalJson.toString(), /plan-secret/)
      assert.match(plan, /without running project code/)
      assert.match(plan, /does not verify where the installed .* package came from/)
      assert.match(plan, /Run the approved validation command/)
      assert.doesNotMatch(plan, /not user-visible merely because it appeared in tool output/)
      assert.doesNotMatch(plan, /Never send only an approval question/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('renders local candidates separately when identical argv has different execution settings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-command-shape-'))
    const packageRoot = path.join(root, 'package')
    const commandArgv = [process.execPath, '-e', 'console.log("Tests: 1 passed, 1 total")']
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'generated.test.js'),
      path.join(root, '.retry-state')
    )
    const directCommand = {
      cwd: root,
      argv: commandArgv,
      env: { SAFE_MODE: 'direct' },
    }
    const fallbackCommand = {
      cwd: packageRoot,
      argv: commandArgv,
      env: { SAFE_MODE: 'fallback' },
    }
    framework.existingTestCommand = directCommand
    framework.localTestCandidates = [
      { command: directCommand, maxTestCount: 1, sourceFile: path.join(root, 'direct.test.js') },
      { command: fallbackCommand, maxTestCount: 1, sourceFile: path.join(root, 'fallback.test.js') },
    ]
    fs.mkdirSync(packageRoot)

    try {
      const plan = formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
        requestedScenario: 'basic-reporting',
      })
      const renderedCommand = process.platform === 'win32'
        ? 'node -e "console.log(\\"Tests: 1 passed, 1 total\\")"'
        : String.raw`node -e 'console.log("Tests: 1 passed, 1 total")'`

      assert.strictEqual(countOccurrences(plan, renderedCommand), 4)
      assert.match(plan, /SAFE_MODE=direct/)
      assert.match(plan, /SAFE_MODE=fallback/)
      assert.match(plan, /Working directory: `package`/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses a short validator command for a standard node_modules installation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-short-plan-'))
    const directValidator = path.join(root, 'node_modules', 'dd-trace', 'ci', 'validate-test-optimization.js')
    const installedValidator = path.resolve(__dirname, '../../../../ci/validate-test-optimization.js')
    fs.mkdirSync(path.dirname(directValidator), { recursive: true })
    fs.symlinkSync(installedValidator, directValidator)

    try {
      const plan = formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      })

      assert.match(plan, /node node_modules\/dd-trace\/ci\/validate-test-optimization\.js/)
      assert.match(plan, /--run-approved-plan dd-test-optimization-validation-results\/approval\.json/)
      assert.match(plan, /--sha256 [a-f0-9]{64}/)
      assert.doesNotMatch(plan, /--manifest|--out|\.pnpm/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an approval plan whose structured command executable is unavailable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-unavailable-plan-'))
    const generatedFile = path.join(root, 'tests', 'dd-test-optimization-validation.test.js')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-validation-state'))
    framework.existingTestCommand = {
      cwd: root,
      argv: ['definitely-not-an-installed-test-runner', 'test'],
    }

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      }), /Cannot render an approvable plan.*definitely-not-an-installed-test-runner.*not available/s)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves Windows executable names that already include a PATHEXT extension', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-windows-executable-'))
    const executable = path.join(root, 'npm.cmd')
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    fs.writeFileSync(executable, '')
    fs.chmodSync(executable, 0o755)

    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      const command = {
        cwd: root,
        argv: ['npm.cmd', 'test'],
        env: { PATH: root },
      }

      assert.strictEqual(getUnavailableExecutable(command), undefined)
      assert.strictEqual(getResolvedExecutable(command), executable)
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves relative PATH entries from the command working directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-relative-path-'))
    const bin = path.join(root, 'node_modules', '.bin')
    const executable = path.join(bin, 'test-runner')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(executable, '')
    fs.chmodSync(executable, 0o755)

    try {
      const command = {
        cwd: root,
        argv: ['test-runner'],
        env: { PATH: path.join('node_modules', '.bin') },
      }

      assert.strictEqual(getUnavailableExecutable(command), undefined)
      assert.strictEqual(getResolvedExecutable(command), executable)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not fall back to the host PATH when the command PATH is empty', () => {
    const command = {
      cwd: process.cwd(),
      argv: [path.basename(process.execPath)],
      env: { PATH: '' },
    }

    assert.strictEqual(getUnavailableExecutable(command), path.basename(process.execPath))
    assert.strictEqual(getResolvedExecutable(command), undefined)
  })

  it('detects an executable replaced after approval before it can be spawned', async function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-executable-approval-'))
    const bin = path.join(root, 'bin')
    const executable = path.join(bin, 'test-runner')
    const marker = path.join(root, 'changed-executable-ran')
    const out = path.join(root, 'results')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: ['test-runner'],
      env: { PATH: bin },
    }
    const manifest = {
      __path: path.join(root, 'manifest.json'),
      repository: { root },
      frameworks: [framework],
    }
    fs.mkdirSync(bin)
    fs.mkdirSync(out)
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    try {
      formatExecutionPlan({ manifest, out, requestedScenario: 'basic-reporting' })
      fs.writeFileSync(executable, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 })

      assert.throws(() => getExecutableForSpawn(framework.existingTestCommand), /changed after approval/)
      const result = await runCommand(
        framework.existingTestCommand,
        { artifactRoot: out, outDir: path.join(out, 'run'), repositoryRoot: root }
      )
      assert.match(result.stderr, /changed after approval/)
      assert.strictEqual(fs.existsSync(marker), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('fingerprints an env-wrapped command target and rejects its replacement after approval', function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-env-target-'))
    const bin = path.join(root, 'bin')
    const target = path.join(bin, 'test-runner')
    const out = path.join(root, 'results')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: ['/usr/bin/env', `PATH=${bin}`, 'test-runner'],
    }
    const manifest = {
      __path: path.join(root, 'manifest.json'),
      repository: { root },
      frameworks: [framework],
    }
    fs.mkdirSync(bin)
    fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    try {
      const canonicalTarget = fs.realpathSync(target)
      const plan = formatExecutionPlan({ manifest, out, requestedScenario: 'basic-reporting' })
      const approval = JSON.parse(fs.readFileSync(path.join(out, 'approval.json'), 'utf8'))
      const basicReporting = approval.executables.find(entry => entry.label.endsWith(':basic-reporting'))
      const checksums = fs.readFileSync(path.join(out, 'approval-files.sha256'), 'utf8')

      assert.strictEqual(basicReporting.delegated.length, 1)
      assert.strictEqual(basicReporting.delegated[0].path, canonicalTarget)
      assert.match(checksums, new RegExp(escapeRegExp(canonicalTarget)))
      assert.match(plan, new RegExp('test-runner: `' + escapeRegExp(target) + '`'))
      assert.strictEqual(getExecutableForSpawn(framework.existingTestCommand).path, fs.realpathSync('/usr/bin/env'))

      fs.writeFileSync(target, '#!/bin/sh\nexit 42\n', { mode: 0o755 })

      assert.throws(() => getExecutableForSpawn(framework.existingTestCommand), /changed after approval/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves executable approval on a derived local Jest command', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-derived-jest-'))
    const executable = path.join(root, 'jest')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: [executable],
    }
    const manifest = {
      __path: path.join(root, 'manifest.json'),
      repository: { root },
      frameworks: [framework],
    }
    fs.writeFileSync(executable, 'approved executable', { mode: 0o755 })

    try {
      formatExecutionPlan({ manifest, out: path.join(root, 'results'), requestedScenario: 'basic-reporting' })
      fs.writeFileSync(executable, 'changed executable', { mode: 0o755 })

      assert.throws(
        () => getExecutableForSpawn(getLocalValidationCommand(framework, framework.existingTestCommand)),
        /changed after approval/
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves approved named-shim semantics while executing the canonical target', async function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-named-shim-'))
    const bin = path.join(root, 'bin')
    const shim = path.join(bin, 'yarn')
    const marker = path.join(root, 'named-shim-ran')
    const out = path.join(root, 'results')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: [
        'yarn',
        '-e',
        'if (require(\'node:path\').basename(process.argv0) !== \'yarn\') process.exit(126); ' +
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'named-shim')`,
      ],
      env: { PATH: bin },
    }
    const manifest = {
      __path: path.join(root, 'manifest.json'),
      repository: { root },
      frameworks: [framework],
    }
    fs.mkdirSync(bin)
    fs.mkdirSync(out)
    fs.symlinkSync(process.execPath, shim)

    try {
      const plan = formatExecutionPlan({ manifest, out, requestedScenario: 'basic-reporting' })
      const result = await runCommand(
        framework.existingTestCommand,
        { artifactRoot: out, outDir: path.join(out, 'run'), repositoryRoot: root }
      )

      assert.strictEqual(result.exitCode, 0, result.stderr)
      assert.strictEqual(fs.existsSync(marker), true)
      assert.deepStrictEqual(getExecutableForSpawn(framework.existingTestCommand), {
        argv0: shim,
        path: fs.realpathSync(process.execPath),
      })
      assert.match(plan, new RegExp('Yarn: `' + escapeRegExp(shim) + '`.*verified target', 's'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves a Windows shim invocation path after verifying its canonical target', function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-windows-shim-'))
    const shim = path.join(root, 'test-runner.cmd')
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

    try {
      fs.symlinkSync(process.execPath, shim)
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

      assert.deepStrictEqual(getExecutableForSpawn({
        cwd: root,
        argv: [shim],
      }), {
        argv0: shim,
        path: shim,
      })
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves Windows forward-slash relative executable paths consistently for planning and execution', () => {
    assert.strictEqual(isExplicitExecutablePath('./node_modules/.bin/jest.cmd', 'win32'), true)
    assert.strictEqual(isExplicitExecutablePath('.\\node_modules\\.bin\\jest.cmd', 'win32'), true)
    assert.strictEqual(isExplicitExecutablePath('.\\node_modules\\.bin\\jest.cmd', 'linux'), false)

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-windows-relative-executable-'))
    const bin = path.join(root, 'node_modules', '.bin')
    const executable = path.join(bin, 'jest.cmd')
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: ['./node_modules/.bin/jest.cmd'],
    }
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(executable, '')
    fs.chmodSync(executable, 0o755)

    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
        requestedScenario: 'basic-reporting',
      })

      assert.strictEqual(getResolvedExecutable(framework.existingTestCommand), executable)
      assert.deepStrictEqual(getExecutableForSpawn(framework.existingTestCommand), {
        argv0: executable,
        path: executable,
      })
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects ambient Yarn when the repository pins a Yarn release', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-yarn-plan-'))
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = { cwd: root, argv: ['yarn', 'test'] }
    fs.mkdirSync(path.join(root, '.yarn', 'releases'), { recursive: true })
    fs.writeFileSync(path.join(root, '.yarn', 'releases', 'yarn-4.4.1.cjs'), '')

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      }), /uses bare "yarn".*repository pins \.yarn\/releases\/yarn-4\.4\.1\.cjs/s)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects ambient Yarn when package.json requires modern Yarn', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-yarn-plan-'))
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = { cwd: root, argv: ['yarn', 'test'] }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.10.0' }))

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      }), /uses bare "yarn".*package\.json requires yarn@4\.10\.0.*explicit Corepack command/s)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a Jest config that references a missing local build input', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-jest-input-plan-'))
    const projectRoot = path.join(root, 'packages', 'eslint-plugin')
    const configFile = path.join(projectRoot, 'jest.config.js')
    const missingInput = path.join(root, 'compiler', 'dist', 'index.js')
    const framework = getPlannedFramework(
      root,
      path.join(projectRoot, '__tests__', 'dd-test-optimization-validation.test.js'),
      path.join(projectRoot, '.dd-validation-state')
    )
    framework.project = { root: projectRoot, configFiles: [configFile] }
    fs.mkdirSync(projectRoot, { recursive: true })
    fs.writeFileSync(configFile, `module.exports = {
      coverageDirectory: '<rootDir>/coverage',
      moduleNameMapper: { '^compiler$': '<rootDir>/../../compiler/dist/index.js' }
    }\n`)

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      }), new RegExp(`Jest config .* references missing local input ${escapeRegExp(missingInput)}`))

      fs.mkdirSync(path.dirname(missingInput), { recursive: true })
      fs.writeFileSync(missingInput, 'module.exports = {}\n')
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a selected test whose bounded local import chain reaches missing build output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-local-import-plan-'))
    const testFile = path.join(root, 'spec', 'unit.test.ts')
    const helperFile = path.join(root, 'src', 'helper.ts')
    const packageJson = path.join(root, 'package.json')
    const missingBuildOutput = path.join(root, 'dist', 'core')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'spec', 'dd-test-optimization-validation.test.ts'),
      path.join(root, '.dd-validation-state')
    )
    framework.project = { root, packageJson, configFiles: [] }
    framework.existingTestCommand = {
      cwd: root,
      argv: [process.execPath, testFile],
    }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.mkdirSync(path.dirname(helperFile), { recursive: true })
    fs.writeFileSync(packageJson, JSON.stringify({ name: 'local-import-project' }))
    fs.writeFileSync(testFile, "import '../src/helper'\n")
    fs.writeFileSync(helperFile, "export { default } from '../dist/core'\n")

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      }), new RegExp(`bounded local import chain .* reaches missing module ${escapeRegExp(missingBuildOutput)}`))

      framework.setup = {
        commands: [{
          id: 'build',
          cwd: root,
          argv: [process.execPath, '-e', 'process.exit(0)'],
          outputPaths: [path.join(root, 'dist')],
        }],
      }
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats an existing relative asset import as a resolved leaf', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-local-asset-plan-'))
    const testFile = path.join(root, 'test', 'unit.test.js')
    const assetFile = path.join(root, 'test', 'style.css')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'test', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: [process.execPath, testFile],
    }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(testFile, "import './style.css'\n")
    fs.writeFileSync(assetFile, '.example { color: red; }\n')

    try {
      const manifest = {
        __path: path.join(root, 'manifest.json'),
        repository: { root },
        frameworks: [framework],
      }
      formatExecutionPlan({ manifest, out: path.join(root, 'results'), requestedScenario: 'basic-reporting' })

      fs.rmSync(assetFile)
      assert.throws(() => formatExecutionPlan({
        manifest,
        out: path.join(root, 'missing-results'),
        requestedScenario: 'basic-reporting',
      }), /reaches missing module .*style\.css/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not validate generated-test contracts for non-advanced scenario plans', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-scenario-contract-plan-'))
    const framework = getPlannedFramework(
      root,
      path.join(root, 'test', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.generatedTestStrategy.files[0].contentLines = ['tampered generated source']
    const manifest = {
      __path: path.join(root, 'manifest.json'),
      repository: { root },
      frameworks: [framework],
    }

    try {
      formatExecutionPlan({
        manifest,
        out: path.join(root, 'basic-results'),
        requestedScenario: 'basic-reporting',
      })
      formatExecutionPlan({
        manifest,
        out: path.join(root, 'ci-results'),
        requestedScenario: 'ci-wiring',
      })
      assert.throws(() => formatExecutionPlan({
        manifest,
        out: path.join(root, 'all-results'),
      }), /scenario basic-pass source differs/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts cwd-relative generated test paths in structured and shell commands', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-relative-generated-path-'))
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))

    try {
      for (const scenario of framework.generatedTestStrategy.scenarios) {
        const filename = scenario.testIdentities[0].file
        scenario.runCommand.argv = scenario.runCommand.argv.map(value => {
          return value === filename ? path.relative(scenario.runCommand.cwd, filename) : value
        })
      }
      assert.strictEqual(getGeneratedTestContractError(framework), undefined)

      for (const scenario of framework.generatedTestStrategy.scenarios) {
        const filename = scenario.testIdentities[0].file
        scenario.runCommand = {
          cwd: root,
          usesShell: true,
          shellCommand: `node --runTestsByPath="${path.relative(root, filename)}"`,
        }
      }
      assert.strictEqual(getGeneratedTestContractError(framework), undefined)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires one usable self-package entrypoint before approving a self-importing test', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-self-import-plan-'))
    const testFile = path.join(root, '__tests__', 'unit.js')
    const sourceEntrypoint = path.join(root, 'src', 'index.js')
    const packageJson = path.join(root, 'package.json')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'test', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.project = { root, packageJson, configFiles: [] }
    framework.existingTestCommand = {
      cwd: root,
      argv: [process.execPath, testFile],
    }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.mkdirSync(path.dirname(sourceEntrypoint), { recursive: true })
    fs.writeFileSync(packageJson, JSON.stringify({
      name: 'self-import-project',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './src/index.js',
        },
      },
    }))
    fs.writeFileSync(testFile, "import 'self-import-project'\n")
    fs.writeFileSync(sourceEntrypoint, 'export default true\n')

    const formatPlan = () => formatExecutionPlan({
      manifest: {
        __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
        repository: { root },
        frameworks: [framework],
      },
      out: path.join(root, 'dd-test-optimization-validation-results'),
    })

    try {
      formatPlan()
      fs.rmSync(sourceEntrypoint)
      assert.throws(formatPlan, /imports its own package subpath "self-import-project".*entrypoint .* does not exist/s)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires the first runtime target in a package export array', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-ordered-export-plan-'))
    const testFile = path.join(root, 'test', 'unit.test.js')
    const missingEntrypoint = path.join(root, 'dist', 'missing.js')
    const laterEntrypoint = path.join(root, 'dist', 'index.js')
    const packageJson = path.join(root, 'package.json')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.project = { root, packageJson, configFiles: [] }
    framework.existingTestCommand = { cwd: root, argv: [process.execPath, testFile] }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.mkdirSync(path.dirname(laterEntrypoint), { recursive: true })
    fs.writeFileSync(packageJson, JSON.stringify({
      name: 'ordered-export-project',
      exports: ['./dist/missing.js', './dist/index.js'],
    }))
    fs.writeFileSync(testFile, "require('ordered-export-project')\n")
    fs.writeFileSync(laterEntrypoint, 'module.exports = true\n')

    try {
      const formatPlan = () => formatFrameworkPlan(root, framework)
      assert.throws(formatPlan, new RegExp(`entrypoint ${escapeRegExp(missingEntrypoint)} does not exist`))
      fs.writeFileSync(missingEntrypoint, 'module.exports = true\n')
      formatPlan()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips the Vitest runner path when checking the selected test', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-runner-plan-'))
    const testFile = path.join(root, 'test', 'unit.test.js')
    const packageJson = path.join(root, 'package.json')
    const missingEntrypoint = path.join(root, 'dist', 'index.js')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    setGeneratedTestFramework(framework, 'vitest')
    framework.project = { root, packageJson, configFiles: [] }
    framework.existingTestCommand = {
      cwd: root,
      argv: [process.execPath, path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', testFile],
    }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(packageJson, JSON.stringify({
      name: 'vitest-runner-project',
      exports: './dist/index.js',
    }))
    fs.writeFileSync(testFile, "require('vitest-runner-project')\n")

    try {
      assert.throws(
        () => formatFrameworkPlan(root, framework),
        new RegExp(`entrypoint ${escapeRegExp(missingEntrypoint)} does not exist`)
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores non-runtime package export conditions when checking self imports', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-runtime-export-plan-'))
    const testFile = path.join(root, 'test', 'unit.test.js')
    const typeDeclaration = path.join(root, 'dist', 'index.d.ts')
    const missingEntrypoint = path.join(root, 'dist', 'index.js')
    const packageJson = path.join(root, 'package.json')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.project = { root, packageJson, configFiles: [] }
    framework.existingTestCommand = { cwd: root, argv: [process.execPath, testFile] }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.mkdirSync(path.dirname(typeDeclaration), { recursive: true })
    fs.writeFileSync(packageJson, JSON.stringify({
      name: 'runtime-export-project',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
        },
      },
    }))
    fs.writeFileSync(testFile, "import 'runtime-export-project'\n")
    fs.writeFileSync(typeDeclaration, 'export declare const value: true\n')

    try {
      assert.throws(
        () => formatFrameworkPlan(root, framework),
        new RegExp(`entrypoint ${escapeRegExp(missingEntrypoint)} does not exist`)
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores module references in comments and unrelated strings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-commented-import-plan-'))
    const testFile = path.join(root, 'test', 'unit.test.js')
    const packageJson = path.join(root, 'package.json')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.project = { root, packageJson, configFiles: [] }
    framework.existingTestCommand = { cwd: root, argv: [process.execPath, testFile] }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(packageJson, JSON.stringify({
      name: 'commented-import-project',
      exports: './dist/index.js',
    }))
    fs.writeFileSync(testFile, [
      "// require('commented-import-project')",
      "/* import './missing-build-output' */",
      'const example = "require(\'./also-missing\')"',
      '',
    ].join('\n'))

    try {
      formatFrameworkPlan(root, framework)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores type-only module references when checking runtime prerequisites', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-type-only-import-plan-'))
    const testFile = path.join(root, 'test', 'unit.test.ts')
    const packageJson = path.join(root, 'package.json')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.project = { root, packageJson, configFiles: [] }
    framework.existingTestCommand = { cwd: root, argv: [process.execPath, testFile] }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(packageJson, JSON.stringify({
      name: 'type-only-project',
      exports: './dist/index.js',
    }))
    fs.writeFileSync(testFile, [
      "import type { Input } from 'type-only-project'",
      "import { type InlineInput } from 'type-only-project/inline'",
      "export type { Output } from '../missing-types'",
      "export { type InlineOutput } from '../also-missing-types'",
      'export const value = true',
      '',
    ].join('\n'))

    try {
      formatFrameworkPlan(root, framework)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('checks runtime imports mixed with inline type specifiers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-mixed-type-import-plan-'))
    const testFile = path.join(root, 'test', 'unit.test.ts')
    const packageJson = path.join(root, 'package.json')
    const missingEntrypoint = path.join(root, 'dist', 'index.js')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.project = { root, packageJson, configFiles: [] }
    framework.existingTestCommand = { cwd: root, argv: [process.execPath, testFile] }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(packageJson, JSON.stringify({
      name: 'mixed-type-project',
      exports: './dist/index.js',
    }))
    fs.writeFileSync(testFile, "import { type Input, runtimeValue } from 'mixed-type-project'\n")

    try {
      assert.throws(
        () => formatFrameworkPlan(root, framework),
        new RegExp(`entrypoint ${escapeRegExp(missingEntrypoint)} does not exist`)
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  for (const condition of ['import', 'require']) {
    it(`requires the package export selected by ${condition} syntax`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-conditional-export-plan-'))
      const testFile = path.join(root, 'test', 'unit.test.js')
      const packageJson = path.join(root, 'package.json')
      const existingCondition = condition === 'import' ? 'require' : 'import'
      const existingEntrypoint = path.join(root, 'src', `${existingCondition}.js`)
      const missingEntrypoint = path.join(root, 'dist', `${condition}.js`)
      const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
      framework.project = { root, packageJson, configFiles: [] }
      framework.existingTestCommand = { cwd: root, argv: [process.execPath, testFile] }
      fs.mkdirSync(path.dirname(testFile), { recursive: true })
      fs.mkdirSync(path.dirname(existingEntrypoint), { recursive: true })
      fs.writeFileSync(packageJson, JSON.stringify({
        name: 'conditional-export-project',
        exports: {
          '.': {
            [condition]: `./dist/${condition}.js`,
            [existingCondition]: `./src/${existingCondition}.js`,
          },
        },
      }))
      fs.writeFileSync(testFile, condition === 'import'
        ? "import 'conditional-export-project'\n"
        : "require('conditional-export-project')\n")
      fs.writeFileSync(existingEntrypoint, 'module.exports = true\n')

      try {
        assert.throws(
          () => formatFrameworkPlan(root, framework),
          new RegExp(`entrypoint ${escapeRegExp(missingEntrypoint)} does not exist`)
        )
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('requires wildcard self-package exports to exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-wildcard-export-plan-'))
    const testFile = path.join(root, 'test', 'unit.test.js')
    const packageJson = path.join(root, 'package.json')
    const entrypoint = path.join(root, 'dist', 'feature.js')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.project = { root, packageJson, configFiles: [] }
    framework.existingTestCommand = { cwd: root, argv: [process.execPath, testFile] }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(packageJson, JSON.stringify({
      name: 'wildcard-export-project',
      exports: { './*': './dist/*.js' },
    }))
    fs.writeFileSync(testFile, "require('wildcard-export-project/feature')\n")

    try {
      const formatPlan = () => formatFrameworkPlan(root, framework)
      assert.throws(formatPlan, new RegExp(`entrypoint ${escapeRegExp(entrypoint)} does not exist`))
      fs.mkdirSync(path.dirname(entrypoint), { recursive: true })
      fs.writeFileSync(entrypoint, 'module.exports = true\n')
      formatPlan()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires legacy self-package subpaths without an exports map to exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-legacy-subpath-plan-'))
    const testFile = path.join(root, 'test', 'unit.test.js')
    const packageJson = path.join(root, 'package.json')
    const entrypoint = path.join(root, 'dist', 'index.js')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.project = { root, packageJson, configFiles: [] }
    framework.existingTestCommand = { cwd: root, argv: [process.execPath, testFile] }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(packageJson, JSON.stringify({ name: 'legacy-subpath-project' }))
    fs.writeFileSync(testFile, "require('legacy-subpath-project/dist/index')\n")

    try {
      const formatPlan = () => formatFrameworkPlan(root, framework)
      assert.throws(formatPlan, /imports its own package subpath .*entrypoint .* does not exist/s)
      fs.mkdirSync(path.dirname(entrypoint), { recursive: true })
      fs.writeFileSync(entrypoint, 'module.exports = true\n')
      formatPlan()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('checks the selected test instead of a Jest option value', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-jest-option-path-plan-'))
    const configFile = path.join(root, 'jest.config.test.js')
    const testFile = path.join(root, 'test', 'unit.test.js')
    const packageJson = path.join(root, 'package.json')
    const missingEntrypoint = path.join(root, 'dist', 'index.js')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.project = { root, packageJson, configFiles: [configFile] }
    framework.existingTestCommand = {
      cwd: root,
      argv: [process.execPath, 'jest.js', '--config', configFile, testFile],
    }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(configFile, 'module.exports = {}\n')
    fs.writeFileSync(packageJson, JSON.stringify({
      name: 'option-path-project',
      exports: './dist/index.js',
    }))
    fs.writeFileSync(testFile, "require('option-path-project')\n")

    try {
      assert.throws(
        () => formatFrameworkPlan(root, framework),
        new RegExp(`entrypoint ${escapeRegExp(missingEntrypoint)} does not exist`)
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts extensionless imports of existing native addons', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-native-addon-plan-'))
    const testFile = path.join(root, 'test', 'unit.test.js')
    const nativeAddon = path.join(root, 'build', 'Release', 'addon.node')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.project = { root, configFiles: [] }
    framework.existingTestCommand = { cwd: root, argv: [process.execPath, testFile] }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.mkdirSync(path.dirname(nativeAddon), { recursive: true })
    fs.writeFileSync(testFile, "require('../build/Release/addon')\n")
    fs.writeFileSync(nativeAddon, '')

    try {
      formatFrameworkPlan(root, framework)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  for (const packageField of ['exports', 'main']) {
    it(`resolves local package directories through package.json ${packageField}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-local-package-plan-'))
      const testFile = path.join(root, 'test', 'unit.test.js')
      const packageRoot = path.join(root, 'fixtures', 'pkg')
      const entrypoint = path.join(packageRoot, 'main.js')
      const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
      framework.project = { root, configFiles: [] }
      framework.existingTestCommand = { cwd: root, argv: [process.execPath, testFile] }
      fs.mkdirSync(path.dirname(testFile), { recursive: true })
      fs.mkdirSync(packageRoot, { recursive: true })
      fs.writeFileSync(testFile, "require('../fixtures/pkg')\n")
      fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify(
        packageField === 'main' ? { main: 'main.js' } : { exports: { '.': { require: './main.js' } } }
      ))
      fs.writeFileSync(entrypoint, 'module.exports = true\n')

      try {
        formatFrameworkPlan(root, framework)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('resolves local package directories with the importing module condition', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-local-package-condition-plan-'))
    const testFile = path.join(root, 'test', 'unit.test.mjs')
    const packageRoot = path.join(root, 'fixtures', 'pkg')
    const existingRequireEntrypoint = path.join(packageRoot, 'src', 'index.cjs')
    const missingImportEntrypoint = path.join(packageRoot, 'dist', 'index.mjs')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.mjs'))
    framework.project = { root, configFiles: [] }
    framework.existingTestCommand = { cwd: root, argv: [process.execPath, testFile] }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.mkdirSync(path.dirname(existingRequireEntrypoint), { recursive: true })
    fs.writeFileSync(testFile, "import '../fixtures/pkg'\n")
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      exports: {
        '.': {
          import: './dist/index.mjs',
          require: './src/index.cjs',
        },
      },
    }))
    fs.writeFileSync(existingRequireEntrypoint, 'module.exports = true\n')

    try {
      assert.throws(() => formatFrameworkPlan(root, framework), new RegExp(
        `reaches missing module ${escapeRegExp(missingImportEntrypoint)}`
      ))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a transitive self-package subpath whose exported build output is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-transitive-self-import-plan-'))
    const testFile = path.join(root, 'test', 'hash.test.ts')
    const sourceFile = path.join(root, 'src', 'hash.ts')
    const packageJson = path.join(root, 'package.json')
    const missingEntrypoint = path.join(root, 'dist', 'crypto.mjs')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.ts'))
    framework.project = { root, packageJson, configFiles: [] }
    framework.existingTestCommand = { cwd: root, argv: [process.execPath, testFile] }
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true })
    fs.writeFileSync(packageJson, JSON.stringify({
      name: 'ohash',
      exports: { './crypto': './dist/crypto.mjs' },
    }))
    fs.writeFileSync(testFile, "import { hash } from '../src/hash'\n")
    fs.writeFileSync(sourceFile, "export { digest as hash } from 'ohash/crypto'\n")

    try {
      const sourceRelative = path.relative(root, sourceFile)
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      }), new RegExp(
        `bounded import chain .*${escapeRegExp(sourceRelative)}.*ohash/crypto.*${escapeRegExp(missingEntrypoint)}`,
        's'
      ))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects agent-authored generated source before rendering an approval plan', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-generated-contract-'))
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    const atrFile = framework.generatedTestStrategy.files.find(file => file.path.includes('atr-fail-once'))
    atrFile.contentLines = [
      'let attempts = 0',
      "test('atr-fail-once', () => { if (attempts++ === 0) throw new Error('first') })",
    ]

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      }), /atr-fail-once source differs from the validator-owned jest recipe/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects generated cleanup paths that disagree with the validator-owned recipe', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-generated-cleanup-contract-'))
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.generatedTestStrategy.cleanupPaths.push(path.join(root, 'src'))

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      }), /clean up exactly those files plus the persistent ATR state file/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects generated tests outside the project root before rendering an approval plan', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-generated-root-contract-'))
    const projectRoot = path.join(root, 'packages', 'app')
    const originalFile = path.join(projectRoot, 'test', 'dd-validation.test.js')
    const outsideFile = path.join(root, 'test', 'dd-validation.test.js')
    const framework = getPlannedFramework(projectRoot, originalFile)
    framework.project.root = projectRoot
    const file = framework.generatedTestStrategy.files[0]
    const scenario = framework.generatedTestStrategy.scenarios[0]
    file.path = outsideFile
    scenario.testIdentities[0].file = outsideFile
    scenario.runCommand.argv = scenario.runCommand.argv.map(value => value === originalFile ? outsideFile : value)
    framework.generatedTestStrategy.cleanupPaths = framework.generatedTestStrategy.cleanupPaths
      .map(value => value === originalFile ? outsideFile : value)

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      }), /scenario basic-pass file must remain inside project root/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  for (const [property, value] of [
    ['testMatch', '["**/*-test.js"]'],
    ['testRegex', '"-test\\\\.js$"'],
    ['"testMatch"', '["**/*-test.js"]'],
    ["'testRegex'", '/-test\\.js$/'],
  ]) {
    const propertyName = property.replaceAll(/['"]/g, '')
    it(`rejects generated Jest tests outside literal ${property} rules`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-jest-path-plan-'))
      const configFile = path.join(root, 'jest.config.js')
      const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
      framework.project.configFiles = [configFile]
      fs.writeFileSync(configFile, `module.exports = { ${property}: ${value} }\n`)

      try {
        assert.throws(() => formatExecutionPlan({
          manifest: {
            __path: path.join(root, 'manifest.json'),
            repository: { root },
            frameworks: [framework],
          },
          out: path.join(root, 'results'),
        }), new RegExp(`does not match the literal Jest ${propertyName} patterns`))
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('uses an explicit Jest -c config before package.json collection rules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-explicit-jest-config-plan-'))
    const configFile = path.join(root, 'jest.validation.config.js')
    const packageJson = path.join(root, 'package.json')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.project.packageJson = packageJson
    framework.project.configFiles = []
    for (const scenario of framework.generatedTestStrategy.scenarios) {
      scenario.runCommand.argv.push('-c', configFile)
    }
    fs.writeFileSync(packageJson, JSON.stringify({ jest: { testMatch: ['**/*-test.js'] } }))
    fs.writeFileSync(configFile, 'module.exports = { testMatch: ["**/*.js"] }\n')

    try {
      formatFrameworkPlan(root, framework)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts generated Jest tests matched by common extglobs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-jest-extglob-plan-'))
    const configFile = path.join(root, 'jest.config.js')
    const generatedFile = path.join(root, 'test', 'dd-validation.test.js')
    const framework = getPlannedFramework(root, generatedFile)
    framework.project.configFiles = [configFile]
    framework.generatedTestStrategy.files = [{ path: generatedFile }]
    fs.writeFileSync(configFile, 'module.exports = { testMatch: ["**/?(*.)+(spec|test).[jt]s?(x)"] }\n')

    try {
      assert.strictEqual(getCommandSuitabilityError({
        command: framework.generatedTestStrategy.scenarios[0].runCommand,
        framework,
        label: 'the basic-pass advanced-feature command',
        repositoryRoot: root,
      }), undefined)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('applies package.json Jest rootDir when checking generated paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-package-jest-root-plan-'))
    const generatedFile = path.join(root, 'src', '__tests__', 'dd-validation.test.js')
    const packageJson = path.join(root, 'package.json')
    const framework = getPlannedFramework(root, generatedFile)
    framework.project.packageJson = packageJson
    fs.writeFileSync(packageJson, JSON.stringify({
      jest: {
        rootDir: 'src',
        testMatch: ['<rootDir>/__tests__/*.js'],
      },
    }))

    try {
      formatFrameworkPlan(root, framework)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('applies a quoted Jest rootDir when checking generated paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-quoted-jest-root-plan-'))
    const configFile = path.join(root, 'jest.config.js')
    const generatedFile = path.join(root, 'src', '__tests__', 'dd-validation.test.js')
    const framework = getPlannedFramework(root, generatedFile)
    framework.project.configFiles = [configFile]
    fs.writeFileSync(configFile, [
      'module.exports = {',
      '  "rootDir": "src",',
      '  testMatch: ["<rootDir>/__tests__/*.js"],',
      '}',
      '',
    ].join('\n'))

    try {
      formatFrameworkPlan(root, framework)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores commented Jest testRegex rules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-commented-jest-regex-plan-'))
    const configFile = path.join(root, 'jest.config.js')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.project.configFiles = [configFile]
    fs.writeFileSync(configFile, [
      'module.exports = {',
      '  // testRegex: /-test\\.js$/,',
      '  testMatch: ["**/*.js"],',
      '}',
      '',
    ].join('\n'))

    try {
      formatFrameworkPlan(root, framework)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores Jest regex examples inside string literals', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-string-jest-regex-plan-'))
    const configFile = path.join(root, 'jest.config.js')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.project.configFiles = [configFile]
    fs.writeFileSync(configFile, [
      'const example = "testRegex: /-test\\\\.js$/"',
      'module.exports = { testMatch: ["**/*.js"] }',
      '',
    ].join('\n'))

    try {
      formatFrameworkPlan(root, framework)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('unescapes string-valued Jest testRegex rules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-string-jest-regex-plan-'))
    const configFile = path.join(root, 'jest.config.js')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.project.configFiles = [configFile]
    fs.writeFileSync(configFile, "module.exports = { testRegex: '.*\\\\.test(?:-[^.]+)?\\\\.js$' }\n")

    try {
      formatFrameworkPlan(root, framework)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects generated Jest tests outside the configured rootDir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-jest-root-plan-'))
    const configFile = path.join(root, 'jest.config.js')
    const framework = getPlannedFramework(root, path.join(root, 'test', 'dd-validation.test.js'))
    framework.project.configFiles = [configFile]
    fs.writeFileSync(configFile, [
      'module.exports = {',
      '  rootDir: "src",',
      '  testMatch: ["<rootDir>/**/*.test.js"],',
      '}',
      '',
    ].join('\n'))

    try {
      assert.throws(
        () => formatFrameworkPlan(root, framework),
        new RegExp(`temporary test path .* outside rootDir ${escapeRegExp(path.join(root, 'src'))}`, 's')
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a pnpm script separator that reaches Jest arguments', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-pnpm-forwarding-'))
    const command = {
      cwd: root,
      argv: ['pnpm', 'run', 'test:lib', '--', '--runTestsByPath', 'test/unit-test.ts'],
    }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'test:lib': 'jest' } }))

    try {
      assert.deepStrictEqual(getPackageScriptExpansion(command, root), {
        effectiveCommand: 'jest -- --runTestsByPath test/unit-test.ts',
        forwardedArgs: ['--', '--runTestsByPath', 'test/unit-test.ts'],
        packageManager: 'pnpm',
        script: 'jest',
        scriptName: 'test:lib',
      })
      assert.match(getCommandSuitabilityError({
        command,
        framework: { framework: 'jest', project: { root, configFiles: [] } },
        label: 'the CI test command',
        repositoryRoot: root,
      }), /literal extra "--".*append focused runner arguments directly/s)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  for (const packageManager of ['pnpm', 'yarn']) {
    it(`rejects a Corepack ${packageManager} script separator`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-corepack-forwarding-'))
      const command = {
        cwd: root,
        argv: ['corepack', packageManager, 'run', 'test:lib', '--', '--runTestsByPath', 'test/unit-test.ts'],
      }
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'test:lib': 'jest' } }))

      try {
        const forwardedArgs = ['--', '--runTestsByPath', 'test/unit-test.ts']
        assert.deepStrictEqual(getPackageScriptExpansion(command, root), {
          effectiveCommand: ['jest', ...forwardedArgs].join(' '),
          forwardedArgs,
          packageManager,
          script: 'jest',
          scriptName: 'test:lib',
        })
        const error = getCommandSuitabilityError({
          command,
          framework: { framework: 'jest', project: { root, configFiles: [] } },
          label: 'the CI test command',
          repositoryRoot: root,
        })
        assert.match(error, /literal extra "--".*append focused runner arguments directly/s)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  for (const [packageManager, argv] of [
    ['pnpm', ['pnpm', 'test:lib', '--', '--runTestsByPath', 'test/unit-test.ts']],
    ['pnpm', ['corepack', 'pnpm', 'test:lib', '--', '--runTestsByPath', 'test/unit-test.ts']],
    ['yarn', ['yarn', 'test:lib', '--', '--runTestsByPath', 'test/unit-test.ts']],
  ]) {
    it(`rejects a separator forwarded by ${argv.slice(0, -4).join(' ')} script shorthand`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-script-shorthand-forwarding-'))
      const command = { cwd: root, argv }
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'test:lib': 'jest' } }))

      try {
        assert.deepStrictEqual(getPackageScriptExpansion(command, root), {
          effectiveCommand: 'jest -- --runTestsByPath test/unit-test.ts',
          forwardedArgs: ['--', '--runTestsByPath', 'test/unit-test.ts'],
          packageManager,
          script: 'jest',
          scriptName: 'test:lib',
        })
        assert.match(getCommandSuitabilityError({
          command,
          framework: { framework: 'jest', project: { root, configFiles: [] } },
          label: 'the CI test command',
          repositoryRoot: root,
        }), /literal extra "--".*append focused runner arguments directly/s)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('rejects generated Vitest runtime tests under a typecheck-enabled config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-plan-'))
    const generatedFile = path.join(root, 'tests', 'dd-test-optimization-validation.test.ts')
    const configFile = path.join(root, 'vitest.config.ts')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-validation-state'))
    setGeneratedTestFramework(framework, 'vitest')
    framework.existingTestCommand.argv.push('--typecheck.enabled=false')
    framework.generatedTestStrategy.fileExtension = '.test.ts'
    fs.writeFileSync(configFile, 'export default { test: { "typecheck": { "enabled": true } } }\n')
    for (const scenario of framework.generatedTestStrategy.scenarios) {
      scenario.runCommand = {
        cwd: root,
        argv: [
          process.execPath,
          'vitest.mjs',
          'run',
          '--config',
          configFile,
          scenario.testIdentities[0].file,
        ],
      }
    }

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      }), /typecheck-enabled Vitest config.*count each generated test twice/s)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores commented and string Vitest typecheck examples', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-typecheck-example-plan-'))
    const generatedFile = path.join(root, 'tests', 'dd-test-optimization-validation.test.ts')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-validation-state'))
    setGeneratedTestFramework(framework, 'vitest')
    framework.generatedTestStrategy.fileExtension = '.test.ts'
    fs.writeFileSync(path.join(root, 'vitest.config.ts'), [
      '// typecheck: { enabled: true },',
      'const example = "typecheck: { enabled: true }"',
      'export default { test: {} }',
      '',
    ].join('\n'))

    try {
      formatFrameworkPlan(root, framework)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects generated Vitest tests outside literal include patterns', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-include-plan-'))
    const generatedFile = path.join(root, 'test', 'dd-test-optimization-validation.test.js')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-validation-state'))
    setGeneratedTestFramework(framework, 'vitest')
    fs.writeFileSync(
      path.join(root, 'vitest.config.ts'),
      'export default { test: { include: ["**/__tests__/**/*.[jt]s?(x)"] } }\n'
    )

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      }), /temporary test path .* does not match the literal test\.include patterns.*__tests__/s)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts generated Vitest tests matched by literal include patterns', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-include-plan-'))
    const generatedFile = path.join(root, '__tests__', 'dd-test-optimization-validation.test.js')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-validation-state'))
    setGeneratedTestFramework(framework, 'vitest')
    fs.writeFileSync(
      path.join(root, 'vitest.config.ts'),
      'export default { test: { include: ["**/__tests__/**/*.[jt]s?(x)"] } }\n'
    )

    try {
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores nested coverage include patterns when checking generated Vitest tests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-coverage-include-plan-'))
    const generatedFile = path.join(root, 'test', 'dd-test-optimization-validation.test.js')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-validation-state'))
    setGeneratedTestFramework(framework, 'vitest')
    fs.writeFileSync(
      path.join(root, 'vitest.config.ts'),
      'export default { test: { coverage: { include: ["src/**/*.js"] } } }\n'
    )

    try {
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not infer a generated Vitest path rule from conflicting literal test configs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-ambiguous-include-plan-'))
    const generatedFile = path.join(root, 'test', 'dd-test-optimization-validation.test.js')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-validation-state'))
    setGeneratedTestFramework(framework, 'vitest')
    fs.writeFileSync(path.join(root, 'vitest.config.ts'), [
      'export default {',
      '  projects: [',
      '    { test: { include: ["src/**/*.test.js"] } },',
      '    { test: { include: ["test/**/*.test.js"] } },',
      '  ],',
      '}',
      '',
    ].join('\n'))

    try {
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not infer a generated Vitest path rule from a partially dynamic include array', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-dynamic-include-plan-'))
    const generatedFile = path.join(root, 'test', 'dd-test-optimization-validation.test.js')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-validation-state'))
    setGeneratedTestFramework(framework, 'vitest')
    fs.writeFileSync(
      path.join(root, 'vitest.config.ts'),
      'export default { test: { include: [defaultInclude, "src/**/*.test.js"] } }\n'
    )

    try {
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a selected Vitest command under a typecheck-enabled config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-typecheck-plan-'))
    const configFile = path.join(root, 'vitest.config.ts')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'dd-test-optimization-validation.test.ts'),
      path.join(root, '.dd-validation-state')
    )
    setGeneratedTestFramework(framework, 'vitest')
    framework.existingTestCommand = {
      cwd: root,
      argv: [process.execPath, '-e', '', '--config', configFile],
    }
    fs.writeFileSync(configFile, 'export default { test: { typecheck: { enabled: true } } }\n')

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      }), /selected direct test command.*--typecheck\.enabled=false/s)

      framework.existingTestCommand.argv.push('--typecheck.enabled=false')
      for (const scenario of framework.generatedTestStrategy.scenarios) {
        scenario.runCommand.argv.push('--typecheck.enabled=false')
      }
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not read an explicit Vitest config outside the repository', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-config-root-'))
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-config-outside-'))
    const configFile = path.join(outsideRoot, 'vitest.config.ts')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'dd-test-optimization-validation.test.ts'),
      path.join(root, '.dd-validation-state')
    )
    setGeneratedTestFramework(framework, 'vitest')
    framework.existingTestCommand = {
      cwd: root,
      argv: [process.execPath, '-e', '', '--config', configFile],
    }
    fs.writeFileSync(configFile, 'export default { test: { typecheck: { enabled: true } } }\n')

    try {
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outsideRoot, { recursive: true, force: true })
    }
  })

  it('does not follow a default Vitest config symlink outside the repository', function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-config-root-'))
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-config-outside-'))
    const outsideConfig = path.join(outsideRoot, 'vitest.config.ts')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'dd-test-optimization-validation.test.ts'),
      path.join(root, '.dd-validation-state')
    )
    setGeneratedTestFramework(framework, 'vitest')
    framework.existingTestCommand = {
      cwd: root,
      argv: [process.execPath, '-e', ''],
    }
    fs.writeFileSync(outsideConfig, 'export default { test: { typecheck: { enabled: true } } }\n')
    fs.symlinkSync(outsideConfig, path.join(root, 'vitest.config.ts'))

    try {
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outsideRoot, { recursive: true, force: true })
    }
  })

  for (const configName of ['vitest.config.ts', 'vite.config.ts']) {
    it(`rejects a selected Vitest command using default ${configName}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-default-config-plan-'))
      const framework = getPlannedFramework(
        root,
        path.join(root, 'dd-test-optimization-validation.test.ts'),
        path.join(root, '.dd-validation-state')
      )
      setGeneratedTestFramework(framework, 'vitest')
      framework.existingTestCommand = {
        cwd: root,
        argv: [process.execPath, '-e', ''],
      }
      fs.writeFileSync(
        path.join(root, configName),
        'export default { test: { typecheck: { enabled: true } } }\n'
      )

      try {
        assert.throws(() => formatExecutionPlan({
          manifest: {
            __path: path.join(root, 'manifest.json'),
            repository: { root },
            frameworks: [framework],
          },
          out: path.join(root, 'results'),
        }), new RegExp(`typecheck-enabled Vitest config .*${configName}`))
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('always prints both required Vitest preloads', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-node-version-plan-'))
    const framework = getPlannedFramework(
      root,
      path.join(root, 'dd-test-optimization-validation.test.ts'),
      path.join(root, '.dd-validation-state')
    )
    setGeneratedTestFramework(framework, 'vitest')

    try {
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
        requestedScenario: 'basic-reporting',
      })
      const summary = fs.readFileSync(path.join(root, 'results', 'approval-summary.md'), 'utf8')

      assert.match(
        summary,
        /NODE_OPTIONS=--import dd-trace\/register\.js -r dd-trace\/ci\/init/
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('allows an alternate Node executable for direct Vitest validation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-node-shim-'))
    const nodeShim = path.join(root, 'node')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'dd-test-optimization-validation.test.ts'),
      path.join(root, '.dd-validation-state')
    )
    setGeneratedTestFramework(framework, 'vitest')
    framework.existingTestCommand = {
      cwd: root,
      argv: [nodeShim, '-e', ''],
    }
    fs.writeFileSync(nodeShim, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    try {
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires setup-provided executables to exist before approval', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-setup-plan-'))
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.setup = {
      commands: [{
        id: 'install-test-runner',
        cwd: root,
        argv: [process.execPath, '-e', 'process.exit(0)'],
      }],
    }
    framework.existingTestCommand = {
      cwd: root,
      argv: ['test-runner-installed-by-setup', 'test'],
    }

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
        requestedScenario: 'basic-reporting',
      }), /test-runner-installed-by-setup.*not available/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('counts only Vitest tests executed through a name filter', () => {
    assert.strictEqual(getObservedTestCount('vitest', `
      Test Files  1 passed (1)
          Tests  1 passed | 2 skipped (3)
    `), 1)
    assert.strictEqual(getObservedTestCount('vitest', `
      Test Files  1 failed (1)
          Tests  1 failed | 2 skipped (3)
    `), 1)
    assert.strictEqual(getObservedTestCount('vitest', `
      Test Files  1 passed (1)
          Tests  3 passed (3)
    `), 3)
  })

  it('counts only Jest tests executed through a name filter', () => {
    assert.strictEqual(getObservedTestCount('jest', '', `
      Test Suites: 1 passed, 1 total
      Tests:       2 skipped, 1 passed, 3 total
    `), 1)
    assert.strictEqual(getObservedTestCount('jest', '', `
      Test Suites: 1 failed, 1 total
      Tests:       2 skipped, 1 failed, 3 total
    `), 1)
    assert.strictEqual(getObservedTestCount('jest', '', `
      Test Suites: 1 passed, 1 total
      Tests:       3 passed, 3 total
    `), 3)
  })

  it('counts Playwright test summaries', () => {
    assert.strictEqual(getObservedTestCount('playwright', `
      Running 1 test using 1 worker
      1 passed (1.2s)
    `), 1)
    assert.strictEqual(getObservedTestCount('playwright', `
      1 failed
      1 passed (2.3s)
    `), 2)
    assert.strictEqual(getObservedTestCount('playwright', '1 skipped'), 0)
  })

  it('counts Cypress test summaries', () => {
    assert.strictEqual(getObservedTestCount('cypress', `
      (Run Finished)
      Tests:        1
      Passing:      1
      Failing:      0
    `), 1)
    assert.strictEqual(getObservedTestCount('cypress', `
      Tests:        3
      Passing:      2
      Failing:      1
    `), 3)
  })

  it('counts Cucumber scenario summaries', () => {
    assert.strictEqual(getObservedTestCount('cucumber', `
      1 scenario (1 passed)
      1 step (1 passed)
    `), 1)
    assert.strictEqual(getObservedTestCount('cucumber', `
      3 scenarios (2 passed, 1 failed)
      3 steps (2 passed, 1 failed)
    `), 3)
  })
})

function getPlannedFramework (root, generatedFile, _stateFile) {
  const generatedFiles = {
    'basic-pass': generatedFile,
    'atr-fail-once': addFilenameSuffix(generatedFile, '-atr-fail-once'),
    'test-management-target': addFilenameSuffix(generatedFile, '-test-management-target'),
  }
  const stateFile = path.join(
    path.dirname(generatedFiles['atr-fail-once']),
    '.dd-test-optimization-validation-atr-state'
  )
  return {
    id: 'jest:root',
    framework: 'jest',
    status: 'runnable',
    project: { root },
    existingTestCommand: {
      cwd: root,
      argv: [process.execPath, '-e', 'console.log("Tests: 1 passed, 1 total")'],
    },
    generatedTestStrategy: {
      status: 'planned',
      adapter: 'jest',
      moduleSystem: 'commonjs',
      files: Object.entries(generatedFiles).map(([id, filename]) => ({
        path: filename,
        contentLines: getGeneratedTestContent({
          framework: 'jest',
          moduleSystem: 'commonjs',
          scenarioId: id,
          stateFile,
        }).split('\n'),
      })),
      scenarios: Object.entries(generatedFiles).map(([id, filename]) => {
        return getScenario(root, id, id === 'atr-fail-once' ? 1 : 0, filename, stateFile)
      }),
      cleanupPaths: [...Object.values(generatedFiles), stateFile],
    },
  }
}

function getScenario (root, id, exitCode, filename, stateFile) {
  const script = id === 'atr-fail-once'
    ? `require('node:fs').writeFileSync(${JSON.stringify(stateFile)}, 'state'); ` +
      'console.log("Tests: 1 failed, 1 total"); process.exit(1)'
    : `console.log("Tests: 1 passed, 1 total"); process.exit(${exitCode})`
  return {
    id,
    runCommand: {
      cwd: root,
      argv: [process.execPath, '-e', script, filename],
    },
    expectedWithoutDatadog: {
      exitCode,
      observedTestCount: 1,
    },
    testIdentities: [{ name: GENERATED_SCENARIOS[id].testName, file: filename }],
  }
}

function setGeneratedTestFramework (framework, name) {
  framework.framework = name
  framework.generatedTestStrategy.adapter = name
  framework.generatedTestStrategy.moduleSystem = name === 'vitest' ? 'esm' : 'commonjs'
  for (const scenario of framework.generatedTestStrategy.scenarios) {
    const file = framework.generatedTestStrategy.files.find(entry => entry.path === scenario.testIdentities[0].file)
    file.contentLines = getGeneratedTestContent({
      framework: name,
      moduleSystem: framework.generatedTestStrategy.moduleSystem,
      scenarioId: scenario.id,
      stateFile: path.join(path.dirname(file.path), '.dd-test-optimization-validation-atr-state'),
    }).split('\n')
  }
}

function formatFrameworkPlan (root, framework) {
  return formatExecutionPlan({
    manifest: {
      __path: path.join(root, 'manifest.json'),
      repository: { root },
      frameworks: [framework],
    },
    out: path.join(root, 'results'),
  })
}

function addFilenameSuffix (filename, suffix) {
  const extension = path.extname(filename)
  return `${filename.slice(0, -extension.length)}${suffix}${extension}`
}

function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

function countOccurrences (value, search) {
  return value.split(search).length - 1
}
