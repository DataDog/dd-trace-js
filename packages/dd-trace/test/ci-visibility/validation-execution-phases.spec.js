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
      status: 'unknown',
      reason: 'Replay selected.',
    }
    framework.ciWiringCommand = {
      cwd: root,
      usesShell: true,
      shellCommand: 'pnpm test',
      env: {
        CI: 'true',
        DD_API_KEY: 'safe-placeholder',
      },
    }
    framework.ciWiring.shell = 'bash --noprofile --norc {0}'
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
      const fullPlan = formatExecutionPlan({
        manifest,
        out: path.join(root, 'results'),
        selectedFrameworkIds: ['jest:root'],
      })
      const ciOnlyPlan = formatExecutionPlan({
        manifest,
        out: path.join(root, 'results'),
        selectedFrameworkIds: ['jest:root'],
        requestedScenario: 'ci-wiring',
      })

      assert.match(plan, /The exact command above requires one approval before execution\./)
      assert.doesNotMatch(plan, /Approve executing exactly the plan above\?/)
      assert.match(plan, /--no-watchman/)
      assert.match(plan, new RegExp(escapeRegExp(path.relative(root, generatedFile))))
      assert.doesNotMatch(plan, new RegExp(`Path: .*${escapeRegExp(generatedFile)}`))
      assert.match(plan, /npm test -- --runInBand --token <redacted> --no-watchman/)
      assert.doesNotMatch(plan, /echo harmless-display-command/)
      assert.match(plan, /BASH_ENV=\.\/project-shell-init/)
      assert.match(plan, /Command-created outputs: `coverage` \(pre-existing paths are restored; newly created /)
      assert.match(fullPlan, /Copy CI variables: CI, DD_API_KEY/)
      assert.match(fullPlan, /DD_API_KEY=<redacted>/)
      assert.match(fullPlan, /bash --noprofile --norc -c "pnpm test"/)
      assert.match(ciOnlyPlan, /Check the real CI configuration/)
      assert.doesNotMatch(ciOnlyPlan, /#### Temporary Tests Created for Advanced Checks/)
      assert.match(plan, /Confirm tests run without Datadog/)
      assert.match(plan, /Confirm tests report when Datadog is initialized/)
      assert.doesNotMatch(plan, /Check the real CI configuration/)
      assert.match(plan, /#### Temporary Tests Created for Advanced Checks/)
      assert.match(plan, /Advanced Check: Auto Test Retries/)
      assert.doesNotMatch(plan, /Advanced Check: Early Flake Detection/)
      assert.doesNotMatch(plan, /Advanced Check: Test Management/)
      assert.doesNotMatch(plan, /#### Generated Test Verification:/)
      assert.match(fullPlan, /1, plus 1 short preload probe when needed/)
      assert.match(plan, /3: isolate, discover identity, validate feature/)
      assert.match(plan, /#### Temporary Test Cleanup/)
      assert.match(plan, /Paths are relative to the repository root/)
      assert.match(plan, /<details><summary>`tests\/dd-test-optimization-validation\.test\.js`<\/summary>/)
      assert.match(plan, /\/\/ generated validation test/)
      assert.match(plan, /- Working directory: `\.`/)
      assert.strictEqual(countOccurrences(fullPlan, 'bash --noprofile --norc -c "pnpm test"'), 1)
      assert.match(plan, /## Start the Validation/)
      assert.match(plan, /local validator included with the installed `dd-trace` package/)
      assert.match(plan, /starts a mock intake on `127\.0\.0\.1`/)
      assert.match(plan, /does not require real Datadog credentials, inspect credential stores, or upload/)
      assert.doesNotMatch(plan, /- Confirm the selected test command/)
      assert.doesNotMatch(plan, /Credential exposure: unknown/)
      assert.doesNotMatch(fullPlan, /safe-placeholder/)
      assert.doesNotMatch(plan, /plan-secret/)
      assert.match(plan, /--approved-plan-sha256 [a-f0-9]{64} --framework jest:root --scenario atr/)
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
      assert.match(plan, /--approved-plan-sha256 [a-f0-9]{64}/)
      assert.doesNotMatch(plan, /--manifest|--out|\.pnpm/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an approval plan whose structured command executable is unavailable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-unavailable-plan-'))
    const generatedFile = path.join(root, 'tests', 'dd-test-optimization-validation.test.js')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-validation-state'))
    framework.ciWiringCommand = {
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

  it('rejects ambient Yarn when the repository pins a Yarn release', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-yarn-plan-'))
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.ciWiringCommand = { cwd: root, argv: ['yarn', 'test'] }
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

  it('rejects generated Vitest runtime tests under a typecheck-enabled config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-plan-'))
    const generatedFile = path.join(root, 'tests', 'dd-test-optimization-validation.test.ts')
    const configFile = path.join(root, 'vitest.config.ts')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-validation-state'))
    framework.framework = 'vitest'
    framework.generatedTestStrategy.fileExtension = '.test.ts'
    fs.writeFileSync(configFile, 'export default { test: { typecheck: { enabled: true } } }\n')
    for (const scenario of framework.generatedTestStrategy.scenarios) {
      scenario.runCommand = {
        cwd: root,
        argv: [process.execPath, 'vitest.mjs', 'run', '--config', configFile, generatedFile],
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

  it('rejects a selected Vitest command under a typecheck-enabled config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-typecheck-plan-'))
    const configFile = path.join(root, 'vitest.config.ts')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'dd-test-optimization-validation.test.ts'),
      path.join(root, '.dd-validation-state')
    )
    framework.framework = 'vitest'
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

  it('rejects an unknown absolute Node shim for direct Vitest validation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-node-shim-'))
    const nodeShim = path.join(root, 'node')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'dd-test-optimization-validation.test.ts'),
      path.join(root, '.dd-validation-state')
    )
    framework.framework = 'vitest'
    framework.existingTestCommand = {
      cwd: root,
      argv: [nodeShim, '-e', ''],
    }
    fs.writeFileSync(nodeShim, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      }), /alternate Node executable.*Use "node".*process\.execPath/s)

      framework.existingTestCommand.argv[0] = process.execPath
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

  it('allows approved setup to provide executables used by later validation commands', () => {
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
      const plan = formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
        requestedScenario: 'basic-reporting',
      })

      assert.match(plan, /Project setup: install-test-runner/)
      assert.match(plan, /test-runner-installed-by-setup test/)
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

function countOccurrences (value, search) {
  return value.split(search).length - 1
}
