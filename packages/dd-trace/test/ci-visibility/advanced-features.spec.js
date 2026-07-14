'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const proxyquire = require('proxyquire').noCallThru().noPreserveCache()
const sinon = require('sinon')

const {
  eventsOfType,
  findTestsByIdentity,
} = require('../../../../ci/test-optimization-validation/payload-normalizer')
const {
  requireGeneratedScenario,
} = require('../../../../ci/test-optimization-validation/scenarios/helpers')

describe('test optimization validation advanced features', () => {
  it('reports a missing verified generated strategy as incomplete', () => {
    const result = requireGeneratedScenario({ id: 'vitest:root' }, 'basic-pass', 'efd')

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.manifestIncomplete, true)
    assert.match(result.diagnosis, /manifest is incomplete/)
  })

  it('cleans generated runtime state before recreating generated files', async () => {
    const calls = []
    const helpers = proxyquire('../../../../ci/test-optimization-validation/scenarios/helpers', {
      '../generated-files': {
        cleanupGeneratedRuntimeFiles () {
          calls.push('cleanup')
        },
        findGeneratedScenario () {
          return { id: 'atr-fail-once' }
        },
        writeGeneratedFiles () {
          calls.push('write')
          return ['/repo/dd-test-optimization-validation.test.js']
        },
      },
    })

    await helpers.prepareGeneratedScenario({ generatedTestStrategy: {} }, 'atr-fail-once')

    assert.deepStrictEqual(calls, ['cleanup', 'write'])
  })

  it('discovers a generated test by name and file when the manifest suite is wrong', async () => {
    const clock = sinon.useFakeTimers()
    const outDir = path.join('/tmp', 'dd-validation-discovery')
    const test = {
      type: 'test',
      testName: 'dd-test-optimization-validation basic-pass',
      testSuite: 'packages/debug/test/dd-test-optimization-validation.test.js',
      testSourceFile: 'packages/debug/test/dd-test-optimization-validation.test.js',
    }
    const helpers = proxyquire('../../../../ci/test-optimization-validation/scenarios/helpers', {
      '../command-runner': {
        buildDatadogEnv () {
          return {}
        },
        async runCommand () {
          return { exitCode: 0 }
        },
      },
      '../generated-files': {
        cleanupGeneratedRuntimeFiles () {},
      },
      '../offline-fixtures': {
        cleanupOfflineFixture () {},
        createOfflineFixture () {
          return {
            manifestPath: path.join(outDir, '.testoptimization', 'manifest.txt'),
            root: path.join(outDir, 'offline-fixture'),
          }
        },
      },
      '../offline-output': {
        parseOfflineSummary () {},
        readOfflineOutput () {
          return {
            events: [test],
            inputs: {},
            recordCount: 0,
          }
        },
      },
      '../payload-normalizer': {
        eventsOfType,
        findTestsByIdentity,
      },
      '../redaction': {
        sanitizeForReport (value) {
          return value
        },
      },
      '../safe-files': {
        createFileSafely () {},
        writeFileSafely () {},
      },
    })

    try {
      const discoveryPromise = helpers.discoverScenarioTests({
        framework: {
          id: 'vitest:packages-debug',
          framework: 'vitest',
        },
        intake: {
          configure () {},
          requests: [],
          resetRequests () {},
        },
        options: { verbose: false },
        out: outDir,
        scenarioName: 'efd',
        scenario: {
          runCommand: {
            cwd: outDir,
            argv: ['node', 'test.js'],
          },
          testIdentities: [{
            suite: 'dd-test-optimization-validation',
            name: 'basic-pass',
            file: '/repo/packages/debug/test/dd-test-optimization-validation.test.js',
          }],
        },
      })
      await clock.tickAsync(1000)
      const discovery = await discoveryPromise

      assert.deepStrictEqual(discovery.tests, [test])
      assert.strictEqual(discovery.identityMatch, 'name-and-file-fallback')
      assert.deepStrictEqual(discovery.testIdentities, [{
        discovered: true,
        suite: test.testSuite,
        name: test.testName,
        file: test.testSourceFile,
        parameters: undefined,
      }])
    } finally {
      clock.restore()
    }
  })

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
        { testName: 'generated test', testStatus: 'pass', isRetry: true, retryReason: 'early_flake_detection' },
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

  it('requires Datadog Early Flake Detection retry evidence for EFD pass', async () => {
    const outDir = path.join('/tmp', 'dd-validation-efd')
    const helpers = buildScenarioHelpers({
      commandExitCode: 0,
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
        { testName: 'generated test', testStatus: 'pass', isRetry: true, retryReason: 'external' },
      ],
    })
    const { runEarlyFlakeDetection } = proxyquire(
      '../../../../ci/test-optimization-validation/scenarios/early-flake-detection',
      { './helpers': helpers }
    )

    const result = await runEarlyFlakeDetection(getRunOptions(outDir))

    assert.strictEqual(result.status, 'fail')
    assert.match(result.diagnosis, /did not appear to be retried for Early Flake Detection/)
    assert.strictEqual(result.evidence.earlyFlakeRetryEvents, 0)
    assert.strictEqual(result.evidence.externalRetryEvents, 1)
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

  it('requires Datadog Auto Test Retry evidence for ATR pass', async () => {
    const outDir = path.join('/tmp', 'dd-validation-atr')
    const helpers = buildScenarioHelpers({
      commandExitCode: 0,
      outDir,
      scenario: {
        id: 'atr-fail-once',
        runCommand: {
          cwd: outDir,
          argv: ['node', 'test.js'],
        },
      },
      tests: [
        { testName: 'generated test', testStatus: 'fail' },
        { testName: 'generated test', testStatus: 'pass', isRetry: true, retryReason: 'external' },
      ],
    })
    const { runAutoTestRetries } = proxyquire(
      '../../../../ci/test-optimization-validation/scenarios/auto-test-retries',
      { './helpers': helpers }
    )

    const result = await runAutoTestRetries(getRunOptions(outDir))

    assert.strictEqual(result.status, 'fail')
    assert.match(result.diagnosis, /no test\.retry_reason=auto_test_retry tag/)
    assert.strictEqual(result.evidence.autoTestRetryEvents, 0)
    assert.strictEqual(result.evidence.externalRetryEvents, 1)
  })
})

function buildScenarioHelpers ({ commandExitCode = 1, outDir, scenario, tests }) {
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
        offline: {
          inputs: {
            known_tests: { status: 'loaded' },
            settings: { status: 'loaded' },
            test_management: { status: 'loaded' },
          },
        },
        outDir,
        result: {
          exitCode: commandExitCode,
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
