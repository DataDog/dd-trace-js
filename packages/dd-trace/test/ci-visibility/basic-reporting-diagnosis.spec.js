'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const proxyquire = require('proxyquire').noPreserveCache()

const {
  getDebugAwareDiagnosis,
  getBasicReportingCommand,
  getMissingEventDiagnosis,
  refineBasicReportingFailure,
  shouldRunDebugRerun,
  summarizeTestOutput,
} = require('../../../../ci/test-optimization-validation/scenarios/basic-reporting')
const {
  tailInterestingLines,
} = require('../../../../ci/test-optimization-validation/scenarios/helpers')

describe('test optimization basic reporting diagnosis', () => {
  it('uses existingTestCommand for direct-initialization Basic Reporting', () => {
    const existingTestCommand = { argv: ['npm', 'test'] }

    assert.strictEqual(getBasicReportingCommand({
      existingTestCommand,
    }), existingTestCommand)
  })

  it('reruns the clean command and reports an unstable baseline when its exit changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-confirmation-'))
    let cleanRuns = 0
    const { runBasicReporting } = getBasicReportingWithExitMismatch({
      cleanExitCode: 1,
      onCleanRun: () => cleanRuns++,
    })
    const framework = getExitMismatchFramework(root)

    try {
      const result = await runBasicReporting({ framework, out: root, options: { repositoryRoot: root } })

      assert.strictEqual(cleanRuns, 1)
      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.validationIncomplete, true)
      assert.strictEqual(result.evidence.cleanConfirmation.exitMatchesPreflight, false)
      assert.match(result.diagnosis, /non-Datadog baseline was not stable/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a possible compatibility issue when both clean exits agree', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-confirmation-'))
    const { runBasicReporting } = getBasicReportingWithExitMismatch({ cleanExitCode: 0 })
    const framework = getExitMismatchFramework(root)

    try {
      const result = await runBasicReporting({ framework, out: root, options: { repositoryRoot: root } })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.cleanConfirmation.exitMatchesPreflight, true)
      assert.match(result.diagnosis, /may indicate a dd-trace compatibility issue/)
      assert.doesNotMatch(result.diagnosis, /pre-existing/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('explains Vitest benchmark mode without scheduling a debug rerun', () => {
    const eventLevelFailure = getMissingEventDiagnosis({
      framework: {
        framework: 'vitest',
      },
      result: {
        command: 'vitest bench --run src/parser.bench.ts',
        stdout: ' BENCH  Summary\n',
        stderr: 'Benchmarking is an experimental feature.\n',
      },
      evidence: {
        testSessionEvents: 1,
        testModuleEvents: 1,
        testSuiteEvents: 1,
        testEvents: 0,
      },
    })

    assert.strictEqual(eventLevelFailure.kind, 'vitest-benchmark')
    assert.match(eventLevelFailure.summary, /benchmark mode/)
    assert.deepStrictEqual(eventLevelFailure.missingLevels, ['test'])
    assert.strictEqual(shouldRunDebugRerun(eventLevelFailure, { exitCode: 0, timedOut: false }), false)
  })

  it('schedules a debug rerun when a successful command misses test events for an unknown reason', () => {
    const eventLevelFailure = getMissingEventDiagnosis({
      framework: {
        framework: 'vitest',
      },
      result: {
        command: 'vitest run src/parser.test.ts',
        stdout: '',
        stderr: '',
      },
      evidence: {
        testSessionEvents: 1,
        testModuleEvents: 1,
        testSuiteEvents: 1,
        testEvents: 0,
      },
    })

    assert.strictEqual(eventLevelFailure.kind, 'missing-test-events')
    assert.match(eventLevelFailure.recommendation, /debug rerun/)
    assert.strictEqual(shouldRunDebugRerun(eventLevelFailure, { exitCode: 0, timedOut: false }), true)
  })

  it('explains missing Jest test events from a custom runner in config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-jest-runner-'))
    const configFile = path.join(root, 'jest.config.js')

    try {
      fs.writeFileSync(configFile, 'module.exports = { runner: "jest-light-runner" }\n')

      const eventLevelFailure = getMissingEventDiagnosis({
        framework: {
          framework: 'jest',
          project: {
            configFiles: [configFile],
          },
        },
        result: {
          command: 'node ./node_modules/.bin/jest --ci',
          stdout: 'PASS packages/example.test.js\n',
          stderr: '',
        },
        evidence: {
          testSessionEvents: 1,
          testModuleEvents: 1,
          testSuiteEvents: 0,
          testEvents: 0,
        },
      })

      assert.strictEqual(eventLevelFailure.kind, 'custom-jest-runner')
      assert.strictEqual(eventLevelFailure.customTestRunner.name, 'jest-light-runner')
      assert.strictEqual(eventLevelFailure.customTestRunner.source, configFile)
      assert.match(eventLevelFailure.summary, /custom Jest-compatible runner: `jest-light-runner`/)
      assert.match(eventLevelFailure.recommendation, /standard Jest runner/)
      assert.deepStrictEqual(eventLevelFailure.missingLevels, ['test_suite_end', 'test'])
      assert.strictEqual(shouldRunDebugRerun(eventLevelFailure, { exitCode: 0, timedOut: false }), false)
    } finally {
      fs.rmSync(root, { force: true, recursive: true })
    }
  })

  it('explains missing Jest test events from package.json custom runner config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-jest-package-runner-'))
    const packageJson = path.join(root, 'package.json')

    try {
      fs.writeFileSync(packageJson, `${JSON.stringify({ jest: { runner: 'jest-runner-eslint' } }, null, 2)}\n`)

      const eventLevelFailure = getMissingEventDiagnosis({
        framework: {
          framework: 'jest',
          project: {
            packageJson,
          },
        },
        result: {
          command: 'npm test',
          stdout: 'PASS lint.test.js\n',
          stderr: '',
        },
        evidence: {
          testSessionEvents: 1,
          testModuleEvents: 1,
          testSuiteEvents: 1,
          testEvents: 0,
        },
      })

      assert.strictEqual(eventLevelFailure.kind, 'custom-jest-runner')
      assert.strictEqual(eventLevelFailure.customTestRunner.name, 'jest-runner-eslint')
      assert.strictEqual(eventLevelFailure.customTestRunner.source, packageJson)
      assert.deepStrictEqual(eventLevelFailure.missingLevels, ['test'])
    } finally {
      fs.rmSync(root, { force: true, recursive: true })
    }
  })

  it('explains framework source-tree runner commands', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-mocha-source-'))

    try {
      fs.mkdirSync(path.join(root, 'lib'))
      fs.writeFileSync(path.join(root, 'lib/mocha.cjs'), '')
      fs.writeFileSync(path.join(root, 'lib/runner.cjs'), '')

      const eventLevelFailure = getMissingEventDiagnosis({
        framework: {
          framework: 'mocha',
          project: {
            name: 'mocha',
            root,
          },
        },
        result: {
          command: 'npm run test-smoke',
          stdout: '> node ./bin/mocha.js --no-config test/smoke/smoke.spec.cjs\n  1 passing (1ms)',
          stderr: '',
        },
        evidence: {
          testSessionEvents: 0,
          testModuleEvents: 0,
          testSuiteEvents: 0,
          testEvents: 0,
        },
      })

      assert.strictEqual(eventLevelFailure.kind, 'framework-source-tree-runner')
      assert.match(eventLevelFailure.summary, /framework source tree/)
      assert.match(eventLevelFailure.recommendation, /installed supported framework package/)
    } finally {
      fs.rmSync(root, { force: true, recursive: true })
    }
  })

  it('extracts concise test output summaries', () => {
    assert.deepStrictEqual(summarizeTestOutput(`
      sample suite
        ✔ sample test

      1 passing (2ms)
    `), ['      1 passing (2ms)'])
  })

  it('omits encoded payloads and truncates long debug tail lines', () => {
    const lines = tailInterestingLines([
      `Encoding payload: ${'secret-payload'.repeat(100)}`,
      `Error: ${'x'.repeat(600)}`,
      'Tests 4 passed (4)',
    ].join('\n'))

    assert.strictEqual(lines.length, 2)
    assert.strictEqual(lines[0].length, 503)
    assert.match(lines[0], /\.\.\.$/)
    assert.strictEqual(lines[1], 'Tests 4 passed (4)')
  })

  it('explains when tests ran but debug output shows package-manager initialization only', () => {
    const diagnosis = getDebugAwareDiagnosis('No Test Optimization test events reached the event artifact.', {
      commandOutputSummary: ['1 passing (2ms)'],
      eventLevelFailure: {
        kind: 'no-test-optimization-events',
      },
      preflight: {
        observedTestCount: 1,
      },
      debugRerun: {
        ran: true,
        testSessionEvents: 0,
        testModuleEvents: 0,
        testSuiteEvents: 0,
        testEvents: 0,
        debugLines: [
          'dd-trace is not initialized in a package manager.',
        ],
        stdoutExcerpt: [
          '1 passing (1ms)',
        ],
      },
    })

    assert.strictEqual(diagnosis.kind, 'tests-ran-tracer-not-initialized')
    assert.match(diagnosis.summary, /selected command ran tests/)
    assert.match(diagnosis.summary, /dd-trace is not initialized in a package manager/)
    assert.deepStrictEqual(diagnosis.signals.testOutputSummary, ['1 passing (2ms)', '1 passing (1ms)'])
  })

  it('reports a dd-trace preload dependency failure before missing-event diagnosis', () => {
    const diagnosis = getMissingEventDiagnosis({
      framework: { framework: 'vitest' },
      result: {
        command: 'pnpm test',
        stdout: '',
        stderr: "Error: Cannot find module 'dc-polyfill'\nRequire stack:\n- node_modules/dd-trace/ci/init.js\n" +
          '- node:internal/preload',
      },
      evidence: {
        commandFailure: {
          buildErrors: ["Error: Cannot find module 'dc-polyfill'"],
          summary: 'The selected test command failed during project setup/build.',
        },
        testSessionEvents: 0,
        testModuleEvents: 0,
        testSuiteEvents: 0,
        testEvents: 0,
      },
    })

    assert.strictEqual(diagnosis.kind, 'dd-trace-preload-failed')
    assert.match(diagnosis.summary, /preload failed before tests started/)
    assert.match(diagnosis.summary, /No Test Optimization conclusion was reached/)
    assert.doesNotMatch(diagnosis.summary, /selected command ran tests/i)

    const failure = refineBasicReportingFailure({
      status: 'fail',
      diagnosis: diagnosis.summary,
      evidence: { eventLevelFailure: diagnosis },
    })
    assert.strictEqual(failure.status, 'error')
  })
})

function getExitMismatchFramework (root) {
  return {
    id: 'mocha:root',
    framework: 'mocha',
    existingTestCommand: {
      cwd: root,
      argv: [process.execPath, '-e', 'process.exit(0)'],
    },
    preflight: {
      ran: true,
      exitCode: 0,
      maxTestCount: 1,
      observedTestCount: 1,
    },
  }
}

function getBasicReportingWithExitMismatch ({ cleanExitCode, onCleanRun = () => {} }) {
  return proxyquire('../../../../ci/test-optimization-validation/scenarios/basic-reporting', {
    '../command-runner': {
      runCommand: async () => {
        onCleanRun()
        return {
          artifacts: {},
          exitCode: cleanExitCode,
          stderr: '',
          stdout: '1 passing',
          timedOut: false,
        }
      },
    },
    './helpers': {
      basicEventEvidence: () => ({
        testSessionEvents: 1,
        testModuleEvents: 1,
        testSuiteEvents: 1,
        testEvents: 1,
      }),
      failWithDebugRerun: async options => ({
        artifacts: [],
        diagnosis: options.diagnosis,
        evidence: options.evidence,
        frameworkId: options.framework.id,
        scenario: options.scenarioName,
        status: 'fail',
      }),
      hasAllBasicEventTypes: () => true,
      runInstrumentedCommand: async ({ out }) => ({
        events: [],
        offline: {
          initialized: true,
          inputs: { settings: { status: 'loaded' } },
          summary: { errors: [] },
        },
        outDir: path.join(out, 'basic-reporting'),
        result: {
          exitCode: 1,
          stderr: '',
          stdout: '1 failing',
          timedOut: false,
        },
      }),
    },
  })
}
