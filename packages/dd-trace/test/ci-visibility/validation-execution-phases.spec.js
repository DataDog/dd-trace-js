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
      'if (process.env.NODE_OPTIONS?.includes("dd-trace/ci/init") || process.env.DD_API_KEY) process.exit(42); ' +
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

  it('reports repeated Playwright browser launch denials as one actionable sandbox blocker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-playwright-launch-'))
    const browserFailure = [
      "console.error('browserType.launch: Failed to launch the browser process.')",
      "console.error('bootstrap_check_in: Permission denied (1100)')",
      "console.error('  1 failed')",
      'process.exit(1)',
    ].join(';')
    const candidates = ['first.spec.js', 'second.spec.js'].map(sourceFile => ({
      command: { cwd: root, argv: [process.execPath, '-e', browserFailure] },
      maxTestCount: 1,
      sourceFile: path.join(root, sourceFile),
    }))
    const framework = {
      id: 'playwright:root',
      framework: 'playwright',
      status: 'runnable',
      project: { root },
      existingTestCommand: candidates[0].command,
      localTestCandidates: candidates,
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
      assert.strictEqual(outcome.failure.evidence.commandFailure.kind, 'playwright-browser-launch-blocked')
      assert.match(outcome.failure.diagnosis, /Playwright needs to launch the project browser/)
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /Approve rerunning the exact/)
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /host shell/)
      assert.strictEqual(outcome.failure.evidence.candidateAttempts.length, 2)
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
      const ciOnlyPlan = formatExecutionPlan({
        manifest,
        out: path.join(root, 'results-ci'),
        selectedFrameworkIds: ['jest:root'],
        requestedScenario: 'ci-wiring',
      })

      assert.strictEqual(fs.readFileSync(path.join(planOut, 'execution-plan.md'), 'utf8'), `${plan}\n`)
      const approvalSummary = plan
      assert.match(approvalSummary, /# Test Optimization Validation Execution Plan/)
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
      assert.match(plan, /Command-created outputs removed after execution: `coverage`/)
      assert.match(plan, /NODE_OPTIONS=-r dd-trace\/ci\/init/)
      assert.match(ciOnlyPlan, /\*\*CI configuration audit:\*\*/)
      assert.doesNotMatch(ciOnlyPlan, /\*\*Advanced feature checks:\*\*/)
      assert.match(plan, /\*\*Test candidate 1\*\*/)
      assert.match(plan, /Advanced Check: Auto Test Retries/)
      assert.doesNotMatch(plan, /Advanced Check: Early Flake Detection/)
      assert.doesNotMatch(plan, /Advanced Check: Test Management/)
      assert.match(plan, /\*\*Temporary test source:\*\*/)
      assert.match(plan, /\*\*Files removed after validation:\*\*/)
      assert.doesNotMatch(plan, /<details>|<summary>/)
      assert.match(plan, /test\('atr-fail-once'/)
      assert.match(plan, /Working directory: `\.`/)
      assert.match(plan, /## Scope/)
      assert.match(plan, /\*\*Jest tests for @example\/app\*\*: will be validated/)
      assert.match(plan, /\*\*Karma tests for browser-example\*\*: not supported by this validator/)
      assert.match(plan, /## Safety and Outputs/)
      assert.match(plan, /opens no listener, contacts no Datadog endpoint, requires no real Datadog credentials/)
      assert.doesNotMatch(plan, /plan-secret/)
      const approvalJsonPath = path.join(planOut, 'approval.json')
      const approvalJson = fs.readFileSync(approvalJsonPath)
      const approvalMaterial = JSON.parse(approvalJson)
      const planNonce = approvalMaterial.validation.offlineFixtureNonce
      assert.match(planNonce, /^[a-f0-9]{32}$/)
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
      assert.match(plan, /approval-files\.sha256/)
      if (process.platform === 'win32') {
        assert.match(plan, /certutil -hashfile .*approval\.json"? SHA256/)
      } else {
        assert.match(plan, /shasum -a 256 .*approval\.json/)
      }
      assert.match(plan, new RegExp(`Expected SHA-256: \`${approvalDigest}\``))
      assert.ok(approvalMaterial.commands.length > 0)
      assert.ok(approvalMaterial.generatedFiles.some(file => file.path === generatedFile))
      assert.ok(approvalMaterial.validator.coveredFiles.some(file => file.path.endsWith('/approval.js')))
      assert.doesNotMatch(approvalJson.toString(), /plan-secret/)
      assert.match(plan, /without running project code/)
      assert.match(plan, /do not verify where the installed .* package came from/)
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

      assert.strictEqual(countOccurrences(plan, renderedCommand), 2)
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
      formatExecutionPlan({ manifest, out, requestedScenario: 'basic-reporting' })
      const approval = JSON.parse(fs.readFileSync(path.join(out, 'approval.json'), 'utf8'))
      const basicReporting = approval.executables.find(entry => entry.label.endsWith(':basic-reporting'))
      const checksums = fs.readFileSync(path.join(out, 'approval-files.sha256'), 'utf8')

      assert.strictEqual(basicReporting.delegated.length, 1)
      assert.strictEqual(basicReporting.delegated[0].path, canonicalTarget)
      assert.match(checksums, new RegExp(escapeRegExp(canonicalTarget)))
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
      formatExecutionPlan({ manifest, out, requestedScenario: 'basic-reporting' })
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
      }), /literal extra "--".*Append focused runner arguments directly/s)
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
        assert.match(error, /literal extra "--".*Append focused runner arguments directly/s)
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
        }), /literal extra "--".*Append focused runner arguments directly/s)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('rejects an explicit Vitest typecheck command', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-typecheck-plan-'))
    const framework = getPlannedFramework(
      root,
      path.join(root, 'dd-test-optimization-validation.test.ts'),
      path.join(root, '.dd-validation-state')
    )
    setGeneratedTestFramework(framework, 'vitest')
    framework.existingTestCommand = {
      cwd: root,
      argv: [process.execPath, '-e', '', '--typecheck'],
    }

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      }), /runs Vitest with --typecheck/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

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
      const summary = fs.readFileSync(path.join(root, 'results', 'execution-plan.md'), 'utf8')

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
