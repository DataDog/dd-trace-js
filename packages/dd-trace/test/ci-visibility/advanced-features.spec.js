'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const proxyquire = require('proxyquire').noCallThru().noPreserveCache()

describe('test optimization validation advanced features', () => {
  it('fails EFD when retry evidence is emitted by a nonzero command', async () => {
    const outDir = path.join('/tmp', 'dd-validation-efd')
    const helpers = buildScenarioHelpers({
      outDir,
      scenario: {
        id: 'basic-pass',
        runCommand: {
          cwd: outDir,
          argv: ['node', 'test.js'],
        },
      },
      tests: [
        { testName: 'generated test', testStatus: 'pass' },
        { testName: 'generated test', testStatus: 'pass', isRetry: true },
      ],
    })
    const { runEarlyFlakeDetection } = proxyquire(
      '../../../../ci/test-optimization-validation/scenarios/early-flake-detection',
      { './helpers': helpers }
    )

    const result = await runEarlyFlakeDetection(getRunOptions(outDir))

    assert.strictEqual(result.status, 'fail')
    assert.match(result.diagnosis, /reported Early Flake Detection retry evidence/)
    assert.match(result.diagnosis, /command exited 1/)
    assert.strictEqual(result.evidence.commandExitCode, 1)
  })

  it('fails Test Management when quarantined evidence is emitted by a nonzero command', async () => {
    const outDir = path.join('/tmp', 'dd-validation-test-management')
    const helpers = buildScenarioHelpers({
      outDir,
      scenario: {
        id: 'test-management-target',
        runCommand: {
          cwd: outDir,
          argv: ['node', 'test.js'],
        },
      },
      tests: [
        { testName: 'generated test', testStatus: 'pass', isQuarantined: true },
      ],
    })
    const { runTestManagement } = proxyquire(
      '../../../../ci/test-optimization-validation/scenarios/test-management',
      { './helpers': helpers }
    )

    const result = await runTestManagement(getRunOptions(outDir))

    assert.strictEqual(result.status, 'fail')
    assert.match(result.diagnosis, /reported quarantined-test evidence/)
    assert.match(result.diagnosis, /command exited 1/)
    assert.strictEqual(result.evidence.commandExitCode, 1)
  })
})

function buildScenarioHelpers ({ outDir, scenario, tests }) {
  return {
    async discoverScenarioTests () {
      return {
        outDir: path.join(outDir, 'baseline'),
        result: {
          exitCode: 0,
        },
        testIdentities: [
          { name: 'generated test' },
        ],
        tests: [
          { testName: 'generated test', testStatus: 'pass' },
        ],
      }
    },

    discoveryEvidence () {
      return {
        baselineCommandExitCode: 0,
        baselineMatchingTestEvents: 1,
      }
    },

    error (framework, scenarioName, err) {
      return {
        frameworkId: framework.id,
        scenario: scenarioName,
        status: 'error',
        diagnosis: err && err.stack ? err.stack : String(err),
        evidence: {},
        artifacts: [],
      }
    },

    async failWithDebugRerun ({ diagnosis, evidence, framework, scenarioName }) {
      return {
        frameworkId: framework.id,
        scenario: scenarioName,
        status: 'fail',
        diagnosis,
        evidence,
        artifacts: [],
      }
    },

    pass () {
      throw new Error('advanced scenario should not pass after a nonzero command exit')
    },

    async prepareGeneratedScenario () {
      return { scenario }
    },

    requestsUrlIncludes () {
      return true
    },

    requireGeneratedScenario () {
      return null
    },

    async runInstrumentedCommand () {
      return {
        outDir,
        result: {
          exitCode: 1,
          timedOut: false,
        },
      }
    },

    skip () {
      throw new Error('advanced scenario should not skip in this test')
    },

    testEventSamples () {
      return []
    },

    testsForDiscoveredScenario () {
      return tests
    },
  }
}

function getRunOptions (outDir) {
  return {
    framework: {
      id: 'vitest:root',
      framework: 'vitest',
    },
    intake: {
      configure () {},
    },
    options: { verbose: false },
    out: outDir,
  }
}
