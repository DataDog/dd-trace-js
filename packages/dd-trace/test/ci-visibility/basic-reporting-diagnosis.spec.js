'use strict'

const assert = require('node:assert/strict')

const {
  getMissingEventDiagnosis,
  shouldRunDebugRerun,
} = require('../../../../ci/test-optimization-validation/scenarios/basic-reporting')

describe('test optimization basic reporting diagnosis', () => {
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
})
