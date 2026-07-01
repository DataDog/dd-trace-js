'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  getDebugAwareDiagnosis,
  getBasicReportingCommand,
  getMissingEventDiagnosis,
  shouldRunDebugRerun,
  summarizeTestOutput,
} = require('../../../../ci/test-optimization-validation/scenarios/basic-reporting')

describe('test optimization basic reporting diagnosis', () => {
  it('uses forcedLocalCommand for forced local Basic Reporting when present', () => {
    const existingTestCommand = { argv: ['npm', 'test'] }
    const forcedLocalCommand = { argv: ['npx', 'jest', '--runTestsByPath', 'test/example.test.js'] }

    assert.strictEqual(getBasicReportingCommand({
      existingTestCommand,
      forcedLocalCommand,
    }), forcedLocalCommand)
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

  it('explains when tests ran but debug output shows package-manager initialization only', () => {
    const diagnosis = getDebugAwareDiagnosis('No Test Optimization test events reached the fake intake.', {
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
})
