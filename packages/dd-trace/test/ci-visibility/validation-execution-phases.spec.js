'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  cleanupGeneratedFiles,
} = require('../../../../ci/test-optimization-validation/generated-files')
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

  it('prints normalized commands and absolute paths without executing project code', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-plan-'))
    const manifestPath = path.join(root, 'manifest.json')
    const generatedFile = path.join(root, 'tests', 'dd-test-optimization-validation.test.js')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-test-optimization-validation'))
    framework.existingTestCommand = {
      cwd: root,
      argv: ['pnpm', 'test', '--token', 'plan-secret'],
    }
    framework.ciWiring = {
      status: 'unknown',
      reason: 'Replay selected.',
    }
    framework.ciWiringCommand = {
      cwd: root,
      argv: ['pnpm', 'test'],
      env: {
        CI: 'true',
        DD_API_KEY: 'safe-placeholder',
      },
    }
    const manifest = {
      __path: manifestPath,
      repository: { root },
      frameworks: [framework],
    }

    try {
      const plan = formatExecutionPlan({
        manifest,
        out: path.join(root, 'results'),
        selectedFrameworkIds: ['jest:root'],
        requestedScenario: 'atr',
      })

      assert.match(plan, /Approve executing exactly the plan above\?/)
      assert.match(plan, /--no-watchman/)
      assert.match(plan, new RegExp(escapeRegExp(generatedFile)))
      assert.match(plan, /CI environment variables copied for this test \(values hidden\): CI, DD_API_KEY/)
      assert.match(plan, /#### Test Execution Without Datadog/)
      assert.match(plan, /#### Test Execution With Datadog/)
      assert.match(plan, /#### Test Execution With CI Configuration/)
      assert.match(plan, /#### Temporary Tests Created for Advanced Checks/)
      assert.match(plan, /#### Advanced Check: Early Flake Detection/)
      assert.match(plan, /#### Advanced Check: Auto Test Retries/)
      assert.match(plan, /#### Advanced Check: Test Management/)
      assert.match(plan, /#### Files Removed After Validation/)
      assert.match(plan, /## Start the Validation/)
      assert.match(plan, /validator included with the installed `dd-trace` package/)
      assert.match(plan, /does not require real Datadog credentials, inspect credential stores, or upload/)
      assert.doesNotMatch(plan, /- Confirm the selected test command/)
      assert.doesNotMatch(plan, /Credential exposure: unknown/)
      assert.doesNotMatch(plan, /safe-placeholder/)
      assert.doesNotMatch(plan, /plan-secret/)
      assert.match(plan, /--framework jest:root --scenario atr/)
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
      assert.doesNotMatch(plan, /--manifest|--out|\.pnpm/)
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
})

function getPlannedFramework (root, generatedFile, stateFile) {
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
      files: [{
        path: generatedFile,
        contentLines: ['// generated validation test'],
      }],
      scenarios: [
        getScenario(root, 'basic-pass', 0),
        getScenario(root, 'atr-fail-once', 1, stateFile),
        getScenario(root, 'test-management-target', 0),
      ],
      cleanupPaths: [generatedFile, stateFile],
    },
  }
}

function getScenario (root, id, exitCode, stateFile) {
  const script = stateFile
    ? `require('node:fs').writeFileSync(${JSON.stringify(stateFile)}, 'state'); ` +
      'console.log("Tests: 1 failed, 1 total"); process.exit(1)'
    : `console.log("Tests: 1 passed, 1 total"); process.exit(${exitCode})`
  return {
    id,
    runCommand: {
      cwd: root,
      argv: [process.execPath, '-e', script],
    },
    expectedWithoutDatadog: {
      exitCode,
      observedTestCount: 1,
    },
    testIdentities: [{ name: id, file: path.join(root, `${id}.test.js`) }],
  }
}

function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}
