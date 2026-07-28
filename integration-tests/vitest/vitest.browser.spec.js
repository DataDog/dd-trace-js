'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const { inspect } = require('node:util')

const {
  getCiVisAgentlessConfig,
  installPlaywrightChromium,
  sandboxCwd,
  useSandbox,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { getLatestPlaywrightSpecifier } = require('../playwright/versions')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')
const {
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  TEST_BROWSER_DRIVER,
  TEST_BROWSER_NAME,
  TEST_FINAL_STATUS,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_IS_RUM_ACTIVE,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_NAME,
  TEST_PARAMETERS,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_SOURCE_FILE,
  TEST_STATUS,
  TEST_TYPE,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { NODE_MAJOR } = require('../../version')

const latestVersions = require('../../packages/dd-trace/test/plugins/versions/package.json').dependencies
const isLegacyBrowserProvider = process.env.VITEST_BROWSER_LEGACY === '1' || NODE_MAJOR <= 18
const vitestVersion = isLegacyBrowserProvider ? '3.2.6' : latestVersions.vitest
const playwrightVersion = getLatestPlaywrightSpecifier()
const browserProviderDependency = isLegacyBrowserProvider
  ? `@vitest/browser@${vitestVersion}`
  : `@vitest/browser-playwright@${vitestVersion}`
const sandboxDependencies = [
  `vitest@${vitestVersion}`,
  browserProviderDependency,
  `playwright@${playwrightVersion}`,
]
if (isLegacyBrowserProvider) {
  sandboxDependencies.push('vite@6.1.0')
}
const NODE_OPTIONS = '--import dd-trace/register.js -r dd-trace/ci/init'

function getEvents (payloads) {
  return payloads.flatMap(({ payload }) => payload.events)
}

function getEventContents (events, type) {
  return events.filter(event => event.type === type).map(event => event.content)
}

function getTestByName (tests, name) {
  const test = tests.find(test => test.meta[TEST_NAME] === name)
  assert.ok(test, `Could not find test ${name}. Found: ${inspect(tests.map(test => test.meta[TEST_NAME]))}`)
  return test
}

describe(`vitest@${vitestVersion} Browser Mode`, function () {
  this.timeout(180_000)

  let childProcess
  let cwd
  let receiver
  let testOutput

  useSandbox(sandboxDependencies, true)

  before(function () {
    this.timeout(120_000)
    cwd = sandboxCwd()
    installPlaywrightChromium(cwd)
  })

  beforeEach(async () => {
    childProcess = undefined
    receiver = await new FakeCiVisIntake().start()
    testOutput = ''
  })

  afterEach(async () => {
    childProcess?.kill()
    await receiver.stop()
  })

  async function runVitest (testFile, extraEnv = {}, expectedExitCode = 0) {
    childProcess = exec('./node_modules/.bin/vitest run', {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        DD_SERVICE: undefined,
        NODE_OPTIONS,
        TEST_DIR: testFile ? `ci-visibility/vitest-browser-tests/${testFile}` : undefined,
        VITEST_BROWSER_MODE: '1',
        VITEST_BROWSER_PROVIDER_FACTORY: isLegacyBrowserProvider ? undefined : '1',
        ...extraEnv,
      },
    })
    childProcess.stdout.on('data', data => { testOutput += data })
    childProcess.stderr.on('data', data => { testOutput += data })

    const [exitCode] = await once(childProcess, 'exit')
    assert.strictEqual(exitCode, expectedExitCode, testOutput)
    return exitCode
  }

  function gatherEvents (assertions) {
    return receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcycle',
      payloads => assertions(getEvents(payloads), payloads),
      60_000
    )
  }

  it('reports each browser test once with browser identity', async () => {
    receiver.setSettings({
      di_enabled: true,
    })

    const payloadsPromise = gatherEvents((events, payloads) => {
      const metadata = payloads.flatMap(({ payload }) => payload.metadata)
      for (const metadataEntry of metadata) {
        assert.ok(!(DD_CAPABILITIES_FAILED_TEST_REPLAY in metadataEntry.test))
      }

      assert.strictEqual(getEventContents(events, 'test_session_end').length, 1)
      assert.strictEqual(getEventContents(events, 'test_module_end').length, 1)
      assert.strictEqual(getEventContents(events, 'test_suite_end').length, 1)

      const tests = getEventContents(events, 'test')
      assert.strictEqual(tests.length, 2)
      const testSuite = getEventContents(events, 'test_suite_end')[0]
      assert.strictEqual(testSuite.meta[TEST_TYPE], 'browser')

      const passedTest = getTestByName(tests, 'vitest browser reporting runs the test body in the browser')
      assert.strictEqual(passedTest.meta[TEST_STATUS], 'pass')
      assert.strictEqual(passedTest.meta[TEST_TYPE], 'browser')
      assert.strictEqual(passedTest.meta[TEST_BROWSER_NAME], 'chromium')
      assert.strictEqual(passedTest.meta[TEST_BROWSER_DRIVER], 'playwright')
      assert.ok(!(TEST_IS_RUM_ACTIVE in passedTest.meta))
      assert.deepStrictEqual(JSON.parse(passedTest.meta[TEST_PARAMETERS]), {
        arguments: {
          browser: 'chromium',
          project: 'browser-chromium',
        },
        metadata: {},
      })

      const skippedTest = getTestByName(tests, 'vitest browser reporting reports skipped browser tests')
      assert.strictEqual(skippedTest.meta[TEST_STATUS], 'skip')
      assert.strictEqual(skippedTest.meta[TEST_TYPE], 'browser')
      assert.strictEqual(skippedTest.meta[TEST_BROWSER_NAME], 'chromium')
    })

    const [exitCode] = await Promise.all([
      runVitest('browser-reporting.mjs'),
      payloadsPromise,
    ])

    assert.strictEqual(exitCode, 0, testOutput)
  })

  it('reports multiple errors from one browser test execution as one attempt', async () => {
    const payloadsPromise = gatherEvents(events => {
      const tests = getEventContents(events, 'test')
      assert.strictEqual(tests.length, 1)
      assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
      assert.ok(!(TEST_IS_RETRY in tests[0].meta))
      assert.match(tests[0].meta[ERROR_MESSAGE], /test attempt 1 failed/)
      assert.doesNotMatch(tests[0].meta[ERROR_MESSAGE], /cleanup for attempt 1 failed/)
    })

    const [exitCode] = await Promise.all([
      runVitest('browser-multiple-errors.mjs', {}, 1),
      payloadsPromise,
    ])

    assert.strictEqual(exitCode, 1, testOutput)
  })

  it('reports errors from the correct automatic retry attempt', async () => {
    receiver.setSettings({
      flaky_test_retries_enabled: true,
      early_flake_detection: {
        enabled: false,
      },
    })

    const payloadsPromise = gatherEvents(events => {
      const tests = getEventContents(events, 'test')
      assert.strictEqual(tests.length, 2)
      assert.match(tests[0].meta[ERROR_MESSAGE], /test attempt 1 failed/)
      assert.match(tests[1].meta[ERROR_MESSAGE], /test attempt 2 failed/)
    })

    const [exitCode] = await Promise.all([
      runVitest('browser-multiple-errors.mjs', {
        DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
      }, 1),
      payloadsPromise,
    ])

    assert.strictEqual(exitCode, 1, testOutput)
  })

  it('correlates sequential browser tests with RUM', async () => {
    receiver.setSettings({
      flaky_test_retries_enabled: true,
      early_flake_detection: {
        enabled: false,
      },
    })

    const payloadsPromise = gatherEvents(events => {
      const tests = getEventContents(events, 'test')
      assert.strictEqual(tests.length, 4)

      const firstTest = getTestByName(tests, 'vitest browser RUM correlation correlates the first browser test')
      const secondTest = getTestByName(
        tests,
        'vitest browser RUM correlation uses a new correlation ID without restarting RUM'
      )
      const retriedTests = tests.filter(
        test => test.meta[TEST_NAME] === 'vitest browser RUM correlation uses a new RUM correlation ID on retry'
      )
      const firstTestExecutionId = getRumTestExecutionId(testOutput, 'first')
      const secondTestExecutionId = getRumTestExecutionId(testOutput, 'second')
      const firstRetryExecutionId = getRumTestExecutionId(testOutput, 'retry-1')
      const secondRetryExecutionId = getRumTestExecutionId(testOutput, 'retry-2')

      assert.strictEqual(firstTest.meta[TEST_IS_RUM_ACTIVE], 'true')
      assert.strictEqual(firstTest.trace_id.toString(), firstTestExecutionId)
      assert.strictEqual(secondTest.meta[TEST_IS_RUM_ACTIVE], 'true')
      assert.strictEqual(secondTest.trace_id.toString(), secondTestExecutionId)
      assert.strictEqual(retriedTests.length, 2)
      assert.strictEqual(retriedTests[0].meta[TEST_STATUS], 'fail')
      assert.strictEqual(retriedTests[0].meta[TEST_IS_RUM_ACTIVE], 'true')
      assert.strictEqual(retriedTests[0].trace_id.toString(), firstRetryExecutionId)
      assert.strictEqual(retriedTests[1].meta[TEST_STATUS], 'pass')
      assert.strictEqual(retriedTests[1].meta[TEST_IS_RUM_ACTIVE], 'true')
      assert.strictEqual(retriedTests[1].trace_id.toString(), secondRetryExecutionId)
      assert.notStrictEqual(firstTestExecutionId, secondTestExecutionId)
      assert.notStrictEqual(firstRetryExecutionId, secondRetryExecutionId)
    })

    const [exitCode] = await Promise.all([
      runVitest('browser-rum.mjs'),
      payloadsPromise,
    ])

    assert.strictEqual(exitCode, 0, testOutput)
  })

  it('does not fail browser tests when correlation ID generation fails', async () => {
    const payloadsPromise = gatherEvents(events => {
      const tests = getEventContents(events, 'test')
      assert.strictEqual(tests.length, 2)
      for (const test of tests) {
        assert.strictEqual(test.meta[TEST_STATUS], 'pass')
        assert.ok(!(TEST_IS_RUM_ACTIVE in test.meta))
      }
    })

    const [exitCode] = await Promise.all([
      runVitest('browser-rum-crypto-failure.mjs', {
        VITEST_SETUP_FILE: 'ci-visibility/vitest-tests/rum-crypto-failure-setup.mjs',
      }),
      payloadsPromise,
    ])

    assert.strictEqual(exitCode, 0, testOutput)
  })

  it('does not treat an uninitialized RUM stub as active', async () => {
    const payloadsPromise = gatherEvents(events => {
      const [test] = getEventContents(events, 'test')
      assert.ok(test)
      assert.ok(!(TEST_IS_RUM_ACTIVE in test.meta))
    })

    const [exitCode] = await Promise.all([
      runVitest('browser-rum-uninitialized.mjs'),
      payloadsPromise,
    ])

    assert.strictEqual(exitCode, 0, testOutput)
  })

  it('does not correlate concurrent browser tests with RUM', async () => {
    const payloadsPromise = gatherEvents(events => {
      const tests = getEventContents(events, 'test')
      assert.strictEqual(tests.length, 2)
      for (const test of tests) {
        assert.ok(!(TEST_IS_RUM_ACTIVE in test.meta))
      }
    })

    const [exitCode] = await Promise.all([
      runVitest('browser-rum-concurrent.mjs'),
      payloadsPromise,
    ])

    assert.strictEqual(exitCode, 0, testOutput)
  })

  it('does not correlate parallel browser files with RUM', async () => {
    const payloadsPromise = gatherEvents(events => {
      const tests = getEventContents(events, 'test')
      assert.strictEqual(tests.length, 2)
      for (const test of tests) {
        assert.ok(!(TEST_IS_RUM_ACTIVE in test.meta))
      }
    })

    const [exitCode] = await Promise.all([
      runVitest('browser-rum-parallel-*.mjs'),
      payloadsPromise,
    ])

    assert.strictEqual(exitCode, 0, testOutput)
  })

  it('reports mixed Node and browser projects without duplicate events', async () => {
    const payloadsPromise = gatherEvents(events => {
      assert.strictEqual(getEventContents(events, 'test_session_end').length, 1)
      assert.strictEqual(getEventContents(events, 'test_module_end').length, 1)
      assert.strictEqual(getEventContents(events, 'test_suite_end').length, 2)

      const tests = getEventContents(events, 'test')
      assert.strictEqual(tests.length, 3)

      const nodeTest = getTestByName(tests, 'keeps Node worker instrumentation active')
      assert.strictEqual(nodeTest.meta[TEST_STATUS], 'pass')
      assert.strictEqual(nodeTest.meta[TEST_TYPE], 'test')
      assert.ok(!(TEST_BROWSER_NAME in nodeTest.meta))

      const browserTest = getTestByName(tests, 'vitest browser reporting runs the test body in the browser')
      assert.strictEqual(browserTest.meta[TEST_STATUS], 'pass')
      assert.strictEqual(browserTest.meta[TEST_TYPE], 'browser')
      assert.strictEqual(browserTest.meta[TEST_BROWSER_NAME], 'chromium')
    })

    const [exitCode] = await Promise.all([
      runVitest(undefined, {
        VITEST_BROWSER_MODE: undefined,
        VITEST_MIXED_BROWSER_MODE: '1',
      }),
      payloadsPromise,
    ])

    assert.strictEqual(exitCode, 0, testOutput)
  })

  it('applies Auto Test Retries to browser tests', async () => {
    receiver.setSettings({
      flaky_test_retries_enabled: true,
      early_flake_detection: {
        enabled: false,
      },
    })

    const payloadsPromise = gatherEvents(events => {
      const tests = getEventContents(events, 'test')
      assert.strictEqual(tests.length, 2)
      assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
      assert.ok(!(TEST_IS_RETRY in tests[0].meta))
      assert.ok(Number(tests[0].duration) >= 30 * 1e6)
      assert.strictEqual(tests[1].meta[TEST_STATUS], 'pass')
      assert.strictEqual(tests[1].meta[TEST_IS_RETRY], 'true')
      assert.strictEqual(tests[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
      assert.ok(Number(tests[1].duration) >= 30 * 1e6)
    })

    const [exitCode] = await Promise.all([
      runVitest('browser-atr.mjs'),
      payloadsPromise,
    ])

    assert.strictEqual(exitCode, 0, testOutput)
  })

  if (!isLegacyBrowserProvider) {
    it('honors object-form retries before quarantining browser failures', async () => {
      const testSuite = 'ci-visibility/vitest-browser-tests/browser-object-retry-quarantine.mjs'
      receiver.setSettings({
        test_management: {
          enabled: true,
        },
      })
      receiver.setTestManagementTests({
        vitest: {
          suites: {
            [testSuite]: {
              tests: {
                'honors object-form retries before quarantining': {
                  properties: {
                    quarantined: true,
                  },
                },
              },
            },
          },
        },
      })

      const payloadsPromise = gatherEvents(events => {
        const tests = getEventContents(events, 'test')
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
        assert.ok(!(TEST_IS_RETRY in tests[0].meta))
        assert.strictEqual(tests[0].meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
        assert.strictEqual(tests[1].meta[TEST_STATUS], 'pass')
        assert.strictEqual(tests[1].meta[TEST_IS_RETRY], 'true')
        assert.strictEqual(tests[1].meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
      })

      const [exitCode] = await Promise.all([
        runVitest('browser-object-retry-quarantine.mjs'),
        payloadsPromise,
      ])

      assert.strictEqual(exitCode, 0, testOutput)
    })
  }

  it('applies Early Flake Detection repetitions to new browser tests', async () => {
    receiver.setSettings({
      early_flake_detection: {
        enabled: true,
        slow_test_retries: {
          '5s': 2,
        },
      },
      known_tests_enabled: true,
    })
    receiver.setKnownTests({ vitest: {} })

    const payloadsPromise = gatherEvents(events => {
      const tests = getEventContents(events, 'test')
      assert.strictEqual(tests.length, 3)
      for (let index = 0; index < tests.length; index++) {
        const test = tests[index]
        assert.strictEqual(test.meta[TEST_STATUS], 'pass')
        assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
        if (index === 0) {
          assert.ok(!(TEST_IS_RETRY in test.meta))
        } else {
          assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
        }
      }
    })

    const [exitCode] = await Promise.all([
      runVitest('browser-efd.mjs'),
      payloadsPromise,
    ])

    assert.strictEqual(exitCode, 0, testOutput)
  })

  it('uses an unmocked clock for browser attempt durations and EFD retries', async () => {
    receiver.setSettings({
      early_flake_detection: {
        enabled: true,
        slow_test_retries: {
          '5s': 2,
          '10s': 1,
        },
      },
      known_tests_enabled: true,
    })
    receiver.setKnownTests({ vitest: {} })

    const payloadsPromise = gatherEvents(events => {
      const tests = getEventContents(events, 'test')
      assert.strictEqual(tests.length, 3)
      for (let index = 0; index < tests.length; index++) {
        const test = tests[index]
        assert.ok(
          Number(test.duration) < 1000 * 1e6,
          `Expected duration to use an unmocked clock, got ${Number(test.duration) / 1e6}ms`
        )
        if (index === 0) {
          assert.ok(!(TEST_IS_RETRY in test.meta))
        } else {
          assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
        }
      }
    })

    const [exitCode] = await Promise.all([
      runVitest('browser-efd-fake-timers.mjs', {
        VITEST_SETUP_FILE: 'ci-visibility/vitest-tests/fake-timers-setup.mjs',
      }),
      payloadsPromise,
    ])

    assert.strictEqual(exitCode, 0, testOutput)
  })

  it('applies Test Management execution changes to browser tests', async () => {
    const testSuite = 'ci-visibility/vitest-browser-tests/browser-test-management.mjs'
    receiver.setSettings({
      test_management: {
        enabled: true,
        attempt_to_fix_retries: 2,
      },
    })
    receiver.setTestManagementTests({
      vitest: {
        suites: {
          [testSuite]: {
            tests: {
              'does not execute a disabled browser test': {
                properties: {
                  disabled: true,
                },
              },
              'quarantines a failing browser test': {
                properties: {
                  quarantined: true,
                },
              },
              'attempts to fix a browser test': {
                properties: {
                  attempt_to_fix: true,
                },
              },
            },
          },
        },
      },
    })

    const payloadsPromise = gatherEvents(events => {
      const tests = getEventContents(events, 'test')
      assert.strictEqual(tests.length, 5)

      const disabledTest = getTestByName(tests, 'does not execute a disabled browser test')
      assert.strictEqual(disabledTest.meta[TEST_STATUS], 'skip')
      assert.strictEqual(disabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')

      const quarantinedTest = getTestByName(tests, 'quarantines a failing browser test')
      assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
      assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')
      assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

      const attemptedToFixTests = tests.filter(test => test.meta[TEST_NAME] === 'attempts to fix a browser test')
      assert.strictEqual(attemptedToFixTests.length, 3)
      attemptedToFixTests.forEach((test, index) => {
        assert.strictEqual(test.meta[TEST_STATUS], 'pass')
        assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
        if (index > 0) {
          assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
        }
      })
      assert.strictEqual(
        attemptedToFixTests.at(-1).meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED],
        'true'
      )

      const [suite] = getEventContents(events, 'test_suite_end')
      assert.strictEqual(suite.meta[TEST_SOURCE_FILE], testSuite)
      assert.strictEqual(suite.meta[TEST_STATUS], 'pass')
    })

    const [exitCode] = await Promise.all([
      runVitest('browser-test-management.mjs'),
      payloadsPromise,
    ])

    assert.strictEqual(exitCode, 0, testOutput)
  })
})

function getRumTestExecutionId (testOutput, testName) {
  const match = testOutput.match(new RegExp(`DD_VITEST_RUM_EXECUTION_ID:${testName}:(\\d+)`))
  assert.ok(match, testOutput)
  return match[1]
}
