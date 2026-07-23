'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { version: packageVersion } = require('../../../../package.json')
const {
  getExecutableForSpawn,
  getResolvedExecutable,
  getUnavailableExecutable,
  isExplicitExecutablePath,
} = require('../../../../ci/test-optimization-validation/executable')
const { runCommand } = require('../../../../ci/test-optimization-validation/command-runner')
const {
  getDatadogCleanCommand,
  getLocalValidationCommand,
} = require('../../../../ci/test-optimization-validation/local-command')
const {
  getCommandSuitabilityError,
  getPackageScriptExpansion,
} = require('../../../../ci/test-optimization-validation/command-suitability')
const { getCommandBlocker } = require('../../../../ci/test-optimization-validation/command-blocker')
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

  it('accepts a successful clean preflight even when the runner executes many tests', async () => {
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

      assert.strictEqual(outcome.ok, true)
      assert.strictEqual(outcome.preflight.observedTestCount, 100)
      assert.strictEqual(outcome.preflight.testCountKnown, true)
      assert.strictEqual(outcome.preflight.testCountAccepted, true)
      assert.strictEqual(outcome.failure, undefined)
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
      assert.strictEqual(outcome.failure.status, 'blocked')
      assert.strictEqual(outcome.failure.evidence.domain, 'project_setup')
      assert.strictEqual(outcome.failure.evidence.projectBaselineFailed, true)
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
      assert.strictEqual(outcome.failure.evidence.domain, 'execution_environment')
      assert.strictEqual(outcome.failure.evidence.projectBaselineFailed, false)
      assert.strictEqual(outcome.failure.evidence.commandFailure.kind, 'package-manager-filesystem-blocked')
      assert.match(outcome.failure.diagnosis, /package manager could not write to its tool or cache directory/)
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /writable package-manager home or cache/)
      assert.doesNotMatch(outcome.failure.diagnosis, /determine how many tests/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a missing approved project environment variable as setup required', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-environment-'))
    const variable = 'PROJECT_VALIDATION_TEST_MODE'
    const original = process.env[variable]
    delete process.env[variable]
    const framework = {
      id: 'mocha:root',
      framework: 'mocha',
      existingTestCommand: {
        cwd: root,
        argv: [process.execPath, '-e', 'process.exit(0)'],
        requiredEnvVars: [variable],
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
      assert.strictEqual(outcome.failure.evidence.domain, 'project_setup')
      assert.strictEqual(
        outcome.failure.evidence.commandFailure.kind,
        'project-command-environment-missing'
      )
      assert.match(outcome.failure.evidence.commandFailure.recommendation, new RegExp(variable))
    } finally {
      if (original === undefined) {
        delete process.env[variable]
      } else {
        process.env[variable] = original
      }
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
      assert.strictEqual(outcome.failure.evidence.domain, 'execution_environment')
      assert.strictEqual(outcome.failure.evidence.commandFailure.kind, 'local-test-socket-blocked')
      assert.match(outcome.failure.diagnosis, /project test could not start its localhost listener/)
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /Do not request broader permissions/)
      assert.doesNotMatch(outcome.failure.diagnosis, /determine how many tests/)
      assert.strictEqual(
        outcome.failure.evidence.commandFailure.summary.match(/No Test Optimization conclusion was reached\./g)?.length,
        1
      )
      assert.match(outcome.failure.diagnosis, /Basic Reporting could not be tested reliably/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a Cypress abort with only npm lifecycle output without inventing a cause', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-cypress-launch-'))
    const command = {
      cwd: root,
      argv: [
        process.execPath,
        '-e',
        'process.stdout.write("\\n> example@1.0.0 e2e\\n> cypress run --spec example.cy.js\\n"); process.exit(134)',
      ],
    }
    const framework = {
      id: 'cypress:root',
      framework: 'cypress',
      existingTestCommand: command,
      localTestCandidates: [{ command }, { command }, { command }],
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
      assert.strictEqual(outcome.failure.evidence.domain, 'local_runtime')
      assert.strictEqual(outcome.failure.evidence.localRuntimeBlocked, true)
      assert.strictEqual(outcome.failure.evidence.commandFailure.kind, 'cypress-process-aborted')
      assert.match(outcome.failure.diagnosis, /does not identify whether Cypress/)
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /project's normal test environment/)
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /Do not treat this result/)
      assert.doesNotMatch(outcome.failure.diagnosis, /determine how many tests/)
      assert.doesNotMatch(outcome.failure.diagnosis, /sandbox denied|could not launch/)
      assert.strictEqual(outcome.preflight.attempts.length, 3)
      assert.strictEqual(outcome.failure.diagnosis.match(/does not identify whether Cypress/g)?.length, 1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a Playwright browser abort as an unattributed local-runtime blocker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-playwright-abort-'))
    const framework = {
      id: 'playwright:root',
      framework: 'playwright',
      existingTestCommand: {
        cwd: root,
        argv: [
          process.execPath,
          '-e',
          'console.log("\\u001b[31mError: browserType.launch: Target page, context or browser has been ' +
            'closed\\u001b[0m"); ' +
            'console.log("[pid=1] <process did exit: exitCode=null, signal=SIGABRT>"); ' +
            'console.log("9 failed"); process.exit(1)',
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
      assert.strictEqual(outcome.failure.evidence.domain, 'local_runtime')
      assert.strictEqual(
        outcome.failure.evidence.commandFailure.kind,
        'playwright-browser-process-aborted'
      )
      assert.match(outcome.failure.diagnosis, /does not identify whether the browser\/runtime setup/)
      assert.strictEqual(
        outcome.failure.evidence.commandFailure.signals.join('\n').includes(String.fromCharCode(27)),
        false
      )
      assert.doesNotMatch(outcome.failure.diagnosis, /sandbox denied/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('recognizes package exports failures as project command initialization blockers', () => {
    const blocker = getCommandBlocker({
      exitCode: 1,
      stdout: '',
      stderr: 'Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath "./register" is not defined by "exports"',
    }, { framework: 'vitest', testsRan: false })

    assert.strictEqual(blocker.kind, 'project-command-initialization-failed')
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
      assert.strictEqual(outcome.failure.status, 'blocked')
      assert.strictEqual(outcome.failure.evidence.domain, 'project_setup')
      assert.strictEqual(outcome.failure.evidence.projectBaselineFailed, true)
      assert.strictEqual(outcome.failure.evidence.commandFailure, undefined)
      assert.match(outcome.failure.diagnosis, /Fix the failing project test or its setup/)
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
      assert.strictEqual(outcome.failure.evidence.domain, 'project_setup')
      assert.strictEqual(outcome.failure.evidence.commandFailure.kind, 'playwright-browser-missing')
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /does not download browsers/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not classify Playwright browser text as a blocker for another framework', () => {
    const result = {
      exitCode: 1,
      stderr: "browserType.launch: Executable doesn't exist. Please run playwright install.",
      stdout: '',
    }

    assert.strictEqual(
      getCommandBlocker(result, { framework: 'playwright', testsRan: false }).kind,
      'playwright-browser-missing'
    )
    for (const framework of ['cucumber', 'cypress', 'jest', 'mocha']) {
      assert.strictEqual(getCommandBlocker(result, { framework, testsRan: false }), undefined)
    }
  })

  it('does not classify Cypress runtime text as a blocker for another framework', () => {
    const result = {
      exitCode: 1,
      stderr: 'Cypress executable not found. Please reinstall Cypress.',
      stdout: '',
    }

    assert.strictEqual(
      getCommandBlocker(result, { framework: 'cypress', testsRan: false }).kind,
      'cypress-runtime-missing'
    )
    for (const framework of ['cucumber', 'jest', 'mocha', 'playwright', 'vitest']) {
      assert.strictEqual(getCommandBlocker(result, { framework, testsRan: false }), undefined)
    }
  })

  it('reports a missing Vitest browser provider as a setup blocker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-vitest-browser-'))
    const framework = {
      id: 'vitest:browser',
      framework: 'vitest',
      browserRequired: true,
      existingTestCommand: {
        cwd: root,
        argv: [
          process.execPath,
          '-e',
          'console.error("Error: Cannot find package \'@vitest/browser-playwright\'"); process.exit(1)',
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
      assert.strictEqual(outcome.failure.evidence.domain, 'project_setup')
      assert.strictEqual(outcome.failure.evidence.commandFailure.kind, 'vitest-browser-provider-missing')
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /normal Vitest browser setup/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a denied Vitest browser launch as an execution-environment blocker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-vitest-browser-launch-'))
    const framework = {
      id: 'vitest:browser',
      framework: 'vitest',
      browserRequired: true,
      existingTestCommand: {
        cwd: root,
        argv: [
          process.execPath,
          '-e',
          [
            "console.error('browserType.launch: Failed to launch the browser process.')",
            "console.error('bootstrap_check_in: Permission denied (1100)')",
            'process.exit(1)',
          ].join(';'),
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
      assert.strictEqual(outcome.failure.evidence.domain, 'execution_environment')
      assert.strictEqual(outcome.failure.evidence.commandFailure.kind, 'vitest-browser-launch-blocked')
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /Retry the same approved plan/)
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /Do not request broader permissions/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a missing project test-runner executable as a setup blocker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-runner-missing-'))
    const framework = {
      id: 'playwright:root',
      framework: 'playwright',
      existingTestCommand: {
        cwd: root,
        argv: [
          process.execPath,
          '-e',
          'console.error("/bin/sh: playwright: command not found"); process.exit(127)',
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
      assert.strictEqual(outcome.failure.evidence.domain, 'project_setup')
      assert.strictEqual(outcome.failure.evidence.commandFailure.kind, 'test-runner-command-missing')
      assert.match(outcome.failure.diagnosis, /local Test Optimization compatibility was not tested/)
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
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /Retry the same approved plan/)
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /host shell/)
      assert.match(outcome.failure.evidence.commandFailure.recommendation, /Do not request broader permissions/)
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
    framework.browserRequired = true
    framework.localSocketRequired = true
    framework.existingTestCommand = {
      cwd: root,
      argv: ['npm', 'test', '--', '--runInBand', '--token', 'plan-secret'],
      displayCommand: 'echo harmless-display-command',
      env: {
        BASH_ENV: './project-shell-init',
      },
      outputPaths: [path.join(root, 'coverage')],
      requiredEnvVars: ['PROJECT_TEST_MODE'],
    }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: { test: 'node dd-test-optimization-validation-jest-runner.js' },
    }))
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
    const setupBlockedFrameworks = ['cucumber', 'cypress'].map(name => ({
      id: `${name}:example`,
      framework: name,
      status: 'requires_manual_setup',
      project: { name: 'example', root },
      notes: ['Complete project setup before live validation.'],
    }))
    const manifest = {
      __path: manifestPath,
      repository: { root },
      frameworks: [framework, unsupportedFramework, ...setupBlockedFrameworks],
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
      assert.match(approvalSummary, /selected candidate can run up to four times/)
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
      assert.match(plan, /Inherited non-secret environment names: `PROJECT_TEST_MODE`/)
      assert.match(plan, /current values are used only at execution and are not printed or integrity-bound/)
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
      assert.match(plan, /selected project test launches a browser/)
      assert.match(plan, /representative test found appears to require a project localhost listener/)
      assert.match(plan, /\*\*Jest tests for @example\/app\*\*: will be validated/)
      assert.match(plan, /\*\*Karma tests for browser-example\*\*: not supported by this validator/)
      assert.match(plan, /\*\*Cucumber tests for example\*\*: requires additional setup/)
      assert.match(plan, /\*\*Cypress tests for example\*\*: requires additional setup/)
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
      if (process.platform === 'win32') {
        assert.match(plan, /certutil -hashfile .*approval\.json"? SHA256/)
        assert.doesNotMatch(plan, /approval-files\.sha256/)
      } else {
        assert.match(plan, /shasum -a 256 .*approval\.json/)
        assert.match(plan, /approval-files\.sha256/)
      }
      assert.match(plan, new RegExp(`Expected SHA-256: \`${approvalDigest}\``))
      assert.ok(approvalMaterial.commands.length > 0)
      assert.ok(approvalMaterial.generatedFiles.some(file => file.path === generatedFile))
      assert.ok(approvalMaterial.validator.coveredFiles.some(file => file.path.endsWith('/approval.js')))
      assert.doesNotMatch(approvalJson.toString(), /plan-secret/)
      assert.match(plan, /without running project code/)
      assert.match(plan, /do not verify where the installed .* package came from/)
      assert.match(plan, /trusted repository.*trusted installed dependencies/s)
      assert.match(plan, /project tests run with your OS privileges/)
      assert.match(plan, /inputs explicitly covered by this approval/)
      assert.match(plan, /do not comprehensively fingerprint existing tests, runner configuration/)
      assert.match(plan, /## Validator Identity/)
      assert.match(plan, new RegExp(`Package: \`dd-trace@${escapeRegExp(packageVersion)}\``))
      assert.match(plan, /https:\/\/docs\.datadoghq\.com\/tests\/setup\/javascript\//)
      assert.match(plan, /symlinked live source checkout is a development setup/)
      assert.match(plan, /Run the approved validation command/)
      assert.match(plan, /## Platform Trust-Gate Fallback/)
      assert.match(plan, /native permission control scoped to this exact approved command/)
      assert.match(plan, /may request it once and retry the unchanged command once/)
      assert.match(plan, /raw `EACCES` or `EPERM` error does not prove/)
      assert.match(plan, /hard-denies this exact command/)
      assert.match(plan, /do not retry the unchanged command/)
      assert.match(plan, /then ask the agent to interpret `results-atr\/report\.md`/)
      assert.doesNotMatch(plan, /not user-visible merely because it appeared in tool output/)
      assert.doesNotMatch(plan, /Never send only an approval question/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('documents the limited approval and offline-transport trust boundaries in the runbook', () => {
    const runbook = fs.readFileSync(path.resolve(__dirname, '../../../../ci/runbook.md'), 'utf8')

    assert.match(runbook, /trusted repository with trusted installed dependencies/)
    assert.match(runbook, /developer's OS privileges/)
    assert.match(runbook, /Approval detects drift only in inputs it explicitly covers/)
    assert.match(runbook, /does not comprehensively fingerprint existing\s+tests, runner configuration/)
    assert.match(runbook, /Volta-managed `npm`, `pnpm`, `yarn`, and Node\.js runtime executables may resolve outside/)
    assert.match(runbook, /revalidate them before spawn/)
    assert.match(runbook, /Project commands may\s+still use the network and local resources/)
    assert.match(runbook, /## Human-Facing Provenance and Command Effects/)
    assert.match(runbook, /--init-manifest` \| No \| Exclusively creates/)
    assert.match(runbook, /Pre-live discovery does not execute project code or use the network, but it is not filesystem-read-only/)
    assert.doesNotMatch(runbook, /Discovery is read-only/)
    assert.match(runbook, /symlink to a live source\s+checkout.*not equivalent/s)
    assert.match(runbook, /## Platform Trust-Gate Fallback/)
    assert.match(runbook, /native permission control scoped to the exact pre-live command/)
    assert.match(runbook, /request it at most once and retry that unchanged command at most once/)
    assert.match(runbook, /raw `EACCES` or `EPERM`/)
    assert.match(runbook, /Playwright candidate may establish runner ownership through one statically resolved/)
    assert.match(runbook, /fixture chains are not followed/)
    assert.match(runbook, /do not retry the unchanged command/)
    assert.match(runbook, /Never retry an unchanged hard-denied command/)
  })

  it('renders local candidates separately when identical argv has different execution settings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-command-shape-'))
    const packageRoot = path.join(root, 'package')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'generated.test.js'),
      path.join(root, '.retry-state')
    )
    const commandArgv = [...framework.existingTestCommand.argv]
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
      assert.strictEqual(countOccurrences(plan, 'dd-test-optimization-validation-jest-runner.js'), 2)
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
      }), /Cannot render an approvable plan.*uses executable "definitely-not-an-installed-test-runner"/s)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an approval plan when a package script runner is unavailable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-unavailable-package-runner-'))
    const generatedFile = path.join(root, 'tests', 'dd-test-optimization-validation.test.js')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-validation-state'))
    const bin = path.join(root, 'bin')
    const npmExecutable = path.join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(npmExecutable, '')
    fs.chmodSync(npmExecutable, 0o755)
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: { test: 'playwright test' },
    }))
    framework.existingTestCommand = {
      cwd: root,
      argv: [path.basename(npmExecutable), 'run', 'test'],
      env: { PATH: bin },
    }

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      }), /Cannot render an approvable plan.*uses executable "playwright"/s)
      assert.strictEqual(fs.existsSync(path.join(root, 'dd-test-optimization-validation-results')), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('discloses a trusted project wrapper without applying validator-direct command restrictions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-project-wrapper-'))
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js')
    )
    framework.existingTestCommand = {
      cwd: root,
      shellCommand: 'npm test && echo project-wrapper-complete',
      usesShell: true,
    }

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

      assert.match(plan, /npm test && echo project-wrapper-complete/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts direct matching runner and contained Node.js runner shapes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-supported-command-'))
    const runner = path.join(root, 'jest-runner.js')
    const framework = { framework: 'jest', project: { root, configFiles: [] } }
    fs.writeFileSync(runner, 'process.exit(0)\n')

    try {
      for (const argv of [['jest', '--runInBand'], [process.execPath, runner, '--runInBand']]) {
        assert.strictEqual(getCommandSuitabilityError({
          command: { cwd: root, argv },
          framework,
          label: 'local test candidate',
          repositoryRoot: root,
        }), undefined)
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  for (const [option, reason] of [
    ['--inspect-brk=0', /inspector listener/],
    ['--watch', /waits for file changes/],
    ['--cpu-prof', /profiling or heap tracking/],
    ['--redirect-warnings=warnings.log', /redirects warnings/],
    ['--tls-keylog=keys.log', /TLS key material/],
  ]) {
    it(`rejects unsuitable Node.js runtime option ${option}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-node-mode-'))
      const runner = path.join(root, 'jest-runner.js')
      fs.writeFileSync(runner, 'process.exit(0)\n')

      try {
        assert.match(getCommandSuitabilityError({
          command: { cwd: root, argv: [process.execPath, option, runner] },
          framework: { framework: 'jest', project: { root, configFiles: [] } },
          label: 'local test candidate',
          repositoryRoot: root,
        }), reason)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('rejects unsuitable NODE_OPTIONS on a direct runner command', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-runner-node-options-'))

    try {
      assert.match(getCommandSuitabilityError({
        command: { cwd: root, argv: ['jest'], env: { NODE_OPTIONS: '--inspect=0' } },
        framework: { framework: 'jest', project: { root, configFiles: [] } },
        label: 'local test candidate',
        repositoryRoot: root,
      }), /inspector listener/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats Windows environment aliases as Datadog and Node.js execution settings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-windows-env-aliases-'))
    const runner = path.join(root, 'jest-runner.js')
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    fs.writeFileSync(runner, 'process.exit(0)\n')

    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      const command = {
        cwd: root,
        argv: [process.execPath, runner],
        env: {
          dd_api_key: 'must-be-removed',
          Node_Options: '-r dd-trace/ci/init',
          SAFE_MODE: 'enabled',
        },
      }
      assert.deepStrictEqual(getDatadogCleanCommand(command).env, { SAFE_MODE: 'enabled' })
      assert.match(getCommandSuitabilityError({
        command: {
          cwd: root,
          argv: [process.execPath, runner],
          env: { node_v8_coverage: 'coverage' },
        },
        framework: { framework: 'jest', project: { root, configFiles: [] } },
        label: 'isolation test candidate',
        repositoryRoot: root,
      }), /NODE_V8_COVERAGE/)
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  for (const [name, value] of [
    ['NODE_V8_COVERAGE', 'coverage'],
    ['NODE_REDIRECT_WARNINGS', 'warnings.log'],
    ['NODE_COMPILE_CACHE', 'compile-cache'],
  ]) {
    it(`rejects implicit Node.js output environment ${name}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-node-output-env-'))
      const runner = path.join(root, 'jest-runner.js')
      fs.writeFileSync(runner, 'process.exit(0)\n')

      try {
        assert.match(getCommandSuitabilityError({
          command: { cwd: root, argv: [process.execPath, runner], env: { [name]: value } },
          framework: { framework: 'jest', project: { root, configFiles: [] } },
          label: 'local test candidate',
          repositoryRoot: root,
        }), new RegExp(name))
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

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

  it('resolves a package-script runner from the package-manager execution PATH', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-package-runner-'))
    const bin = path.join(root, 'bin')
    const packageBin = path.join(root, 'node_modules', '.bin')
    const npmExecutable = path.join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm')
    const playwrightExecutable = path.join(packageBin, process.platform === 'win32' ? 'playwright.cmd' : 'playwright')
    fs.mkdirSync(bin, { recursive: true })
    fs.mkdirSync(packageBin, { recursive: true })
    fs.writeFileSync(npmExecutable, '')
    fs.writeFileSync(playwrightExecutable, '')
    fs.chmodSync(npmExecutable, 0o755)
    fs.chmodSync(playwrightExecutable, 0o755)
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: { test: 'playwright test' },
    }))
    const command = {
      cwd: root,
      argv: [path.basename(npmExecutable), 'run', 'test'],
      env: { PATH: bin },
    }

    try {
      assert.strictEqual(getUnavailableExecutable(command, root), undefined)
      fs.rmSync(playwrightExecutable)
      assert.strictEqual(getUnavailableExecutable(command, root), 'playwright')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('detects an executable replaced after approval before it can be spawned', async function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-executable-approval-'))
    const bin = path.join(root, 'bin')
    const executable = path.join(bin, 'jest')
    const marker = path.join(root, 'changed-executable-ran')
    const out = path.join(root, 'results')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: ['jest'],
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

  it('detects a Node.js program replaced after approval before it can be spawned', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-node-entrypoint-'))
    const runner = path.join(root, 'jest-runner.js')
    const marker = path.join(root, 'changed-runner-ran')
    const out = path.join(root, 'results')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = { cwd: root, argv: [process.execPath, runner] }
    const manifest = {
      __path: path.join(root, 'manifest.json'),
      repository: { root },
      frameworks: [framework],
    }
    fs.writeFileSync(runner, 'process.exit(0)\n')

    try {
      formatExecutionPlan({ manifest, out, requestedScenario: 'basic-reporting' })
      const approval = JSON.parse(fs.readFileSync(path.join(out, 'approval.json'), 'utf8'))
      const basicReporting = approval.executables.find(entry => entry.label.endsWith(':basic-reporting'))
      assert.strictEqual(basicReporting.entrypoints[0].path, fs.realpathSync(runner))
      if (process.platform !== 'win32') {
        assert.match(
          fs.readFileSync(path.join(out, 'approval-files.sha256'), 'utf8'),
          new RegExp(`${escapeRegExp(fs.realpathSync(runner))}$`, 'm')
        )
      }

      fs.writeFileSync(runner, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`)

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

  for (const [name, getArguments] of [
    ['require', (preload, runner) => ['--require', preload, runner]],
    ['import', (preload, runner) => [`--import=${preload}`, runner]],
    ['loader', (preload, runner) => ['--loader', preload, runner]],
    ['experimental loader', (preload, runner) => ['--experimental-loader', preload, runner]],
  ]) {
    it(`detects a Node.js ${name} module replaced after approval`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `dd-validation-node-${name}-`))
      const preload = path.join(root, 'preload.js')
      const runner = path.join(root, 'jest-runner.js')
      const out = path.join(root, 'results')
      const framework = getPlannedFramework(
        root,
        path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
        path.join(root, '.dd-validation-state')
      )
      framework.existingTestCommand = {
        cwd: root,
        argv: [process.execPath, ...getArguments(preload, runner)],
      }
      fs.writeFileSync(preload, 'globalThis.loaded = true\n')
      fs.writeFileSync(runner, 'process.exit(0)\n')

      try {
        formatExecutionPlan({
          manifest: {
            __path: path.join(root, 'manifest.json'),
            repository: { root },
            frameworks: [framework],
          },
          out,
          requestedScenario: 'basic-reporting',
        })
        const approval = JSON.parse(fs.readFileSync(path.join(out, 'approval.json'), 'utf8'))
        const basicReporting = approval.executables.find(entry => entry.label.endsWith(':basic-reporting'))
        assert.deepStrictEqual(basicReporting.entrypoints.map(entry => entry.path), [
          fs.realpathSync(preload),
          fs.realpathSync(runner),
        ])

        fs.writeFileSync(preload, 'globalThis.loaded = false\n')

        assert.throws(() => getExecutableForSpawn(framework.existingTestCommand), /changed after approval/)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  for (const [name, getArguments, expected] of [
    [
      'environment file',
      (input, runner) => [`--env-file=${input}`, runner],
      /Node\.js option "--env-file".*undisclosed environment/s,
    ],
    [
      'optional environment file',
      (input, runner) => [`--env-file-if-exists=${input}`, runner],
      /Node\.js option "--env-file-if-exists".*undisclosed environment/s,
    ],
    [
      'experimental config file',
      (input, runner) => [`--experimental-config-file=${input}`, runner],
      /Node\.js option "--experimental-config-file".*undisclosed environment/s,
    ],
    [
      'default experimental config file',
      (input, runner) => ['--experimental-default-config-file', runner],
      /Node\.js option "--experimental-default-config-file".*undisclosed environment/s,
    ],
    [
      'test global setup',
      (input, runner) => [`--test-global-setup=${input}`, runner],
      /Node\.js option "--test-global-setup".*test-hook input/s,
    ],
    [
      'custom test reporter',
      (input, runner) => [`--test-reporter=${input}`, runner],
      /Node\.js option "--test-reporter".*test-hook input/s,
    ],
    [
      'snapshot blob',
      (input, runner) => [`--snapshot-blob=${input}`, runner],
      /Node\.js option "--snapshot-blob".*snapshot/s,
    ],
    [
      'test snapshot update',
      (input, runner) => ['--test-update-snapshots', runner],
      /Node\.js option "--test-update-snapshots".*snapshot/s,
    ],
  ]) {
    it(`rejects a Node.js ${name} before approval`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-node-file-option-'))
      const input = path.join(root, name.includes('environment') ? '.env' : 'input.js')
      const preload = path.join(root, 'preload.js')
      const runner = path.join(root, 'jest-runner.js')
      const framework = getPlannedFramework(
        root,
        path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
        path.join(root, '.dd-validation-state')
      )
      framework.existingTestCommand = {
        cwd: root,
        argv: [process.execPath, ...getArguments(input, runner)],
      }
      fs.writeFileSync(preload, 'globalThis.loaded = true\n')
      const inputContent = name.includes('config')
        ? JSON.stringify({ nodeOptions: { import: [preload] } })
        : name.includes('environment')
          ? `NODE_OPTIONS=--require ${preload}\n`
          : `require(${JSON.stringify(preload)})\n`
      fs.writeFileSync(input, inputContent)
      fs.writeFileSync(runner, 'process.exit(0)\n')

      try {
        assert.throws(() => formatExecutionPlan({
          manifest: {
            __path: path.join(root, 'manifest.json'),
            repository: { root },
            frameworks: [framework],
          },
          out: path.join(root, 'results'),
          requestedScenario: 'basic-reporting',
        }), expected)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('rejects an unclassified Node.js option before the program entrypoint', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-node-unknown-option-'))
    const runner = path.join(root, 'jest-runner.js')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: [process.execPath, '--future-code-loader=./loader.js', runner],
    }
    fs.writeFileSync(runner, 'process.exit(0)\n')

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
        requestedScenario: 'basic-reporting',
      }), /unsupported or unclassified Node\.js option "--future-code-loader/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  for (const [source, configureCommand] of [
    ['command.env.NODE_OPTIONS', (framework, root, runner) => {
      framework.existingTestCommand = {
        cwd: root,
        argv: [process.execPath, runner],
        env: { NODE_OPTIONS: '--env-file=.env' },
      }
    }],
    ['a package-script expansion', (framework, root) => {
      framework.existingTestCommand = { cwd: root, argv: ['npm', 'run', 'test'] }
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        scripts: { test: 'NODE_OPTIONS=--env-file=.env node jest-runner.js' },
      }))
    }],
    ['a shell command environment assignment', (framework, root) => {
      framework.existingTestCommand = {
        cwd: root,
        usesShell: true,
        shellCommand: 'NODE_OPTIONS=--env-file=.env node jest-runner.js',
      }
    }],
  ]) {
    it(`rejects a Node.js environment file supplied through ${source}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-node-options-source-'))
      const runner = path.join(root, 'jest-runner.js')
      const framework = getPlannedFramework(
        root,
        path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
        path.join(root, '.dd-validation-state')
      )
      configureCommand(framework, root, runner)
      fs.writeFileSync(path.join(root, '.env'), 'NODE_OPTIONS=--require ./preload.js\n')
      fs.writeFileSync(path.join(root, 'preload.js'), 'globalThis.loaded = true\n')
      fs.writeFileSync(runner, 'process.exit(0)\n')

      try {
        assert.throws(() => formatExecutionPlan({
          manifest: {
            __path: path.join(root, 'manifest.json'),
            repository: { root },
            frameworks: [framework],
          },
          out: path.join(root, 'results'),
          requestedScenario: 'basic-reporting',
        }), /Node\.js option "--env-file".*undisclosed environment/s)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('accepts classified Node.js options and leaves application arguments after the entrypoint alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-node-classified-options-'))
    const preload = path.join(root, 'preload.js')
    const runner = path.join(root, 'jest-runner.js')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: [
        process.execPath,
        '--no-warnings',
        '--max-old-space-size=4096',
        '--require',
        preload,
        runner,
        '--env-file=.application-argument',
      ],
    }
    fs.writeFileSync(preload, 'globalThis.loaded = true\n')
    fs.writeFileSync(runner, 'process.exit(0)\n')

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
      fs.writeFileSync(preload, 'globalThis.loaded = false\n')

      assert.throws(() => getExecutableForSpawn(framework.existingTestCommand), /changed after approval/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  for (const [name, getNodeOptions] of [
    ['require', preload => `--require "${preload}"`],
    ['import', preload => `--import='${preload}'`],
    ['loader', preload => `--loader "${preload}"`],
  ]) {
    it(`detects a Node.js ${name} module from NODE_OPTIONS replaced after approval`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `dd-validation-node-options-${name}-`))
      const moduleDirectory = path.join(root, 'execution files')
      const preload = path.join(moduleDirectory, 'preload.js')
      const runner = path.join(root, 'jest-runner.js')
      const out = path.join(root, 'results')
      const framework = getPlannedFramework(
        root,
        path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
        path.join(root, '.dd-validation-state')
      )
      framework.existingTestCommand = {
        cwd: root,
        argv: [process.execPath, runner],
        env: { NODE_OPTIONS: getNodeOptions(preload) },
      }
      fs.mkdirSync(moduleDirectory)
      fs.writeFileSync(preload, 'globalThis.loaded = true\n')
      fs.writeFileSync(runner, 'process.exit(0)\n')

      try {
        formatExecutionPlan({
          manifest: {
            __path: path.join(root, 'manifest.json'),
            repository: { root },
            frameworks: [framework],
          },
          out,
          requestedScenario: 'basic-reporting',
        })
        const approval = JSON.parse(fs.readFileSync(path.join(out, 'approval.json'), 'utf8'))
        const basicReporting = approval.executables.find(entry => entry.label.endsWith(':basic-reporting'))
        assert.deepStrictEqual(basicReporting.entrypoints.map(entry => entry.path), [
          fs.realpathSync(preload),
          fs.realpathSync(runner),
        ])

        fs.writeFileSync(preload, 'globalThis.loaded = false\n')

        assert.throws(() => getExecutableForSpawn(framework.existingTestCommand), /changed after approval/)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('rejects a bare NODE_OPTIONS preload when command NODE_PATH can change its resolution', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-node-path-preload-'))
    const moduleRoot = path.join(root, 'safe-modules', 'selected-preload')
    const runner = path.join(root, 'jest-runner.js')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: [process.execPath, runner],
      env: {
        NODE_OPTIONS: '--require selected-preload',
        NODE_PATH: path.dirname(moduleRoot),
      },
    }
    fs.mkdirSync(moduleRoot, { recursive: true })
    fs.writeFileSync(path.join(moduleRoot, 'index.js'), 'globalThis.loaded = true\n')
    fs.writeFileSync(path.join(moduleRoot, 'package.json'), JSON.stringify({ main: 'index.js' }))
    fs.writeFileSync(runner, 'process.exit(0)\n')

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
        requestedScenario: 'basic-reporting',
      }), /bare Node\.js preload while NODE_PATH is set/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts classified underscore aliases in NODE_OPTIONS and still fingerprints preloads', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-node-option-alias-'))
    const preload = path.join(root, 'preload.js')
    const runner = path.join(root, 'jest-runner.js')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: [process.execPath, runner],
      env: { NODE_OPTIONS: '--max_old_space_size=4096 --require ./preload.js' },
    }
    fs.writeFileSync(preload, 'globalThis.loaded = true\n')
    fs.writeFileSync(runner, 'process.exit(0)\n')

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
      fs.writeFileSync(preload, 'globalThis.loaded = false\n')

      assert.throws(() => getExecutableForSpawn(framework.existingTestCommand), /changed after approval/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a Node.js program whose physical path escapes the repository', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-node-entrypoint-root-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-node-entrypoint-outside-'))
    const runner = path.join(root, 'jest-runner.js')
    const outsideRunner = path.join(outside, 'runner.js')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = { cwd: root, argv: [process.execPath, runner] }
    fs.writeFileSync(outsideRunner, 'process.exit(0)\n')
    fs.symlinkSync(outsideRunner, runner)

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
        requestedScenario: 'basic-reporting',
      }), /Node\.js program entrypoint resolves outside the repository/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects a Node.js preload whose physical path escapes the repository', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-node-preload-root-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-node-preload-outside-'))
    const preload = path.join(root, 'preload.js')
    const outsidePreload = path.join(outside, 'preload.js')
    const runner = path.join(root, 'jest-runner.js')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: [process.execPath, '--require', preload, runner],
    }
    fs.writeFileSync(outsidePreload, 'globalThis.loaded = true\n')
    fs.writeFileSync(runner, 'process.exit(0)\n')
    fs.symlinkSync(outsidePreload, preload)

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
        requestedScenario: 'basic-reporting',
      }), /Node\.js preload module resolves outside the repository/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('detects package lifecycle changes after approval', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-package-script-approval-'))
    const packageJson = path.join(root, 'package.json')
    const runner = path.join(root, 'jest-runner.js')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = { cwd: root, argv: ['npm', 'run', 'test'] }
    fs.writeFileSync(packageJson, JSON.stringify({ scripts: { test: 'node jest-runner.js' } }))
    fs.writeFileSync(runner, 'process.exit(0)\n')

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
      fs.writeFileSync(packageJson, JSON.stringify({
        scripts: { test: 'node jest-runner.js', posttest: 'node unexpected.js' },
      }))

      assert.throws(() => getExecutableForSpawn(framework.existingTestCommand), /changed after approval/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('detects a Node.js preload reached through a package script when it changes after approval', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-package-script-node-files-'))
    const preload = path.join(root, 'preload.js')
    const runner = path.join(root, 'jest-runner.js')
    const out = path.join(root, 'results')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = { cwd: root, argv: ['npm', 'run', 'test'] }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: { test: 'node --require ./preload.js ./jest-runner.js' },
    }))
    fs.writeFileSync(preload, 'globalThis.loaded = true\n')
    fs.writeFileSync(runner, 'process.exit(0)\n')

    try {
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out,
        requestedScenario: 'basic-reporting',
      })
      const approval = JSON.parse(fs.readFileSync(path.join(out, 'approval.json'), 'utf8'))
      const basicReporting = approval.executables.find(entry => entry.label.endsWith(':basic-reporting'))
      assert.deepStrictEqual(basicReporting.entrypoints.map(entry => entry.path), [
        fs.realpathSync(preload),
        fs.realpathSync(runner),
        fs.realpathSync(path.join(root, 'package.json')),
      ])

      fs.writeFileSync(preload, 'globalThis.loaded = false\n')

      assert.throws(() => getExecutableForSpawn(framework.existingTestCommand), /changed after approval/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('fingerprints an env-wrapped command target and rejects its replacement after approval', function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-env-target-'))
    const bin = path.join(root, 'bin')
    const target = path.join(bin, 'jest')
    const out = path.join(root, 'results')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: ['/usr/bin/env', `PATH=${bin}`, 'jest'],
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

  for (const packageManager of ['npm', 'pnpm', 'yarn']) {
    it(`allows an external ${packageManager} launcher while approval-binding its repository runner`, function () {
      if (process.platform === 'win32') this.skip()

      const root = fs.mkdtempSync(path.join(os.tmpdir(), `dd-validation-external-${packageManager}-`))
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), `dd-validation-external-${packageManager}-bin-`))
      const manager = path.join(outside, packageManager)
      const runnerDirectory = path.join(root, 'node_modules', '.bin')
      const runner = path.join(runnerDirectory, 'jest')
      const generatedFile = path.join(root, 'test', 'dd-test-optimization-validation.test.js')
      const framework = getPlannedFramework(root, generatedFile)

      fs.mkdirSync(runnerDirectory, { recursive: true })
      fs.writeFileSync(manager, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      fs.writeFileSync(runner, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        scripts: { test: 'jest' },
      }))
      for (const scenario of framework.generatedTestStrategy.scenarios) {
        scenario.runCommand = {
          cwd: root,
          argv: [
            manager,
            'run',
            'test',
            ...(packageManager === 'npm' ? ['--'] : []),
            scenario.testIdentities[0].file,
          ],
        }
      }

      try {
        const out = path.join(root, 'results')
        formatExecutionPlan({
          manifest: {
            __path: path.join(root, 'manifest.json'),
            repository: { root },
            frameworks: [framework],
          },
          out,
          requestedScenario: 'atr',
        })

        const approval = JSON.parse(fs.readFileSync(path.join(out, 'approval.json'), 'utf8'))
        const generatedIdentity = approval.executables.find(entry => entry.label.endsWith(':generated:0'))
        assert.strictEqual(generatedIdentity.path, fs.realpathSync(manager))
        assert.strictEqual(generatedIdentity.delegated.at(-1).path, fs.realpathSync(runner))

        fs.writeFileSync(manager, '#!/bin/sh\nexit 42\n', { mode: 0o755 })
        assert.throws(
          () => getExecutableForSpawn(framework.generatedTestStrategy.scenarios[0].runCommand),
          /changed after approval/
        )
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })
  }

  it('preserves approved named-shim semantics while executing the canonical target', async function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-named-shim-'))
    const bin = path.join(root, 'bin')
    const shim = path.join(bin, 'node')
    const marker = path.join(root, 'named-shim-ran')
    const runner = path.join(root, 'jest-runner.js')
    const out = path.join(root, 'results')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: [
        'node',
        runner,
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
    fs.writeFileSync(runner, [
      "if (require('node:path').basename(process.argv0) !== 'node') process.exit(126)",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'named-shim')`,
      '',
    ].join('\n'))

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

  it('preserves a disclosed project Yarn command when the repository pins a Yarn release', () => {
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
      const plan = formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      })

      assert.match(plan, /yarn test/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not synthesize Corepack for a disclosed project Yarn command', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-yarn-plan-'))
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = { cwd: root, argv: ['yarn', 'test'] }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.10.0' }))

    try {
      const plan = formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      })

      assert.match(plan, /yarn test/)
      assert.doesNotMatch(plan, /corepack/i)
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
        lifecycle: [],
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

  for (const [name, scripts, expected] of [
    ['pretest lifecycle', { pretest: 'node prepare.js', test: 'mocha' }, /undisclosed lifecycle script "pretest"/],
    ['posttest lifecycle', { test: 'mocha', posttest: 'node cleanup.js' }, /undisclosed lifecycle script "posttest"/],
    ['compound setup', { test: 'npm run build && mocha' }, /compound shell command/],
    ['newline-separated setup', { test: 'node prepare.js\nmocha' }, /compound shell command/],
    ['command substitution', { test: 'mocha $(node prepare.js)' }, /dynamic shell evaluation/],
    ['nested shell', { test: 'sh -c "node prepare.js && mocha"' }, /nested shell interpreter "sh"/],
    ['env-wrapped nested shell', { test: 'env SAFE=1 sh -c "node prepare.js && mocha"' }, /nested shell interpreter "sh"/],
    ['cross-env shell', { test: 'cross-env-shell NODE_ENV=test "node prepare.js && mocha"' }, /nested shell interpreter "cross-env-shell"/],
    ['dynamic shell', { test: '$SHELL -c "node prepare.js && mocha"' }, /dynamic command word "\$SHELL"/],
    ['dynamic runner', { test: '$RUNNER --runInBand' }, /dynamic command word "\$RUNNER"/],
    ['command wrapper', { test: 'command sh -c "node prepare.js && mocha"' }, /unsupported wrapper or command "command"/],
    ['exec wrapper', { test: 'exec sh -c "node prepare.js && mocha"' }, /unsupported wrapper or command "exec"/],
    ['nice wrapper', { test: 'nice sh -c "node prepare.js && mocha"' }, /unsupported wrapper or command "nice"/],
    ['npx wrapper', { test: 'npx sh -c "node prepare.js && mocha"' }, /unsupported wrapper or command "npx"/],
    ['nested package script', { test: 'npm run test:unit', 'test:unit': 'mocha' }, /another package script/],
  ]) {
    it(`rejects a package command with ${name}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-package-lifecycle-'))
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }))

      try {
        assert.match(getCommandSuitabilityError({
          command: { cwd: root, argv: ['npm', 'run', 'test'] },
          framework: { framework: 'mocha', project: { root, configFiles: [] } },
          label: 'the selected test command',
          repositoryRoot: root,
        }), expected)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  for (const script of ['NODE_ENV=test mocha', 'env NODE_ENV=test mocha', 'env env NODE_ENV=test mocha']) {
    it(`accepts the direct runner package script ${JSON.stringify(script)}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-direct-package-runner-'))
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: script } }))

      try {
        assert.strictEqual(getCommandSuitabilityError({
          command: { cwd: root, argv: ['npm', 'run', 'test'] },
          framework: { framework: 'mocha', project: { root, configFiles: [] } },
          label: 'the selected test command',
          repositoryRoot: root,
        }), undefined)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('rejects cross-env instead of trusting an unbound package-script wrapper', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cross-env-package-runner-'))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: { test: 'cross-env NODE_ENV=test mocha' },
    }))

    try {
      assert.match(getCommandSuitabilityError({
        command: { cwd: root, argv: ['npm', 'run', 'test'] },
        framework: { framework: 'mocha', project: { root, configFiles: [] } },
        label: 'the selected test command',
        repositoryRoot: root,
      }), /unsupported wrapper or command "cross-env"/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a shell-form package command with undisclosed lifecycle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-shell-package-lifecycle-'))

    try {
      assert.match(getCommandSuitabilityError({
        command: { cwd: root, usesShell: true, shellCommand: 'npm test' },
        framework: { framework: 'mocha', project: { root, configFiles: [] } },
        label: 'the selected test command',
        repositoryRoot: root,
      }), /structured direct command with an argv array/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  for (const source of [
    '/usr/bin/npm test',
    './bin/npm test',
    '"npm" test',
    'n\\pm test',
    'npm.cmd test',
    'pnpm.cmd test',
    'yarn.cmd test',
    'yarnpkg test',
    'corepack npm test',
    'env npm test',
    'command npm test',
    'exec npm test',
    '$RUNNER test',
    '%RUNNER% test',
    'sh -c "npm test"',
  ]) {
    it(`rejects shell-form package-manager or wrapper command ${JSON.stringify(source)}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-shell-package-bypass-'))

      try {
        assert.match(getCommandSuitabilityError({
          command: { cwd: root, usesShell: true, shellCommand: source },
          framework: { framework: 'mocha', project: { root, configFiles: [] } },
          label: 'the selected test command',
          repositoryRoot: root,
        }), /structured direct command with an argv array/)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  for (const lifecycle of ['pretest', 'posttest']) {
    it(`discloses a trusted project package command with ${lifecycle} without running project code`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-shell-package-plan-'))
      const marker = path.join(root, 'project-code-ran')
      const framework = getPlannedFramework(
        root,
        path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
        path.join(root, '.dd-validation-state')
      )
      framework.existingTestCommand = { cwd: root, usesShell: true, shellCommand: 'npm test' }
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        scripts: {
          [lifecycle]: `node -e "require('node:fs').writeFileSync('${marker}', 'ran')"`,
          test: 'node dd-test-optimization-validation-jest-runner.js',
        },
      }))

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

        assert.match(plan, new RegExp(`lifecycle script \\\`${lifecycle}\\\``))
        assert.match(plan, /npm test/)
        assert.strictEqual(fs.existsSync(marker), false)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('approval-binds the Node.js program selected by a safe shell command', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-shell-direct-node-'))
    const runner = path.join(root, 'jest-runner.js')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      usesShell: true,
      shellCommand: `node ${JSON.stringify(runner)}`,
    }
    fs.writeFileSync(runner, 'process.exit(0)\n')

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
      fs.writeFileSync(runner, 'process.exit(42)\n')

      assert.throws(() => getExecutableForSpawn(framework.existingTestCommand), /changed after approval/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a checked-in Yarn release symlink that escapes the repository', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-yarn-release-root-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-yarn-release-outside-'))
    const releases = path.join(root, '.yarn', 'releases')
    fs.mkdirSync(releases, { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'mocha' } }))
    fs.writeFileSync(path.join(outside, 'yarn-4.4.1.cjs'), '')
    fs.symlinkSync(path.join(outside, 'yarn-4.4.1.cjs'), path.join(releases, 'yarn-4.4.1.cjs'))

    try {
      assert.match(getCommandSuitabilityError({
        command: { cwd: root, argv: ['yarn', 'test'] },
        framework: { framework: 'mocha', project: { root, configFiles: [] } },
        label: 'the selected test command',
        repositoryRoot: root,
      }), /symlink or resolves outside the repository/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
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
          lifecycle: [],
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
          lifecycle: [],
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

  it('discloses a trusted project Vitest typecheck command for timeout-limited preflight validation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-typecheck-plan-'))
    const binDirectory = path.join(root, 'node_modules', '.bin')
    const executable = path.join(binDirectory, process.platform === 'win32' ? 'vitest.cmd' : 'vitest')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'dd-test-optimization-validation.test.ts'),
      path.join(root, '.dd-validation-state')
    )
    setGeneratedTestFramework(framework, 'vitest')
    fs.mkdirSync(binDirectory, { recursive: true })
    fs.writeFileSync(executable, '')
    fs.chmodSync(executable, 0o755)
    framework.existingTestCommand = {
      cwd: root,
      argv: ['vitest', '--typecheck'],
      env: { PATH: `${binDirectory}${path.delimiter}${process.env.PATH}` },
    }

    try {
      const plan = formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      })

      assert.match(plan, /vitest --typecheck/)
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
      argv: [nodeShim, path.join(root, 'dd-test-optimization-validation-jest-runner.js')],
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
  const runner = path.join(root, 'dd-test-optimization-validation-jest-runner.js')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(runner, [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const filename = process.argv.at(-1) || ''",
    "if (filename.includes('atr-fail-once')) {",
    "  fs.writeFileSync(path.join(path.dirname(filename), '.dd-test-optimization-validation-atr-state'), 'state')",
    "  console.log('Tests: 1 failed, 1 total')",
    '  process.exit(1)',
    '}',
    "console.log('Tests: 1 passed, 1 total')",
    '',
  ].join('\n'))
  return {
    id: 'jest:root',
    framework: 'jest',
    status: 'runnable',
    project: { root },
    existingTestCommand: {
      cwd: root,
      argv: [process.execPath, runner],
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
        return getScenario(root, id, id === 'atr-fail-once' ? 1 : 0, filename)
      }),
      cleanupPaths: [...Object.values(generatedFiles), stateFile],
    },
  }
}

function getScenario (root, id, exitCode, filename) {
  return {
    id,
    runCommand: {
      cwd: root,
      argv: [process.execPath, path.join(root, 'dd-test-optimization-validation-jest-runner.js'), filename],
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
