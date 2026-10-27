'use strict'

const { exec, execSync } = require('child_process')
const fs = require('fs')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('path')
const { inspect } = require('node:util')

const satisfies = require('semifies')

const { assertObjectContains } = require('../helpers')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_SUITE,
  TEST_STATUS,
  TEST_SOURCE_FILE,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_NAME,
  MOCHA_IS_PARALLEL,
  TEST_SESSION_NAME,
  TEST_EARLY_FLAKE_ABORT_REASON,
  DI_ERROR_DEBUG_INFO_CAPTURED,
  DI_DEBUG_ERROR_PREFIX,
  DI_DEBUG_ERROR_FILE_SUFFIX,
  DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX,
  DI_DEBUG_ERROR_LINE_SUFFIX,
  TEST_RETRY_REASON,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  DD_CAPABILITIES_EARLY_FLAKE_DETECTION,
  DD_CAPABILITIES_AUTO_TEST_RETRIES,
  DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE,
  DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE,
  DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX,
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_RETRY_REASON_TYPES,
  TEST_HAS_DYNAMIC_NAME,
  GIT_COMMIT_SHA,
  GIT_REPOSITORY_URL,
  TEST_IS_MODIFIED,
  TEST_FINAL_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const {
  ERROR_MESSAGE,
} = require('../../packages/dd-trace/src/constants')
const { DD_MAJOR } = require('../../version')
const { getLatestMochaSpecifier } = require('./versions')

const runTestsCommand = 'node ./ci-visibility/run-mocha.js'
const finalFlushMarker = 'dd-trace final flush completed\n'

const requestedMochaVersion = process.env.MOCHA_VERSION || 'latest'
const oldestMochaVersion = DD_MAJOR >= 6 ? '8.0.0' : '5.2.0'
const MOCHA_VERSION = requestedMochaVersion === 'oldest' ? oldestMochaVersion : requestedMochaVersion
const mochaDependencyVersion = MOCHA_VERSION === 'latest' ? getLatestMochaSpecifier() : MOCHA_VERSION
const mochaMajor = MOCHA_VERSION === 'latest' ? Infinity : Number.parseInt(MOCHA_VERSION, 10)
const supportsMochaRetryEvents = mochaMajor >= 6
// ATR needs the retry event introduced in Mocha 6.
const retryEventsIt = supportsMochaRetryEvents ? it : it.skip
// Dynamic ATR requires Mocha 8; older versions retain fixed-count ATR.
const supportsDynamicAtr = mochaMajor >= 8
const dynamicAtrIt = supportsDynamicAtr ? it : it.skip
// Global setup/teardown fixtures were introduced in Mocha 8.2.0.
const onlyLatestIt = MOCHA_VERSION === 'latest' ? it : it.skip
// Mocha 8.0 through 8.2 use workerpool 6.0.x, which cannot start process workers on supported Node versions.
const parallelIt = MOCHA_VERSION === 'latest' || satisfies(MOCHA_VERSION, '>=8.3.0') ? it : it.skip
// TODO: Remove this temporary release unblock once the Mocha 5.2 regressions introduced by #9798 are fixed.

/**
 * Captures matching intake payloads until the child confirms its final transport flush.
 *
 * @param {FakeCiVisIntake} intake
 * @param {import('node:child_process').ChildProcess} process
 * @param {(message: object) => boolean} matches
 * @returns {Promise<object[]>}
 */
function capturePayloadsUntilFinalFlush (intake, process, matches) {
  const payloads = []
  let output = ''
  const onMessage = message => {
    if (matches(message)) payloads.push(message)
  }
  intake.on('message', onMessage)

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      intake.off('message', onMessage)
      process.stdout.off('data', onData)
      process.off('close', onClose)
    }
    const onData = chunk => {
      output += chunk.toString()
      if (!output.includes(finalFlushMarker)) return
      cleanup()
      resolve(payloads)
    }
    const onClose = code => {
      cleanup()
      reject(new Error(`Child closed with code ${code} before confirming its final flush`))
    }
    process.stdout.on('data', onData)
    process.once('close', onClose)
  })
}

describe(`mocha@${MOCHA_VERSION}`, function () {
  let receiver
  let childProcess
  let cwd
  let testOutput = ''

  useSandbox(
    [
      `mocha@${mochaDependencyVersion}`,
      'nyc',
      'mocha-each',
      'workerpool',
      'sinon',
    ],
    true
  )

  before(function () {
    cwd = sandboxCwd()
  })

  beforeEach(async function () {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess.kill()
    testOutput = ''
    await receiver.stop()
  })

  for (const dynamic of [false, true]) {
    const nativeRetryIt = dynamic ? dynamicAtrIt : retryEventsIt
    nativeRetryIt(`attributes runtime native retry overrides correctly (dynamic=${dynamic})`, async () => {
      receiver.setSettings({
        itr_enabled: false, tests_skipping: false, code_coverage: false, flaky_test_retries_enabled: true,
      })
      childProcess = exec('./node_modules/.bin/mocha ci-visibility/mocha-native-retries/retry-test.js', {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
          DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: String(dynamic),
          DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '1,5,5,5,5',
        },
      })
      const eventsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess, ({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const tests = payloads.flatMap(({ payload }) => payload.events)
            .filter(event => event.type === 'test').map(event => event.content)
          for (const [name, count] of [
            ['inherited', 2],
            ['native override 1', 2], ['native override 1 once', 2],
            ['native override 2', 3], ['native override 2 once', 3],
          ]) {
            const attempts = tests.filter(test => test.meta[TEST_NAME] === name)
            assert.strictEqual(attempts.length, count, name)
            const reason = name === 'inherited' ? TEST_RETRY_REASON_TYPES.atr : TEST_RETRY_REASON_TYPES.ext
            const retries = attempts.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retries.length, count - 1, name)
            assert.ok(retries.every(test => test.meta[TEST_RETRY_REASON] === reason), name)
            assert.strictEqual(attempts.filter(test => test.meta[TEST_FINAL_STATUS] === 'fail').length, 1, name)
          }
        })
      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
      assert.strictEqual(exitCode, 5)
    })
  }

  context('early flake detection', () => {
    it('retries new tests', (done) => {
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // no other tests are considered new
          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(oldTests.length, 1)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.strictEqual(newTests.length - 1, retriedTests.length)
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          })
          // Test name does not change
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_NAME], 'ci visibility 2 can report tests 2')
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js',
            ]),
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('retries callback-style async tests', async () => {
      receiver.setKnownTests({
        mocha: {},
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const callbackTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test-early-flake-detection/mocha-callback-test.js'
          )

          assert.strictEqual(callbackTests.length, NUM_RETRIES_EFD + 1)
          callbackTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
          })

          const retriedTests = callbackTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            SHOULD_CHECK_RESULTS: '1',
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/mocha-callback-test.js',
            ]),
          },
        }
      )

      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 0, testOutput)
    })

    onlyLatestIt('disables manual Mocha retries for new tests retried by EFD', async () => {
      receiver.setKnownTests({
        mocha: {},
      })
      const NUM_RETRIES_EFD = 2
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        flaky_test_retries_count: 5,
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events
            .filter(event => event.type === 'test')
            .map(event => event.content)
            .filter(test =>
              test.meta[TEST_SUITE] === 'ci-visibility/test-early-flake-detection/fails-first-then-passes.js'
            )
            .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

          assert.strictEqual(tests.length, NUM_RETRIES_EFD + 1)
          assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
          assert.ok(!(TEST_IS_RETRY in tests[0].meta))
          assert.ok(!(TEST_RETRY_REASON in tests[0].meta))

          const retriedTests = tests.slice(1)
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          })

          const externalRetries = tests.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.ext
          )
          assert.strictEqual(externalRetries.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/fails-first-then-passes.js',
            ]),
            MOCHA_RETRIES: '2',
            SET_RETRIES_INSIDE_TEST: '1',
            SHOULD_CHECK_RESULTS: '1',
          },
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 0)
    })

    onlyLatestIt('preserves manual Mocha retries when the EFD retry budget is zero', async () => {
      receiver.setKnownTests({
        mocha: {},
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 0,
            '10s': 0,
            '30s': 0,
            '5m': 0,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const tests = payloads
            .flatMap(({ payload }) => payload.events)
            .filter(event => event.type === 'test')
            .map(event => event.content)
            .filter(test =>
              test.meta[TEST_SUITE] === 'ci-visibility/test-early-flake-detection/fails-first-then-passes.js'
            )
            .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

          assert.strictEqual(tests.length, 2)
          assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
          assert.ok(!(TEST_IS_RETRY in tests[0].meta))
          assert.strictEqual(tests[1].meta[TEST_STATUS], 'pass')
          assert.strictEqual(tests[1].meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(tests[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/fails-first-then-passes.js',
            ]),
            MOCHA_RETRIES: '2',
            SET_RETRIES_INSIDE_TEST: '1',
            SHOULD_CHECK_RESULTS: '1',
          },
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 0)
    })

    it('uses the retry count from the matching slow_test_retries bucket', async () => {
      receiver.setKnownTests({
        mocha: {},
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 2,
            '10s': 0,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const instantTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test-early-flake-detection/instant-test.js'
          )
          assert.strictEqual(instantTests.length, 3)
          assert.strictEqual(
            instantTests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd).length,
            2
          )

          const slowTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test-early-flake-detection/mocha-slightly-slow-test.js'
          )
          assert.strictEqual(slowTests.length, 1)
          assert.strictEqual(slowTests[0].meta[TEST_EARLY_FLAKE_ABORT_REASON], 'slow')
          assert.ok(!(TEST_IS_RETRY in slowTests[0].meta))
        }, 25_000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/instant-test.js',
              './test-early-flake-detection/mocha-slightly-slow-test.js',
            ]),
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    it('sets TEST_HAS_FAILED_ALL_RETRIES when all EFD attempts fail', (done) => {
      // fail-test.js will be considered new and will always fail
      receiver.setKnownTests({
        mocha: {},
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const failTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/fail-test.js'
          )

          // Should have 1 initial attempt + NUM_RETRIES_EFD retries
          assert.strictEqual(failTests.length, NUM_RETRIES_EFD + 1)

          // All attempts should be marked as new
          failTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
          })

          // Check retries
          const retriedTests = failTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          })

          // Only the last retry should have TEST_HAS_FAILED_ALL_RETRIES set
          const lastRetry = failTests[failTests.length - 1]
          assert.strictEqual(lastRetry.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')

          // Earlier attempts should not have the flag
          for (let i = 0; i < failTests.length - 1; i++) {
            assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in failTests[i].meta))
          }

          // With afterEach hooks — all EFD tags should still be set correctly
          const hooksTests = tests
            .filter(test => test.meta[TEST_SUITE] === 'ci-visibility/mocha-hooks/flaky-fails-with-hooks.js')
            .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
          assert.strictEqual(hooksTests.length, NUM_RETRIES_EFD + 1)
          hooksTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
          })
          const hooksRetries = hooksTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(hooksRetries.length, NUM_RETRIES_EFD)
          hooksRetries.forEach(test => {
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          })
          const lastHooksRetry = hooksTests[hooksTests.length - 1]
          assert.strictEqual(lastHooksRetry.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
          for (let i = 0; i < hooksTests.length - 1; i++) {
            assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in hooksTests[i].meta))
          }
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/fail-test.js',
              './mocha-hooks/flaky-fails-with-hooks.js',
            ]),
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('handles parameterized tests as a single unit', (done) => {
      // Tests from ci-visibility/test-early-flake-detection/test-parameterized.js will be considered new
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test-early-flake-detection/test.js': ['ci visibility can report tests'],
        },
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test-early-flake-detection/mocha-parameterized.js'
          )
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          // Each parameter is repeated independently
          const testsForFirstParameter = tests.filter(test => test.resource ===
            'ci-visibility/test-early-flake-detection/mocha-parameterized.js.parameterized test parameter 1'
          )

          const testsForSecondParameter = tests.filter(test => test.resource ===
            'ci-visibility/test-early-flake-detection/mocha-parameterized.js.parameterized test parameter 2'
          )

          assert.strictEqual(testsForFirstParameter.length, testsForSecondParameter.length)

          // all but one have been retried
          assert.strictEqual(
            testsForFirstParameter.length - 1,
            testsForFirstParameter.filter(test => test.meta[TEST_IS_RETRY] === 'true').length
          )

          assert.strictEqual(
            testsForSecondParameter.length - 1,
            testsForSecondParameter.filter(test => test.meta[TEST_IS_RETRY] === 'true').length
          )
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/test.js',
              './test-early-flake-detection/mocha-parameterized.js',
            ]),
          },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', (done) => {
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const newTests = tests.filter(test =>
            test.meta[TEST_IS_NEW] === 'true'
          )
          // new tests are detected but not retried
          assert.strictEqual(newTests.length, 1)
          const retriedTests = tests.filter(test =>
            test.meta[TEST_IS_RETRY] === 'true'
          )
          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js',
            ]),
            DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('retries flaky tests', (done) => {
      // Tests from ci-visibility/test/occasionally-failing-test will be considered new
      receiver.setKnownTests({
        mocha: {},
      })

      const NUM_RETRIES_EFD = 5
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.strictEqual(tests.length - 1, retriedTests.length)
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          // Out of NUM_RETRIES_EFD + 1 total runs, half will be passing and half will be failing,
          // based on the global counter in the test file
          const passingTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(passingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          assert.strictEqual(failingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          // Test name does not change
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_NAME], 'fail occasionally fails')
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/occasionally-failing-test.js',
            ]),
          },
        }
      )

      childProcess.on('exit', (exitCode) => {
        // TODO: check exit code: if a new, retried test fails, the exit code should remain 0
        eventsPromise.then(() => {
          assert.strictEqual(exitCode, 0)
          done()
        }).catch(done)
      })
    })

    it('does not retry new tests that are skipped', (done) => {
      // Tests from ci-visibility/test/skipped-and-todo-test will be considered new
      receiver.setKnownTests({
        mocha: {},
      })

      const NUM_RETRIES_EFD = 5
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const newSkippedTests = tests.filter(
            test => test.meta[TEST_NAME] === 'ci visibility skip will not be retried'
          )
          assert.strictEqual(newSkippedTests.length, 1)
          assert.ok(!(TEST_IS_RETRY in newSkippedTests[0].meta))
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/skipped-and-todo-test.js',
            ]),
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('handles spaces in test names', (done) => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      // Tests from ci-visibility/test/skipped-and-todo-test will be considered new
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test-early-flake-detection/weird-test-names.js': [
            'no describe can do stuff',
            'describe  trailing space ',
          ],
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 2)

          const resourceNames = tests.map(test => test.resource)

          assertObjectContains(resourceNames,
            [
              'ci-visibility/test-early-flake-detection/weird-test-names.js.no describe can do stuff',
              'ci-visibility/test-early-flake-detection/weird-test-names.js.describe  trailing space ',
            ]
          )

          const newTests = tests.filter(
            test => test.meta[TEST_IS_NEW] === 'true'
          )
          // no new tests
          assert.strictEqual(newTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/weird-test-names.js',
            ]),
          },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('does not run EFD if the known tests request fails', (done) => {
      receiver.setKnownTestsResponseCode(500)

      const NUM_RETRIES_EFD = 5
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      // Request module waits before retrying — need longer gather timeout
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSessionEnd = events.find(event => event.type === 'test_session_end')
          assert.ok(testSessionEnd, 'expected test_session_end event in payloads')
          const testSession = testSessionEnd.content
          assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 2)
          const newTests = tests.filter(
            test => test.meta[TEST_IS_NEW] === 'true'
          )
          assert.strictEqual(newTests.length, 0)
        }, 60000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js',
            ]),
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })

    it('retries flaky tests and sets exit code to 0 as long as one attempt passes', (done) => {
      // Tests from ci-visibility/test/occasionally-failing-test will be considered new
      receiver.setKnownTests({
        mocha: {},
      })

      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.strictEqual(tests.length - 1, retriedTests.length)
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          // Out of NUM_RETRIES_EFD + 1 total runs, half will be passing and half will be failing,
          // based on the global counter in the test file
          const passingTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(passingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          assert.strictEqual(failingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          // Test name does not change
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_NAME], 'fail occasionally fails')
          })
        })

      childProcess = exec(
        'node ./node_modules/mocha/bin/mocha ci-visibility/test-early-flake-detection/occasionally-failing-test*',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: '**/ci-visibility/test-early-flake-detection/occasionally-failing-test*',
          },
        }
      )

      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      childProcess.on('exit', (exitCode) => {
        assert.match(testOutput, /2 passing/)
        assert.match(testOutput, /2 failing/)
        assert.strictEqual(exitCode, 0)
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('bails out of EFD if the percentage of new tests is too high', (done) => {
      const NUM_RETRIES_EFD = 5

      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 0,
        },
        known_tests_enabled: true,
      })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
          assert.strictEqual(newTests.length, 0)

          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js',
            ]),
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    context('parallel mode', () => {
      onlyLatestIt('retries new tests', (done) => {
        // Tests from ci-visibility/test/occasionally-failing-test will be considered new
        receiver.setKnownTests({
          mocha: {},
        })

        // The total number of executions need to be an odd number, so that we
        // check that the EFD logic of ignoring failed executions is working.
        // Otherwise, a bug could slip in where we ignore the passed executions (like it was happening)
        const NUM_RETRIES_EFD = 4
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
            assert.strictEqual(testSession.meta[MOCHA_IS_PARALLEL], 'true')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            // all but one has been retried
            assert.strictEqual(tests.length - 1, retriedTests.length)
            assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
            // Out of NUM_RETRIES_EFD + 1 (5) total runs, 3 will be passing and 2 will be failing,
            // based on the global counter in the test file
            const passingTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
            const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(passingTests.length, 3)
            assert.strictEqual(failingTests.length, 2)
            // Test name does not change
            retriedTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_NAME], 'fail occasionally fails')
              assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
            })
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ' +
          '--parallel ./ci-visibility/test-early-flake-detection/occasionally-failing-test.js', {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
          })

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 0)
            done()
          }).catch(done)
        })
      })

      onlyLatestIt('retries new tests when using the programmatic API', (done) => {
        // Tests from ci-visibility/test/occasionally-failing-test will be considered new
        receiver.setKnownTests({
          mocha: {},
        })

        const NUM_RETRIES_EFD = 5
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
            assert.strictEqual(testSession.meta[MOCHA_IS_PARALLEL], 'true')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            // all but one has been retried
            assert.strictEqual(tests.length - 1, retriedTests.length)
            assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
            // Out of NUM_RETRIES_EFD + 1 total runs, half will be passing and half will be failing,
            // based on the global counter in the test file
            const passingTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
            const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(passingTests.length, (NUM_RETRIES_EFD + 1) / 2)
            assert.strictEqual(failingTests.length, (NUM_RETRIES_EFD + 1) / 2)
            // Test name does not change
            retriedTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_NAME], 'fail occasionally fails')
            })
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              RUN_IN_PARALLEL: 'true',
              TESTS_TO_RUN: JSON.stringify([
                './test-early-flake-detection/occasionally-failing-test.js',
              ]),
            },
          }
        )
        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 0)
            done()
          }).catch(done)
        })
      })

      onlyLatestIt('bails out of EFD if the percentage of new tests is too high', (done) => {
        const NUM_RETRIES_EFD = 5

        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 0,
          },
          known_tests_enabled: true,
        })
        // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
        receiver.setKnownTests({
          mocha: {
            'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)

            const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              RUN_IN_PARALLEL: 'true',
              TESTS_TO_RUN: JSON.stringify([
                './test/ci-visibility-test.js',
                './test/ci-visibility-test-2.js',
              ]),
            },
          }
        )

        childProcess.on('exit', () => {
          eventsPromise.then(() => {
            done()
          }).catch(done)
        })
      })

      onlyLatestIt('does not detect new tests if the response is invalid', async () => {
        const NUM_RETRIES_EFD = 5

        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 0,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          'not-mocha': {
            'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)

            const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              RUN_IN_PARALLEL: 'true',
              TESTS_TO_RUN: JSON.stringify([
                './test/ci-visibility-test.js',
                './test/ci-visibility-test-2.js',
              ]),
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })
    })

    it('disables early flake detection if known tests should not be requested', (done) => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
          },
        },
        known_tests_enabled: false,
      })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(oldTests.length, 1)
          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js',
            ]),
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })
  })

  context('auto test retries', () => {
    // Without dynamic ATR, the configured flat limit of four retries applies.
    const dynamicCases = [
      { name: 'custom buckets', buckets: '1,3,3,3,3', attempts: supportsDynamicAtr ? 2 : 5 },
      { name: 'backend buckets', buckets: '', attempts: supportsDynamicAtr ? 3 : 5 },
      { name: 'malformed buckets', buckets: '1,,3,3,3', attempts: supportsDynamicAtr ? 3 : 5 },
      { name: 'disabled flag', buckets: '1,3,3,3,3', attempts: 5, enabled: false },
      { name: 'recovery', buckets: '1,3,3,3,3', attempts: 2, recover: true },
      { name: 'retry hook failure', buckets: '1,3,3,3,3', attempts: 2, hookFailure: 'beforeEach' },
      { name: 'early retry beforeEach failure', buckets: '3,3,3,3,3', attempts: 2, hookFailure: 'beforeEach' },
      { name: 'early retry afterEach failure', buckets: '3,3,3,3,3', attempts: 2, hookFailure: 'afterEach' },
    ]
    for (const hookFailure of ['beforeEach', 'afterEach']) {
      dynamicCases.push({
        name: `disabled flag with early retry ${hookFailure} failure`,
        buckets: '3,3,3,3,3',
        attempts: 2,
        enabled: false,
        hookFailure,
      })
    }
    for (const enabled of [true, false]) {
      for (const hookAttempt of [0, 1]) {
        dynamicCases.push({
          name: `body and afterEach failure at attempt ${hookAttempt}, enabled=${enabled}`,
          buckets: '3,3,3,3,3',
          attempts: hookAttempt + 1,
          enabled,
          hookFailure: 'afterEach',
          hookAttempt,
          failBody: true,
        })
      }
    }
    for (const parallel of [false, true]) {
      for (const scenario of dynamicCases) {
        const runTest = parallel ? parallelIt : retryEventsIt
        const retryMode = supportsDynamicAtr ? 'uses dynamic ATR' : 'uses fixed retries without dynamic ATR'
        runTest(`${retryMode} ${scenario.name} (parallel=${parallel})`, async () => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            early_flake_detection: {
              enabled: false,
              slow_test_retries: { '5s': 2, '10s': 3, '30s': 3, '5m': 3 },
            },
          })
          const eventsPromise = receiver.gatherPayloadsMaxTimeout(
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
              const tests = payloads.flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test').map(event => event.content)
              assert.strictEqual(tests.length, scenario.attempts)
              const last = tests.at(-1)
              assert.strictEqual(last.meta[TEST_STATUS], scenario.recover ? 'pass' : 'fail')
              assert.strictEqual(last.meta[TEST_FINAL_STATUS], scenario.recover ? 'pass' : 'fail')
              assert.strictEqual(last.meta[TEST_HAS_FAILED_ALL_RETRIES], scenario.recover ? undefined : 'true')
              assert.strictEqual(last.meta[TEST_RETRY_REASON],
                scenario.attempts > 1 ? TEST_RETRY_REASON_TYPES.atr : undefined)
              assert.ok(tests.slice(0, -1).every(test => test.meta[TEST_FINAL_STATUS] === undefined))
              if (scenario.hookFailure) {
                assert.match(last.meta[ERROR_MESSAGE], new RegExp(`retry ${scenario.hookFailure} failed`))
              }
            }
          )
          childProcess = exec(runTestsCommand, {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify(['./test-flaky-test-retries/dynamic-atr.js']),
              DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: String(scenario.enabled !== false),
              DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: scenario.buckets,
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '4',
              SHOULD_CHECK_RESULTS: '1',
              ...(parallel ? { RUN_IN_PARALLEL: '1' } : {}),
              ...(scenario.recover ? { DYNAMIC_ATR_RECOVER: '1' } : {}),
              ...(scenario.hookFailure ? { DYNAMIC_ATR_HOOK_FAILURE: scenario.hookFailure } : {}),
              ...(scenario.failBody
                ? { DYNAMIC_ATR_FAIL_BODY: '1', DYNAMIC_ATR_HOOK_ATTEMPT: String(scenario.hookAttempt) }
                : {}),
            },
          })
          const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
          assert.strictEqual(exitCode, scenario.recover ? 0 : 1)
        })
      }
    }

    for (const parallel of [false, true]) {
      for (const durations of [[100, 6000], [6000, 100]]) {
        const runTest = parallel ? parallelIt : dynamicAtrIt
        runTest(`isolates dynamic ATR duplicate names: ${durations} (parallel=${parallel})`, async () => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            early_flake_detection: { enabled: false },
          })
          childProcess = exec(runTestsCommand, {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify(['./test-flaky-test-retries/dynamic-atr-duplicates.js']),
              DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'true',
              DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '1,2,3,3,3',
              DYNAMIC_ATR_DURATIONS: JSON.stringify(durations),
              SHOULD_CHECK_RESULTS: '1',
              ...(parallel ? { RUN_IN_PARALLEL: '1' } : {}),
            },
          })
          childProcess.stdout.on('data', chunk => { testOutput += chunk })
          childProcess.stderr.on('data', chunk => { testOutput += chunk })
          const retryCounts = durations.map(duration => duration === 100 ? 1 : 2)
          const eventsPromise = receiver.gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
              const tests = payloads.flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test').map(event => event.content)
              assert.strictEqual(tests.length, 5, testOutput)
              for (const [index, retryCount] of retryCounts.entries()) {
                const attempts = tests.filter(test => test.meta[ERROR_MESSAGE] === `declaration ${index}`)
                assert.strictEqual(attempts.length, retryCount + 1, testOutput)
                assert.ok(attempts.every(test => test.meta[TEST_STATUS] === 'fail'))
                assert.strictEqual(attempts.filter(test =>
                  test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr).length, retryCount)
                assert.strictEqual(attempts.at(-1).meta[TEST_FINAL_STATUS], 'fail')
                assert.strictEqual(attempts.at(-1).meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
                assert.ok(attempts.slice(0, -1).every(test => test.meta[TEST_FINAL_STATUS] === undefined))
              }
            }
          )
          const [[exitCode]] = await Promise.all([once(childProcess, 'close'), eventsPromise])
          assert.strictEqual(exitCode, 1, testOutput)
          const budgets = [...testOutput.matchAll(/RETRY_BUDGET (\[[^\n]+\])/g)].map(match => JSON.parse(match[1]))
          const expectedBudgets = retryCounts.flatMap(count => [
            [0, 3],
            ...Array.from({ length: count }, (_, index) => [index + 1, count]),
          ])
          assert.deepStrictEqual(budgets, expectedBudgets, testOutput)
        })
      }
    }

    dynamicAtrIt('allows completed dynamic ATR worker tests to be garbage collected', async () => {
      childProcess = exec('node --expose-gc ./ci-visibility/run-mocha-atr-gc.js', {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          MOCHA_WORKER_ID: '0',
        },
      })
      childProcess.stdout.on('data', chunk => { testOutput += chunk })
      childProcess.stderr.on('data', chunk => { testOutput += chunk })
      const [exitCode] = await once(childProcess, 'close')
      assert.strictEqual(exitCode, 0, testOutput)
    })

    for (const nativeRetries of [0, 1]) {
      dynamicAtrIt(`restores ${nativeRetries} native retries after disabling dynamic ATR instrumentation`, async () => {
        receiver.setSettings({ flaky_test_retries_enabled: true })
        let output = ''
        childProcess = exec('node ./ci-visibility/run-mocha-atr-rerun.js', {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            MOCHA_NATIVE_RETRIES: String(nativeRetries),
            DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'true',
            DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '3,3,3,3,3',
          },
        })
        childProcess.stdout.on('data', chunk => { output += chunk })
        childProcess.stderr.on('data', chunk => { output += chunk })
        const [exitCode] = await once(childProcess, 'close')
        assert.strictEqual(exitCode, 0, output)
        assert.ok(output.includes(`RETRY_COUNTS [4,${nativeRetries + 1}]`), output)
      })
    }

    // retry listener was released in mocha@6.0.0
    onlyLatestIt('retries failed tests automatically', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: {
          enabled: false,
        },
      })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-flaky-test-retries/eventually-passing-test.js',
            ]),
          },
        }
      )

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 3) // two failed retries and then the pass

          const failedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(failedAttempts.length, 2)

          failedAttempts.forEach((failedTest, index) => {
            assert.match(
              failedTest.meta[ERROR_MESSAGE],
              new RegExp(`Expected values to be strictly equal:\n\n${index + 1} !== 3`)
            )
          })

          // The first attempt is not marked as a retry
          const retriedFailure = failedAttempts.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          )
          assert.strictEqual(retriedFailure.length, 1)

          const passedAttempt = tests.find(test => test.meta[TEST_STATUS] === 'pass')
          assert.strictEqual(passedAttempt.meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(passedAttempt.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
        })

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    onlyLatestIt('is disabled if DD_CIVISIBILITY_FLAKY_RETRY_ENABLED is false', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: {
          enabled: false,
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 1)

          const retries = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)
          assert.strictEqual(retries.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-flaky-test-retries/eventually-passing-test.js',
            ]),
            DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    onlyLatestIt('retries DD_CIVISIBILITY_FLAKY_RETRY_COUNT times', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: {
          enabled: false,
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 2) // one retry

          const failedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(failedAttempts.length, 2)

          const retriedFailure = failedAttempts.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          )
          assert.strictEqual(retriedFailure.length, 1)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-flaky-test-retries/eventually-passing-test.js',
            ]),
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })

    onlyLatestIt('uses ATR retry count instead of manual Mocha retries', async () => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: {
          enabled: false,
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 2)

          const retries = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retries.length, 1)
          assert.strictEqual(retries[0].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)

          const externalRetries = tests.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.ext
          )
          assert.strictEqual(externalRetries.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-flaky-test-retries/eventually-passing-test.js',
            ]),
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            MOCHA_RETRIES: '5',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    onlyLatestIt('sets TEST_HAS_FAILED_ALL_RETRIES when all ATR attempts fail', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Mark fail-test as known so EFD does not run; only ATR will retry
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test/fail-test.js': ['can report failed tests'],
          'ci-visibility/mocha-hooks/flaky-fails-with-hooks.js': [
            'mocha-hooks flaky-fails can retry failed tests',
          ],
        },
      })
      const NUM_RETRIES_ATR = 2
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        flaky_test_retries_count: NUM_RETRIES_ATR,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const failTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/fail-test.js'
          )

          assert.strictEqual(failTests.length, NUM_RETRIES_ATR + 1)
          failTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
          })

          const retriedTests = failTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, NUM_RETRIES_ATR)
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
          })

          const lastRetry = failTests[failTests.length - 1]
          assert.strictEqual(lastRetry.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')

          for (let i = 0; i < failTests.length - 1; i++) {
            assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in failTests[i].meta))
          }

          // With afterEach hooks: retries should still be tagged with ATR reason and HAS_FAILED_ALL_RETRIES
          const hooksTests = tests
            .filter(test =>
              test.meta[TEST_SUITE] === 'ci-visibility/mocha-hooks/flaky-fails-with-hooks.js'
            )
            .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
          assert.strictEqual(hooksTests.length, NUM_RETRIES_ATR + 1)
          const hooksRetries = hooksTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(hooksRetries.length, NUM_RETRIES_ATR)
          hooksRetries.forEach(test => {
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
          })
          const lastHooksRetry = hooksTests[hooksTests.length - 1]
          assert.strictEqual(lastHooksRetry.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
          for (let i = 0; i < hooksTests.length - 1; i++) {
            assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in hooksTests[i].meta))
          }
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/fail-test.js',
              './mocha-hooks/flaky-fails-with-hooks.js',
            ]),
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: String(NUM_RETRIES_ATR),
          },
        }
      )

      await Promise.all([once(childProcess, 'exit'), eventsPromise])
    })

    onlyLatestIt('retries failed tests automatically in parallel mode', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        early_flake_detection: {
          enabled: false,
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // Verify we are in parallel mode
          const sessionEvent = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(sessionEvent.meta[MOCHA_IS_PARALLEL], 'true')

          // Each file has 1 test that fails twice then passes (3 events per file, 6 total)
          assert.strictEqual(tests.length, 6)

          const failedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(failedAttempts.length, 4)

          const passedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          assert.strictEqual(passedAttempts.length, 2)

          // Retries should be tagged with ATR reason
          const atrRetries = tests.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          )
          assert.strictEqual(atrRetries.length, 4)

          passedAttempts.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
          })

          // Verify tests ran in separate worker processes
          const testsBySuite = {}
          for (const test of tests) {
            const suiteName = test.meta[TEST_SUITE]
            if (!testsBySuite[suiteName]) {
              testsBySuite[suiteName] = test
            }
          }
          const testFromEachWorker = Object.values(testsBySuite)
          assert.strictEqual(testFromEachWorker.length, 2)
          const runtimeIds = testFromEachWorker.map(test => test.meta['runtime-id'])
          assert.ok(runtimeIds[0])
          assert.ok(runtimeIds[1])
          assert.notStrictEqual(runtimeIds[0], runtimeIds[1])
        })

      childProcess = exec(
        'node node_modules/mocha/bin/mocha --parallel --jobs 2' +
        ' ./ci-visibility/test-flaky-test-retries/eventually-passing-test-parallel.js' +
        ' ./ci-visibility/test-flaky-test-retries/eventually-passing-test-parallel-2.js',
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
      await Promise.all([
        eventsPromise,
        once(childProcess, 'exit'),
      ])
    })
  })

  it('takes into account untested files if "all" is passed to nyc', (done) => {
    const linePctMatchRegex = /Lines\s*:\s*(\d+(?:\.\d+)?)%/
    let linePctMatch
    let linesPctFromNyc = 0
    let codeCoverageWithUntestedFiles = 0
    let codeCoverageWithoutUntestedFiles = 0

    let eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testSession = events.find(event => event.type === 'test_session_end').content
        codeCoverageWithUntestedFiles = testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT]
      })

    childProcess = exec(
      './node_modules/nyc/bin/nyc.js -r=text-summary --all --nycrc-path ./my-nyc.config.js ' +
      'node node_modules/mocha/bin/mocha ./ci-visibility/test/ci-visibility-test.js',
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      }
    )

    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })

    childProcess.on('exit', () => {
      linePctMatch = testOutput.match(linePctMatchRegex)
      linesPctFromNyc = linePctMatch ? Number(linePctMatch[1]) : -Infinity

      assert.strictEqual(linesPctFromNyc, codeCoverageWithUntestedFiles,
        'nyc --all output does not match the reported coverage')

      // reset test output for next test session
      testOutput = ''
      // we run the same tests without the all flag
      childProcess = exec(
        './node_modules/nyc/bin/nyc.js -r=text-summary --nycrc-path ./my-nyc.config.js ' +
        'node node_modules/mocha/bin/mocha ./ci-visibility/test/ci-visibility-test.js',
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )

      eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          codeCoverageWithoutUntestedFiles = testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT]
        })

      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      childProcess.on('exit', () => {
        linePctMatch = testOutput.match(linePctMatchRegex)
        linesPctFromNyc = linePctMatch ? Number(linePctMatch[1]) : -Infinity

        assert.strictEqual(linesPctFromNyc, codeCoverageWithoutUntestedFiles,
          'nyc output does not match the reported coverage (no --all flag)')

        eventsPromise.then(() => {
          assert.ok(
            codeCoverageWithoutUntestedFiles > codeCoverageWithUntestedFiles,
            `Expected ${codeCoverageWithoutUntestedFiles} > ${codeCoverageWithUntestedFiles}`
          )
          done()
        }).catch(done)
      })
    })
  })

  context('dynamic instrumentation', () => {
    // retry listener was released in mocha@6.0.0
    onlyLatestIt('does not activate dynamic instrumentation if DD_TEST_FAILED_TEST_REPLAY_ENABLED is set to false',
      async () => {
        receiver.setSettings({
          flaky_test_retries_enabled: true,
          di_enabled: true,
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const retriedTests = tests.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            )

            assert.strictEqual(retriedTests.length, 1)
            const [retriedTest] = retriedTests

            const hasDebugTags = Object.keys(retriedTest.meta)
              .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

            assert.strictEqual(hasDebugTags, false)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify([
                './dynamic-instrumentation/test-hit-breakpoint',
              ]),
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
              DD_TEST_FAILED_TEST_REPLAY_ENABLED: 'false',
              REPORT_FINAL_FLUSH: finalFlushMarker,
            },
          }
        )

        const logsPromise = capturePayloadsUntilFinalFlush(
          receiver,
          childProcess,
          ({ url }) => url.endsWith('/api/v2/logs')
        )
        const [[exitCode], logs] = await Promise.all([
          once(childProcess, 'exit'),
          logsPromise,
          eventsPromise,
        ])
        assert.strictEqual(exitCode, 0)
        assert.deepStrictEqual(logs, [])
      })

    onlyLatestIt('does not activate dynamic instrumentation if remote settings are disabled', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: false,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          )

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          const hasDebugTags = Object.keys(retriedTest.meta)
            .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

          assert.strictEqual(hasDebugTags, false)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './dynamic-instrumentation/test-hit-breakpoint',
            ]),
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            REPORT_FINAL_FLUSH: finalFlushMarker,
          },
        }
      )

      const logsPromise = capturePayloadsUntilFinalFlush(
        receiver,
        childProcess,
        ({ url }) => url.endsWith('/api/v2/logs')
      )
      const [[exitCode], logs] = await Promise.all([
        once(childProcess, 'exit'),
        logsPromise,
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 0)
      assert.deepStrictEqual(logs, [])
    })

    onlyLatestIt('runs retries with dynamic instrumentation', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })

      let snapshotIdByTest, snapshotIdByLog
      let spanIdByTest, spanIdByLog, traceIdByTest, traceIdByLog

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          )

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          assert.strictEqual(retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED], 'true')
          assert.strictEqual(retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
            .endsWith('ci-visibility/dynamic-instrumentation/dependency.js'), true)
          assert.strictEqual(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 6)

          const snapshotIdKey = `${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX}`

          assert.ok(retriedTest.meta[snapshotIdKey])

          snapshotIdByTest = retriedTest.meta[snapshotIdKey]
          spanIdByTest = retriedTest.span_id.toString()
          traceIdByTest = retriedTest.trace_id.toString()

          const notRetriedTest = tests.find(test => test.meta[TEST_NAME].includes('is not retried'))

          assert.ok(!('DI_ERROR_DEBUG_INFO_CAPTURED' in notRetriedTest.meta))
        })

      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          const [{ logMessage: [diLog] }] = payloads
          assertObjectContains(diLog, {
            ddsource: 'dd_debugger',
            level: 'error',
          })
          assert.strictEqual(diLog.debugger.snapshot.language, 'javascript')
          assertObjectContains(diLog.debugger.snapshot.captures.lines['6'].locals, {
            a: {
              type: 'number',
              value: '11',
            },
            b: {
              type: 'number',
              value: '3',
            },
            localVariable: {
              type: 'number',
              value: '2',
            },
          })
          spanIdByLog = diLog.dd.span_id
          traceIdByLog = diLog.dd.trace_id
          snapshotIdByLog = diLog.debugger.snapshot.id
        }, 5000)

      childProcess = exec(
        'node ./ci-visibility/run-mocha.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './dynamic-instrumentation/test-hit-breakpoint',
            ]),
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            // Opt out: the bootstrap adds enough child startup overhead that the single DI
            // retry races the Inspector probe arming. Pre-instrumentation reduced (but did
            // not eliminate) the slowdown, and this test is sensitive to either side of it.
            _DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1',
          },
        }
      )

      childProcess.on('exit', () => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.strictEqual(snapshotIdByTest, snapshotIdByLog)
          assert.strictEqual(spanIdByTest, spanIdByLog)
          assert.strictEqual(traceIdByTest, traceIdByLog)
          done()
        }).catch(done)
      })
    })

    onlyLatestIt('reinstalls a probe for a later failure from the same location', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })

      const testNamesWithDebugInfo = new Set()
      let testOutput = ''

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          )

          assert.strictEqual(retriedTests.length, 4)
          for (const retriedTest of retriedTests) {
            if (retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED] === 'true') {
              testNamesWithDebugInfo.add(retriedTest.meta[TEST_NAME])
            }
          }
          assert.strictEqual(testNamesWithDebugInfo.size, 2)
          assert.ok(testNamesWithDebugInfo.has(
            'dynamic-instrumentation exhausts retries for the first failure with DI'
          ))
          assert.ok(testNamesWithDebugInfo.has(
            'dynamic-instrumentation retries a later failure from the same location with DI'
          ))
        })

      childProcess = exec(
        'node ./ci-visibility/run-mocha.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './dynamic-instrumentation/test-reinstall-probe',
            ]),
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
            _DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1',
          },
        }
      )

      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      const stdoutEndPromise = childProcess.stdout ? once(childProcess.stdout, 'end') : Promise.resolve()
      const stderrEndPromise = childProcess.stderr ? once(childProcess.stderr, 'end') : Promise.resolve()

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
        stdoutEndPromise,
        stderrEndPromise,
      ])
      assert.strictEqual(exitCode, 0, testOutput)
    })

    onlyLatestIt('cancels a queued probe while a prior removal is pending', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })

      let retriedTests = []
      let testOutput = ''

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          retriedTests = tests.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          )
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '-r ./ci-visibility/dynamic-instrumentation/hold-probe-removal -r dd-trace/ci/init',
            TESTS_TO_RUN: JSON.stringify([
              './dynamic-instrumentation/test-cancel-pending-probe',
            ]),
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            DD_TRACE_DEBUG: 'true',
            _DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1',
          },
        }
      )

      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      const stdoutEndPromise = childProcess.stdout ? once(childProcess.stdout, 'end') : Promise.resolve()
      const stderrEndPromise = childProcess.stderr ? once(childProcess.stderr, 'end') : Promise.resolve()

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
        stdoutEndPromise,
        stderrEndPromise,
      ])
      assert.strictEqual(exitCode, 0, testOutput)
      assert.strictEqual(testOutput.includes('Unknown probe id'), false)
      assert.strictEqual(retriedTests.length, 2)
      for (const retriedTest of retriedTests) {
        assert.strictEqual(retriedTest.meta[TEST_STATUS], 'fail')
      }
    })

    onlyLatestIt('drains in-flight dynamic instrumentation hits before the next retry', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })

      const retrySpanIdsWithDebugInfo = new Set()
      const diLogSpanIds = []
      let testOutput = ''

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          )

          assert.strictEqual(retriedTests.length, 3)
          for (const retriedTest of retriedTests) {
            if (retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED] === 'true') {
              retrySpanIdsWithDebugInfo.add(retriedTest.span_id.toString())
            }
          }
          assert.ok(retrySpanIdsWithDebugInfo.size >= 1)
        })

      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          const diLogs = payloads.flatMap(({ logMessage }) => logMessage)
          assert.ok(diLogs.length >= 1)
          for (const diLog of diLogs) {
            diLogSpanIds.push(diLog.dd.span_id)
          }
        }, 5000)

      childProcess = exec(
        'node ./ci-visibility/run-mocha.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './dynamic-instrumentation/test-hit-breakpoint-multiple-retries',
            ]),
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '5',
            DD_TRACE_DEBUG: 'true',
            DD_TRACE_LOG_LEVEL: 'warn',
            _DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1',
          },
        }
      )

      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      const stdoutEndPromise = childProcess.stdout ? once(childProcess.stdout, 'end') : Promise.resolve()
      const stderrEndPromise = childProcess.stderr ? once(childProcess.stderr, 'end') : Promise.resolve()

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
        logsPromise,
        stdoutEndPromise,
        stderrEndPromise,
      ])
      assert.strictEqual(exitCode, 0, testOutput)
      assert.doesNotMatch(testOutput, /Breakpoint snapshot could not be attached to the active test span/)
      for (const diLogSpanId of diLogSpanIds) {
        assert.ok(retrySpanIdsWithDebugInfo.has(diLogSpanId))
      }
    })

    onlyLatestIt('reports a passing suite for root afterEach tests retried with dynamic instrumentation', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })

      const suiteFile = 'ci-visibility/dynamic-instrumentation/top-level-test-hit-breakpoint.js'
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const suiteEvents = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
          const retriedTests = tests.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          )

          assert.strictEqual(suiteEvents.length, 1)
          assertObjectContains(suiteEvents[0], { meta: { [TEST_SUITE]: suiteFile, [TEST_STATUS]: 'pass' } })

          assert.strictEqual(retriedTests.length, 1)
          assert.strictEqual(retriedTests[0].meta[DI_ERROR_DEBUG_INFO_CAPTURED], 'true')
        })

      childProcess = exec(
        'node ./ci-visibility/run-mocha.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './dynamic-instrumentation/top-level-test-hit-breakpoint',
            ]),
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            TEST_SHOULD_PASS_AFTER_RETRY: '1',
            _DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1',
          },
        }
      )

      childProcess.on('exit', (code) => {
        eventsPromise.then(() => {
          assert.strictEqual(code, 0)
          done()
        }).catch(done)
      })
    })

    onlyLatestIt('finishes parallel afterEach retries with dynamic instrumentation', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(
            test => test.meta[TEST_IS_RETRY] === 'true' &&
              test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          )

          assert.strictEqual(retriedTests.length, 1)
          assert.strictEqual(retriedTests[0].meta[TEST_STATUS], 'pass')
          assert.strictEqual(retriedTests[0].meta[TEST_FINAL_STATUS], 'pass')
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './dynamic-instrumentation/mocha-parallel-test-hit-breakpoint-after-each',
              './dynamic-instrumentation/parallel-test-hit-breakpoint-2',
            ]),
            RUN_IN_PARALLEL: '1',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            _DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1',
          },
        }
      )

      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      const stdoutEndPromise = childProcess.stdout ? once(childProcess.stdout, 'end') : Promise.resolve()
      const stderrEndPromise = childProcess.stderr ? once(childProcess.stderr, 'end') : Promise.resolve()

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
        stdoutEndPromise,
        stderrEndPromise,
      ])
      assert.strictEqual(exitCode, 0, testOutput)
    })

    onlyLatestIt('does not crash if the retry does not hit the breakpoint', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          )

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          const hasDebugTags = Object.keys(retriedTest.meta)
            .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

          assert.strictEqual(hasDebugTags, false)
        })
      childProcess = exec(
        'node ./ci-visibility/run-mocha.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './dynamic-instrumentation/test-not-hit-breakpoint',
            ]),
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            REPORT_FINAL_FLUSH: finalFlushMarker,
          },
        }
      )

      const logsPromise = capturePayloadsUntilFinalFlush(
        receiver,
        childProcess,
        ({ url }) => url.endsWith('/api/v2/logs')
      )
      const [[exitCode], logs] = await Promise.all([
        once(childProcess, 'exit'),
        logsPromise,
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 0)
      assert.deepStrictEqual(logs, [])
    })

    onlyLatestIt('does not hang when tests use fake timers and Failed Test Replay is enabled', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 2)
          const retriedTests = tests.filter(
            t => t.meta[TEST_IS_RETRY] === 'true'
          )
          assert.strictEqual(retriedTests.length, 1)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './dynamic-instrumentation/fake-timers-test-hit-breakpoint',
            ]),
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
          },
        }
      )

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
      assert.strictEqual(exitCode, 0)
    })

    it('tags new tests with dynamic names and logs a warning', async () => {
      receiver.setKnownTests({ mocha: {} })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: { '5s': 1 },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const uniqueTests = new Map()
          for (const test of tests) {
            if (!uniqueTests.has(test.meta[TEST_NAME])) {
              uniqueTests.set(test.meta[TEST_NAME], test)
            }
          }

          const dynamicTests = [...uniqueTests.values()]
            .filter(test => test.meta[TEST_HAS_DYNAMIC_NAME] === 'true')
          assert.strictEqual(dynamicTests.length, 8)

          dynamicTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
        }
      )

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify(['./test/dynamic-name-test.js']),
          },
        }
      )

      let testOutput = ''
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      await Promise.all([once(childProcess, 'exit'), eventsPromise])

      assert.match(testOutput, /detected as new but their names contain dynamic data/)
    })
  })

  context('known tests without early flake detection', () => {
    it('detects new tests without retrying them', (done) => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: false,
        },
        known_tests_enabled: true,
      })
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // no other tests are considered new
          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(oldTests.length, 1)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)
          // no test has been retried
          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js',
            ]),
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })
  })

  it('sets _dd.test.is_user_provided_service to true if DD_SERVICE is used', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)

        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        tests.forEach(test => {
          assert.strictEqual(test.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'true')
        })
      })

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: JSON.stringify([
            './test/ci-visibility-test.js',
            './test/ci-visibility-test-2.js',
          ]),
          DD_SERVICE: 'my-service',
        },
      }
    )

    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
  })

  context('test management', () => {
    context('attempt to fix', () => {
      beforeEach(() => {
        receiver.setTestManagementTests({
          mocha: {
            suites: {
              'ci-visibility/test-management/test-attempt-to-fix-1.js': {
                tests: {
                  'attempt to fix tests can attempt to fix a test': {
                    properties: {
                      attempt_to_fix: true,
                    },
                  },
                },
              },
            },
          },
        })
      })

      const getTestAssertions = ({
        isAttemptToFix,
        shouldAlwaysPass,
        shouldFailSometimes,
        isQuarantined,
        isDisabled,
      }) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isAttemptToFix) {
              assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
            } else {
              assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
            }

            const resourceNames = tests.map(span => span.resource)

            assertObjectContains(resourceNames,
              [
                'ci-visibility/test-management/test-attempt-to-fix-1.js.attempt to fix tests can attempt to fix a test',
              ]
            )

            const retriedTests = tests.filter(
              test => test.meta[TEST_NAME] === 'attempt to fix tests can attempt to fix a test'
            )

            for (let i = 0; i < retriedTests.length; i++) {
              const test = retriedTests[i]
              const isFirstAttempt = i === 0
              const isLastAttempt = i === retriedTests.length - 1
              if (!isAttemptToFix) {
                assert.ok(!(TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX in test.meta))
                assert.ok(!(TEST_IS_RETRY in test.meta))
                assert.ok(!(TEST_RETRY_REASON in test.meta))
                const expectedFinalStatus = (isQuarantined || isDisabled) ? 'skip' : test.meta[TEST_STATUS]
                assert.strictEqual(test.meta[TEST_FINAL_STATUS], expectedFinalStatus)
                continue
              }

              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
              if (isFirstAttempt) {
                assert.ok(!(TEST_IS_RETRY in test.meta))
                assert.ok(!(TEST_RETRY_REASON in test.meta))
              } else {
                assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
              }

              if (isQuarantined) {
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              }

              if (isDisabled) {
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
              }

              if (isLastAttempt) {
                if (shouldAlwaysPass) {
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
                  assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                } else if (shouldFailSometimes) {
                  assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                } else {
                  assert.strictEqual(test.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                }
                // Attempt to fix ignores quarantine/disabled outcome suppression:
                // pass only if all attempts passed, fail otherwise.
                assert.strictEqual(test.meta[TEST_FINAL_STATUS], shouldAlwaysPass ? 'pass' : 'fail')
              } else {
                // Intermediate ATF executions must not carry a final status tag
                assert.ok(!(TEST_FINAL_STATUS in test.meta))
              }
            }
          })

      /**
       * @param {() => void} done
       * @param {{
       *   isAttemptToFix?: boolean,
       *   isQuarantined?: boolean,
       *   isDisabled?: boolean,
       *   shouldAlwaysPass?: boolean,
       *   shouldFailSometimes?: boolean,
       *   extraEnvVars?: Record<string, string>
       * }} [options]
       */
      const runAttemptToFixTest = (done, {
        isAttemptToFix,
        shouldAlwaysPass,
        shouldFailSometimes,
        isQuarantined,
        isDisabled,
        extraEnvVars = {},
      } = {}) => {
        let stdout = ''
        const testAssertionsPromise = getTestAssertions({
          isAttemptToFix,
          shouldAlwaysPass,
          shouldFailSometimes,
          isQuarantined,
          isDisabled,
        })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify([
                './test-management/test-attempt-to-fix-1.js',
              ]),
              SHOULD_CHECK_RESULTS: '1',
              ...extraEnvVars,
              ...(shouldAlwaysPass ? { SHOULD_ALWAYS_PASS: '1' } : {}),
              ...(shouldFailSometimes ? { SHOULD_FAIL_SOMETIMES: '1' } : {}),
            },
          }
        )

        childProcess.stdout?.on('data', (data) => {
          stdout += data
        })

        childProcess.stderr?.on('data', (data) => {
          stdout += data
        })

        childProcess.on('exit', exitCode => {
          testAssertionsPromise.then(() => {
            assert.match(stdout, /I am running when attempt to fix/)
            if (isAttemptToFix) {
              assert.match(
                stdout,
                /Datadog Test Optimization: attempting to fix .*attempt to fix tests can attempt to fix a test/
              )
              assert.strictEqual(
                (stdout.match(
                  /Datadog Test Optimization: attempting to fix .*attempt to fix tests can attempt to fix a test/g
                ) || []).length,
                1
              )
              assert.match(stdout, /Datadog Test Optimization/)
              if (shouldAlwaysPass) {
                assert.match(stdout, /Attempt to fix passed/)
              } else {
                assert.match(stdout, /Attempt to fix failed/)
                assert.doesNotMatch(stdout, /executions? [\d, -]+:/)
              }
              if (isQuarantined || isDisabled) {
                assert.doesNotMatch(stdout, /Errors are suppressed because this test is/)
              }
            }
            if (shouldAlwaysPass) {
              assert.strictEqual(exitCode, 0)
            } else {
              assert.strictEqual(exitCode, 1)
            }
            done()
          }).catch(done)
        })
      }

      onlyLatestIt('can attempt to fix and mark last attempt as failed if every attempt fails', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done, { isAttemptToFix: true })
      })

      onlyLatestIt('can attempt to fix and mark last attempt as passed if every attempt passes', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done, { isAttemptToFix: true, shouldAlwaysPass: true })
      })

      onlyLatestIt('can attempt to fix and not mark last attempt if attempts both pass and fail', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done, { isAttemptToFix: true, shouldFailSometimes: true })
      })

      onlyLatestIt('disables manual Mocha retries for attempt-to-fix tests', async () => {
        const NUM_RETRIES = 2
        const testName = 'attempt to fix tests that fail first ' +
          'can attempt to fix a test that fails first then passes'
        receiver.setSettings({
          flaky_test_retries_enabled: true,
          flaky_test_retries_count: 5,
          early_flake_detection: { enabled: false },
          test_management: { enabled: true, attempt_to_fix_retries: NUM_RETRIES },
        })
        receiver.setTestManagementTests({
          mocha: {
            suites: {
              'ci-visibility/test-management/test-attempt-to-fix-fails-first.js': {
                tests: {
                  [testName]: {
                    properties: {
                      attempt_to_fix: true,
                    },
                  },
                },
              },
            },
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events
              .filter(event => event.type === 'test')
              .map(event => event.content)
              .filter(test => test.meta[TEST_NAME] === testName)
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            assert.strictEqual(tests.length, NUM_RETRIES + 1)
            assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
            assert.ok(!(TEST_IS_RETRY in tests[0].meta))
            assert.ok(!(TEST_RETRY_REASON in tests[0].meta))

            const retriedTests = tests.slice(1)
            retriedTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_STATUS], 'pass')
              assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
              assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
            })

            const externalRetries = tests.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.ext
            )
            assert.strictEqual(externalRetries.length, 0)

            assert.strictEqual(tests[tests.length - 1].meta[TEST_FINAL_STATUS], 'fail')
            assert.strictEqual(
              tests[tests.length - 1].meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED],
              'false'
            )
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify([
                './test-management/test-attempt-to-fix-fails-first.js',
              ]),
              MOCHA_RETRIES: '2',
              SET_RETRIES_INSIDE_TEST: '1',
              SHOULD_CHECK_RESULTS: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
        assert.strictEqual(exitCode, 1)
      })

      onlyLatestIt('does not attempt to fix tests if test management is not enabled', (done) => {
        receiver.setSettings({ test_management: { enabled: false, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done)
      })

      onlyLatestIt('does not enable attempt to fix tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done, { extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } })
      })

      onlyLatestIt('does not tag known attempt to fix tests as new', async () => {
        receiver.setKnownTests({
          mocha: {
            'ci-visibility/test-management/test-attempt-to-fix-1.js': [
              'attempt to fix tests can attempt to fix a test',
            ],
          },
        })
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: 2 },
          early_flake_detection: {
            enabled: true,
            slow_test_retries: { '5s': 2 },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const atfTests = tests.filter(
              t => t.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] === 'true'
            )
            assert.ok(atfTests.length > 0, `Expected ${atfTests.length} > 0`)
            for (const test of atfTests) {
              assert.ok(
                !(TEST_IS_NEW in test.meta),
                'ATF test that is in known tests should not be tagged as new'
              )
            }
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify([
                './test-management/test-attempt-to-fix-1.js',
              ]),
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      onlyLatestIt('ignores quarantine when attempting to fix a test', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
        receiver.setTestManagementTests({
          mocha: {
            suites: {
              'ci-visibility/test-management/test-attempt-to-fix-1.js': {
                tests: {
                  'attempt to fix tests can attempt to fix a test': {
                    properties: {
                      attempt_to_fix: true,
                      quarantined: true,
                    },
                  },
                },
              },
            },
          },
        })

        runAttemptToFixTest(done, { isAttemptToFix: true, isQuarantined: true })
      })

      onlyLatestIt(
        'checks atf_passed, atf_failed, test_is_retry and test_has_failed_all_retries tags on tests with hooks',
        (done) => {
          const NUM_RETRIES = 3
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: NUM_RETRIES } })
          receiver.setTestManagementTests({
            mocha: {
              suites: {
                'ci-visibility/test-management/test-attempt-to-fix-with-after-each.js': {
                  tests: {
                    'attempt to fix tests can attempt to fix a test that always passes': {
                      properties: { attempt_to_fix: true },
                    },
                    'attempt to fix tests can attempt to fix a test that always fails': {
                      properties: { attempt_to_fix: true },
                    },
                  },
                },
              },
            },
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const retriedTestsAlwaysPass = events.filter(event => event.type === 'test')
                .map(event => event.content)
                .filter(test => test.meta[TEST_NAME] ===
                  'attempt to fix tests can attempt to fix a test that always passes')
                .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
              assert.strictEqual(retriedTestsAlwaysPass.length, NUM_RETRIES + 1)

              const retriedTestsAlwaysFails = events.filter(event => event.type === 'test')
                .map(event => event.content)
                .filter(test => test.meta[TEST_NAME] ===
                  'attempt to fix tests can attempt to fix a test that always fails')
                .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
              assert.strictEqual(retriedTestsAlwaysFails.length, NUM_RETRIES + 1)

              // Tags test
              retriedTestsAlwaysPass.forEach((test, index) => {
                if (index === 0) {
                  assert.ok(!(TEST_IS_RETRY in test.meta))
                } else {
                  assert.ok(TEST_IS_RETRY in test.meta)
                  assert.ok(TEST_RETRY_REASON in test.meta)
                  assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                  assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
                }

                if (index < NUM_RETRIES) {
                  assert.ok(!(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED in test.meta))
                  assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                } else {
                  assert.ok(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED in test.meta)
                  // Tag is only reported if the test has failed all retries
                  assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
                }
              })

              retriedTestsAlwaysFails.forEach((test, index) => {
                if (index === 0) {
                  assert.ok(!(TEST_IS_RETRY in test.meta))
                } else {
                  assert.ok(TEST_IS_RETRY in test.meta)
                  assert.ok(TEST_RETRY_REASON in test.meta)
                  assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                  assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
                }

                if (index < NUM_RETRIES) {
                  assert.ok(!(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED in test.meta))
                  assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                } else {
                  assert.ok(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED in test.meta)
                  assert.ok(TEST_HAS_FAILED_ALL_RETRIES in test.meta)
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                  assert.strictEqual(test.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
                }
              })
            })

          childProcess = exec(
            runTestsCommand,
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TESTS_TO_RUN: JSON.stringify(['./test-management/test-attempt-to-fix-with-after-each.js']),
              },
            }
          )

          childProcess.on('exit', () => {
            eventsPromise.then(() => done()).catch(done)
          })
        })

      onlyLatestIt('omits final status on intermediate attempt to fix hook failures', async () => {
        const NUM_RETRIES = 3
        const testName = 'attempt to fix tests with failing afterEach ' +
          'can attempt to fix a test whose afterEach fails before the last attempt'
        let stdout = ''
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: NUM_RETRIES } })
        receiver.setTestManagementTests({
          mocha: {
            suites: {
              'ci-visibility/test-management/test-attempt-to-fix-with-failing-after-each.js': {
                tests: {
                  [testName]: {
                    properties: {
                      attempt_to_fix: true,
                      quarantined: true,
                    },
                  },
                },
              },
            },
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const retriedTests = events.filter(event => event.type === 'test')
              .map(event => event.content)
              .filter(test => test.meta[TEST_NAME] === testName)
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            assert.strictEqual(retriedTests.length, 2)

            const finalStatusTests = retriedTests.filter(test => TEST_FINAL_STATUS in test.meta)
            assert.strictEqual(finalStatusTests.length, 0)

            retriedTests.forEach((test, index) => {
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

              if (index === 1) {
                assert.strictEqual(test.meta[TEST_STATUS], 'fail')
              }

              assert.ok(!(TEST_FINAL_STATUS in test.meta))
              assert.ok(!(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED in test.meta))
              assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
            })
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify([
                './test-management/test-attempt-to-fix-with-failing-after-each.js',
              ]),
              SHOULD_CHECK_RESULTS: '1',
            },
          }
        )

        childProcess.stdout?.on('data', data => {
          stdout += data
        })
        childProcess.stderr?.on('data', data => {
          stdout += data
        })

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])

        assert.match(stdout, /Attempt to fix failed: 1 of 2 execution\(s\) failed across 1 of 1 test\(s\)\./)
        assert.strictEqual(exitCode, 1)
      })

      onlyLatestIt('ignores disabled when attempting to fix a test', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
        receiver.setTestManagementTests({
          mocha: {
            suites: {
              'ci-visibility/test-management/test-attempt-to-fix-1.js': {
                tests: {
                  'attempt to fix tests can attempt to fix a test': {
                    properties: {
                      attempt_to_fix: true,
                      disabled: true,
                    },
                  },
                },
              },
            },
          },
        })

        runAttemptToFixTest(done, { isAttemptToFix: true, isDisabled: true })
      })

      onlyLatestIt('can attempt to fix in parallel mode', async () => {
        const NUM_RETRIES = 3
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: NUM_RETRIES } })
        receiver.setTestManagementTests({
          mocha: {
            suites: {
              'ci-visibility/test-management/test-attempt-to-fix-parallel-1.js': {
                tests: {
                  'attempt to fix parallel tests 1 can attempt to fix a test': {
                    properties: { attempt_to_fix: true },
                  },
                },
              },
              'ci-visibility/test-management/test-attempt-to-fix-parallel-2.js': {
                tests: {
                  'attempt to fix parallel tests 2 can attempt to fix a test': {
                    properties: { attempt_to_fix: true },
                  },
                },
              },
            },
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const sessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(sessionEvent.meta[MOCHA_IS_PARALLEL], 'true')
            assert.strictEqual(sessionEvent.meta[TEST_MANAGEMENT_ENABLED], 'true')

            // Each file: 1 initial attempt + NUM_RETRIES retries = (NUM_RETRIES + 1) per file, 2 files
            assert.strictEqual(tests.length, (NUM_RETRIES + 1) * 2)

            // All attempts fail (tests always throw)
            tests.forEach(test => {
              assert.strictEqual(test.meta[TEST_STATUS], 'fail')
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
            })

            // Last attempt of each test should have failed-all-retries
            const testsBySuite = {}
            for (const test of tests) {
              const suite = test.meta[TEST_SUITE]
              if (!testsBySuite[suite]) testsBySuite[suite] = []
              testsBySuite[suite].push(test)
            }
            for (const suiteTests of Object.values(testsBySuite)) {
              const lastAttempt = suiteTests[suiteTests.length - 1]
              assert.strictEqual(lastAttempt.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
              assert.strictEqual(lastAttempt.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
            }

            // Verify separate worker processes
            const firstTestPerSuite = Object.values(testsBySuite).map(t => t[0])
            assert.strictEqual(firstTestPerSuite.length, 2)
            const runtimeIds = firstTestPerSuite.map(t => t.meta['runtime-id'])
            assert.ok(runtimeIds[0])
            assert.ok(runtimeIds[1])
            assert.notStrictEqual(runtimeIds[0], runtimeIds[1])
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha --parallel --jobs 2' +
          ' ./ci-visibility/test-management/test-attempt-to-fix-parallel-1.js' +
          ' ./ci-visibility/test-management/test-attempt-to-fix-parallel-2.js',
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })
    })

    context('disabled', () => {
      beforeEach(() => {
        receiver.setTestManagementTests({
          mocha: {
            suites: {
              'ci-visibility/test-management/test-disabled-1.js': {
                tests: {
                  'disable tests can disable a test': {
                    properties: {
                      disabled: true,
                    },
                  },
                },
              },
            },
          },
        })
      })

      const getTestAssertions = (isDisabling) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isDisabling) {
              assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
            } else {
              assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
            }

            const resourceNames = tests.map(span => span.resource)

            assertObjectContains(resourceNames,
              [
                'ci-visibility/test-management/test-disabled-1.js.disable tests can disable a test',
              ]
            )

            const skippedTests = tests.find(
              test => test.meta[TEST_NAME] === 'disable tests can disable a test'
            )

            if (isDisabling) {
              assert.strictEqual(skippedTests.meta[TEST_STATUS], 'skip')
              assert.strictEqual(skippedTests.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
            } else {
              assert.strictEqual(skippedTests.meta[TEST_STATUS], 'fail')
              assert.ok(!(TEST_MANAGEMENT_IS_DISABLED in skippedTests.meta))
            }
          })

      const runDisableTest = (done, isDisabling, extraEnvVars = {}) => {
        let stdout = ''
        const testAssertionsPromise = getTestAssertions(isDisabling)

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify([
                './test-management/test-disabled-1.js',
              ]),
              SHOULD_CHECK_RESULTS: '1',
              ...extraEnvVars,
            },
          }
        )

        childProcess.stdout?.on('data', (data) => {
          stdout += data
        })
        childProcess.stderr?.on('data', (data) => {
          stdout += data
        })

        childProcess.on('exit', (exitCode) => {
          testAssertionsPromise.then(() => {
            if (isDisabling) {
              assert.doesNotMatch(stdout, /I am running/)
              assert.match(stdout, /Disabled: 1 test skipped\./)
              assert.strictEqual(exitCode, 0)
            } else {
              assert.match(stdout, /I am running/)
              assert.strictEqual(exitCode, 1)
            }
            done()
          }).catch(done)
        })
      }

      it('can disable tests', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runDisableTest(done, true)
      })

      onlyLatestIt('can disable tests in parallel mode', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runDisableTest(done, true,
          {
            RUN_IN_PARALLEL: '1',
            TESTS_TO_RUN: JSON.stringify([
              './test-management/test-disabled-1.js',
              './test-management/test-disabled-2.js',
            ]),
          }
        )
      })

      onlyLatestIt('fails if disable is not enabled', (done) => {
        receiver.setSettings({ test_management: { enabled: false } })

        runDisableTest(done, false)
      })

      onlyLatestIt('does not enable disable tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runDisableTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
      })
    })

    context('quarantine', () => {
      beforeEach(() => {
        receiver.setTestManagementTests({
          mocha: {
            suites: {
              'ci-visibility/test-management/test-quarantine-1.js': {
                tests: {
                  'quarantine tests can quarantine a test': {
                    properties: {
                      quarantined: true,
                    },
                  },
                },
              },
            },
          },
        })
      })

      const getTestAssertions = (isQuarantining) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isQuarantining) {
              assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
              // Session should pass because the only failing test is quarantined
              assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
            } else {
              assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
              assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
            }

            const resourceNames = tests.map(span => span.resource)

            assertObjectContains(resourceNames,
              [
                'ci-visibility/test-management/test-quarantine-1.js.quarantine tests can quarantine a test',
                'ci-visibility/test-management/test-quarantine-1.js.quarantine tests can pass normally',
              ]
            )

            const failedTest = tests.find(
              test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
            )
            // The test fails but the exit code is 0 if it's quarantined
            assert.strictEqual(failedTest.meta[TEST_STATUS], 'fail')

            if (isQuarantining) {
              assert.strictEqual(failedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            } else {
              assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in failedTest.meta))
            }
          })

      const runQuarantineTest = (done, isQuarantining, extraEnvVars = {}) => {
        let stdout = ''
        const testAssertionsPromise = getTestAssertions(isQuarantining)

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify([
                './test-management/test-quarantine-1.js',
              ]),
              SHOULD_CHECK_RESULTS: '1',
              ...extraEnvVars,
            },
          }
        )

        childProcess.stdout?.on('data', (data) => {
          stdout += data
        })
        childProcess.stderr?.on('data', (data) => {
          stdout += data
        })

        childProcess.on('exit', (exitCode) => {
          testAssertionsPromise.then(() => {
            // it runs regardless of the quarantine status
            assert.match(stdout, /I am running when quarantined/)
            if (isQuarantining) {
              assert.match(
                stdout,
                /Quarantined: 1 test run; 1 failure did not affect the test session\./
              )
              assert.strictEqual(exitCode, 0)
            } else {
              assert.strictEqual(exitCode, 1)
            }
            done()
          }).catch(done)
        })
      }

      it('can quarantine tests', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runQuarantineTest(done, true)
      })

      onlyLatestIt('can quarantine tests retried by Mocha', async () => {
        receiver.setSettings({
          test_management: { enabled: true },
          flaky_test_retries_enabled: false,
        })

        const testAssertionsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
            assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')

            const quarantinedTests = tests
              .filter(test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test')
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            assert.strictEqual(quarantinedTests.length, 3)

            quarantinedTests.forEach((test, index) => {
              assert.strictEqual(test.meta[TEST_STATUS], 'fail')
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

              if (index === 0) {
                assert.ok(!(TEST_IS_RETRY in test.meta))
                assert.ok(!(TEST_RETRY_REASON in test.meta))
              } else {
                assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
              }

              if (index === quarantinedTests.length - 1) {
                assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'skip')
              } else {
                assert.ok(!(TEST_FINAL_STATUS in test.meta))
              }
            })
          })

        let stdout = ''
        childProcess = exec(
          'node node_modules/mocha/bin/mocha --retries 2 ./ci-visibility/test-management/test-quarantine-1.js',
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
          }
        )
        childProcess.stdout?.on('data', data => {
          stdout += data
        })

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          testAssertionsPromise,
        ])

        assert.strictEqual(
          (stdout.match(/I am running when quarantined/g) || []).length,
          3
        )
        assert.strictEqual(exitCode, 0)
      })

      onlyLatestIt('can quarantine a new test retried by EFD', async () => {
        const numRetries = 3
        receiver.setKnownTests({
          mocha: {
            'ci-visibility/test-management/test-quarantine-1.js': [
              'quarantine tests can pass normally',
            ],
          },
        })
        receiver.setSettings({
          known_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: { '5s': numRetries },
            faulty_session_threshold: 100,
          },
          test_management: { enabled: true },
        })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/test-management/test-quarantine-1.js',
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
          }
        )
        childProcess.stdout?.on('data', data => { testOutput += data })
        childProcess.stderr?.on('data', data => { testOutput += data })

        const testAssertionsPromise = receiver
          .gatherPayloadsUntilChildExit(childProcess, ({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            const tests = events
              .filter(event => event.type === 'test')
              .map(event => event.content)
              .filter(test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test')

            assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
            assert.strictEqual(tests.length, numRetries + 1)
            for (const test of tests) {
              assert.strictEqual(test.meta[TEST_STATUS], 'fail')
              assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            }

            const retries = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retries.length, numRetries)
            assert.ok(retries.every(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd))

            const finalTests = tests.filter(test => TEST_FINAL_STATUS in test.meta)
            assert.strictEqual(finalTests.length, 1)
            assert.strictEqual(finalTests[0].meta[TEST_FINAL_STATUS], 'skip')
          }, { hardTimeout: 60_000 })

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          testAssertionsPromise,
        ])
        assert.match(testOutput, /Quarantined: 1 test run; 1 failure did not affect the test session\./)
        assert.strictEqual(exitCode, 0, testOutput)
      })

      onlyLatestIt('can quarantine tests retried by Mocha that eventually pass', async () => {
        receiver.setSettings({
          test_management: { enabled: true },
          flaky_test_retries_enabled: false,
        })
        receiver.setTestManagementTests({
          mocha: {
            suites: {
              'ci-visibility/test-management/quarantine-eventually-passes.js': {
                tests: {
                  'quarantine tests with retries can quarantine a test that eventually passes': {
                    properties: {
                      quarantined: true,
                    },
                  },
                },
              },
            },
          },
        })

        const testAssertionsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
            assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')

            const quarantinedTests = tests
              .filter(test => test.meta[TEST_NAME] ===
                'quarantine tests with retries can quarantine a test that eventually passes')
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            assert.strictEqual(quarantinedTests.length, 3)

            quarantinedTests.forEach((test, index) => {
              assert.strictEqual(test.meta[TEST_STATUS], index === 2 ? 'pass' : 'fail')
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

              if (index === 0) {
                assert.ok(!(TEST_IS_RETRY in test.meta))
                assert.ok(!(TEST_RETRY_REASON in test.meta))
              } else {
                assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
              }

              if (index === quarantinedTests.length - 1) {
                assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'skip')
              } else {
                assert.ok(!(TEST_FINAL_STATUS in test.meta))
              }
            })
          })

        let stdout = ''
        childProcess = exec(
          'node node_modules/mocha/bin/mocha --retries 2 ' +
          './ci-visibility/test-management/quarantine-eventually-passes.js',
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
          }
        )
        childProcess.stdout?.on('data', data => {
          stdout += data
        })

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          testAssertionsPromise,
        ])

        assert.strictEqual(
          (stdout.match(/I am running when quarantined and eventually passes/g) || []).length,
          3
        )
        assert.strictEqual(exitCode, 0)
      })

      onlyLatestIt('can disable tests in parallel mode', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runQuarantineTest(done, true,
          {
            RUN_IN_PARALLEL: '1',
            TESTS_TO_RUN: JSON.stringify([
              './test-management/test-quarantine-1.js',
              './test-management/test-quarantine-2.js',
            ]),
          }
        )
      })

      onlyLatestIt('fails if quarantine is not enabled', (done) => {
        receiver.setSettings({ test_management: { enabled: false } })

        runQuarantineTest(done, false)
      })

      onlyLatestIt('does not enable quarantine tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runQuarantineTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
      })
    })

    it('does not crash if the request to get test management tests fails', async () => {
      let testOutput = ''
      receiver.setSettings({
        test_management: { enabled: true },
        flaky_test_retries_enabled: false,
      })
      receiver.setTestManagementTestsResponseCode(500)

      // Request module waits before retrying — need longer gather timeout
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSessionEnd = events.find(event => event.type === 'test_session_end')
          assert.ok(testSessionEnd, 'expected test_session_end event in payloads')
          const testSession = testSessionEnd.content
          assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          // it is not retried
          assert.strictEqual(tests.length, 1)
        }, 60000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-management/test-attempt-to-fix-1.js',
            ]),
            DD_TRACE_DEBUG: '1',
          },
        }
      )

      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      await Promise.all([
        once(childProcess, 'exit'),
        once(childProcess.stdout, 'end'),
        once(childProcess.stderr, 'end'),
        eventsPromise,
      ])
      assert.match(testOutput, /Test management tests could not be fetched/)
    })

    onlyLatestIt(
      'works in parallel mode with test management enabled but ITR and suite skipping disabled',
      async () => {
        // This test reproduces the bug from issue #7222 where a missing 'else' keyword
        // caused onFinishRequest() to be called twice when test management is enabled
        // but ITR and suite skipping are disabled, resulting in the error:
        // "invalid state transition: RUNNING => RUNNING"
        let testOutput = ''
        receiver.setSettings({
          test_management: { enabled: true },
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: false,
          known_tests_enabled: true,
        })
        receiver.setTestManagementTests({
          mocha: {
            suites: {},
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
            assert.strictEqual(testSession.meta[MOCHA_IS_PARALLEL], 'true')
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.ok(tests.length > 0, `Expected ${tests.length} > 0`)
            const suiteEvents = events.filter(event => event.type === 'test_suite_end')
            assert.strictEqual(suiteEvents.length, 2, 'Expected exactly 2 suites to be reported')
            // Verify that tests have different runtime IDs, confirming parallel execution in different processes
            // Group tests by their suite to get one test from each worker
            const testsBySuite = {}
            for (const test of tests) {
              const suiteName = test.meta[TEST_SUITE]
              if (!testsBySuite[suiteName]) {
                testsBySuite[suiteName] = test
              }
            }
            const testFromEachWorker = Object.values(testsBySuite)
            assert.strictEqual(testFromEachWorker.length, 2, 'Expected tests from 2 different suites')
            const testRuntimeIds = testFromEachWorker.map(test => test.meta['runtime-id'])
            assert.ok(testRuntimeIds[0], 'First test should have a runtime-id')
            assert.ok(testRuntimeIds[1], 'Second test should have a runtime-id')
            // This checks that the two tests come from different workers/processes
            assert.notStrictEqual(
              testRuntimeIds[0],
              testRuntimeIds[1],
              'Tests from different workers should have different runtime-ids'
            )
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha --parallel --jobs 2 ./ci-visibility/test/ci-visibility-test*',
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
          }
        )

        childProcess.stdout?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })

        await Promise.all([
          once(childProcess, 'exit'),
          once(childProcess.stdout, 'end'),
          once(childProcess.stderr, 'end'),
          eventsPromise,
        ])

        // Verify no "invalid state transition" error occurred
        assert.doesNotMatch(testOutput, /invalid state transition/)
      })
  })

  context('libraries capabilities', () => {
    const getTestAssertions = () =>
      receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), (payloads) => {
        const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

        assert.ok(metadataDicts.length > 0, `Expected ${metadataDicts.length} > 0`)
        metadataDicts.forEach(metadata => {
          assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], '1')
          assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX], '5')
          assert.strictEqual(metadata.test[DD_CAPABILITIES_EARLY_FLAKE_DETECTION], '1')
          assert.strictEqual(metadata.test[DD_CAPABILITIES_AUTO_TEST_RETRIES], '1')
          assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE], '1')
          assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE], '1')
          assert.strictEqual(metadata.test[DD_CAPABILITIES_FAILED_TEST_REPLAY], '1')
          // capabilities logic does not overwrite test session name
          assert.strictEqual(metadata.test_levels[TEST_SESSION_NAME], 'my-test-session-name')
        })
      })

    const runTest = (done, extraEnvVars = {}) => {
      const testAssertionsPromise = getTestAssertions()

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_TEST_SESSION_NAME: 'my-test-session-name',
            ...extraEnvVars,
          },
        }
      )
      childProcess.on('exit', () => {
        testAssertionsPromise.then(() => done()).catch(done)
      })
    }

    it('adds capabilities to tests', (done) => {
      runTest(done)
    })

    onlyLatestIt('adds capabilities to tests (parallel)', (done) => {
      runTest(done, { RUN_IN_PARALLEL: '1' })
    })
  })

  context('retry and hooks', () => {
    it('works when tests are not retried', async () => {
      let stdout = ''
      const eventsPromise = receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        assert.strictEqual(tests.length, 2)

        assertObjectContains(tests.map(test => test.meta[TEST_STATUS]), [
          'pass',
          'pass',
        ])

        assertObjectContains(tests.map(test => test.resource), [
          'ci-visibility/test-nested-hooks/test-nested-hooks.js.describe is not nested',
          'ci-visibility/test-nested-hooks/test-nested-hooks.js.describe context nested test with retries',
        ])
      })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-nested-hooks/test-nested-hooks.js',
            ]),
          },
        }
      )

      childProcess.stdout?.on('data', (data) => {
        stdout += data
      })

      await Promise.all([
        once(childProcess, 'exit'),
        once(childProcess.stdout, 'end'),
        eventsPromise,
      ])

      assert.match(stdout, /beforeEach/)
      assert.match(stdout, /beforeEach in context/)
      assert.match(stdout, /test/)
      assert.match(stdout, /afterEach/)
      assert.match(stdout, /afterEach in context/)
    })

    onlyLatestIt('works when tests are retried', async () => {
      let stdout = ''
      const eventsPromise = receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        assert.strictEqual(tests.length, 3)

        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]), [
          'fail',
          'pass',
          'pass',
        ])

        assert.deepStrictEqual(tests.map(test => test.resource), [
          'ci-visibility/test-nested-hooks/test-nested-hooks.js.describe is not nested',
          'ci-visibility/test-nested-hooks/test-nested-hooks.js.describe is not nested',
          'ci-visibility/test-nested-hooks/test-nested-hooks.js.describe context nested test with retries',
        ])

        const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
        assert.strictEqual(retriedTests.length, 1)
        assert.strictEqual(retriedTests[0].meta[TEST_STATUS], 'pass')

        const notNestedTests = tests.filter(test => test.resource ===
          'ci-visibility/test-nested-hooks/test-nested-hooks.js.describe is not nested'
        )

        assert.strictEqual(notNestedTests.length, 2)
        const failedAttempts = notNestedTests.filter(test => test.meta[TEST_STATUS] === 'fail')
        assert.strictEqual(failedAttempts.length, 1)
        const passedAttempts = notNestedTests.filter(test => test.meta[TEST_STATUS] === 'pass')
        assert.strictEqual(passedAttempts.length, 1)
      })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-nested-hooks/test-nested-hooks.js',
            ]),
            SHOULD_FAIL: '1',
          },
        }
      )

      childProcess.stdout?.on('data', (data) => {
        stdout += data
      })

      await Promise.all([
        once(childProcess, 'exit'),
        once(childProcess.stdout, 'end'),
        eventsPromise,
      ])

      assert.match(stdout, /beforeEach/)
      assert.match(stdout, /beforeEach in context/)
      assert.match(stdout, /test/)
      assert.match(stdout, /afterEach/)
      assert.match(stdout, /afterEach in context/)
    })
  })

  context('impacted tests', () => {
    const NUM_RETRIES = 3
    // Written into the sandbox fixture by the before hook below.
    const manualRetryTestTitle = 'fails first then passes after manual retry'
    const manualRetryTestName = `impacted tests ${manualRetryTestTitle}`

    beforeEach(() => {
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test-impacted-test/test-impacted-1.js': ['impacted tests can pass normally'],
        },
      })
    })

    // Modify `test-impacted-1.js` to mark it as impacted
    before(() => {
      execSync('git checkout -b feature-branch', { cwd, stdio: 'ignore' })
      fs.writeFileSync(
        path.join(cwd, 'ci-visibility/test-impacted-test/test-impacted-1.js'),
        `const assert = require('assert')
        let manualRetryAttempts = 0
        describe('impacted tests', () => {
          it('can pass normally', function () {
            if (process.env.SKIP_IMPACTED_NON_MANUAL_RETRY_TESTS) {
              this.skip()
            }
            assert.strictEqual(2 + 2, 3)
          })

          it('can fail', function () {
            if (process.env.SKIP_IMPACTED_NON_MANUAL_RETRY_TESTS) {
              this.skip()
            }
            assert.strictEqual(1 + 2, 4)
          })

          it('${manualRetryTestTitle}', function () {
            if (process.env.SET_RETRIES_INSIDE_TEST) {
              this.retries(2)
            }
            assert.strictEqual(manualRetryAttempts++ > 0, true)
          })
        })`
      )
      fs.writeFileSync(
        path.join(cwd, 'ci-visibility/test-impacted-test/parallel-helper.js'),
        `const assert = require('assert')
        describe('impacted tests parallel helper', () => {
          it('can pass normally', () => {
            assert.strictEqual(1 + 2, 3)
          })
        })`
      )
      execSync('git add ci-visibility/test-impacted-test/test-impacted-1.js', { cwd, stdio: 'ignore' })
      execSync('git commit -m "modify test-impacted-1.js"', { cwd, stdio: 'ignore' })
    })

    after(() => {
      // We can't use main here because in CI it might be "master".
      // We just use `-` which goes back to the previous branch
      execSync('git checkout -', { cwd, stdio: 'ignore' })
      execSync('git branch -D feature-branch', { cwd, stdio: 'ignore' })
    })

    const getTestAssertions = ({ isModified, isEfd, isParallel, isNew }) =>
      receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const testSession = events.find(event => event.type === 'test_session_end').content

          if (isEfd) {
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
          } else {
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
          }

          const resourceNames = tests.map(span => span.resource)

          assertObjectContains(resourceNames,
            [
              'ci-visibility/test-impacted-test/test-impacted-1.js.impacted tests can pass normally',
              'ci-visibility/test-impacted-test/test-impacted-1.js.impacted tests can fail',
            ]
          )

          if (isParallel) {
            // Parallel mode in mocha requires more than a single test suite
            // Here we check that the second test suite is actually running,
            // so we can be sure that parallel mode is on
            assertObjectContains(resourceNames, [
              'ci-visibility/test-impacted-test/test-impacted-2.js.impacted tests 2 can pass normally',
              'ci-visibility/test-impacted-test/test-impacted-2.js.impacted tests 2 can fail',
            ])
          }

          const impactedTests = tests.filter(test =>
            test.meta[TEST_SOURCE_FILE] === 'ci-visibility/test-impacted-test/test-impacted-1.js' &&
            test.meta[TEST_NAME] === 'impacted tests can pass normally')

          if (isEfd) {
            assert.strictEqual(impactedTests.length, NUM_RETRIES + 1) // Retries + original test
          } else {
            assert.strictEqual(impactedTests.length, 1)
          }

          for (const impactedTest of impactedTests) {
            if (isModified) {
              assert.strictEqual(impactedTest.meta[TEST_IS_MODIFIED], 'true')
            } else {
              assert.ok(!(TEST_IS_MODIFIED in impactedTest.meta))
            }
            if (isNew) {
              assert.strictEqual(impactedTest.meta[TEST_IS_NEW], 'true')
            } else {
              assert.ok(!(TEST_IS_NEW in impactedTest.meta))
            }
          }

          if (isEfd) {
            // Need to filter down to 'impacted tests can pass normally' because
            // the other test is also retried. This is because we don't have line visibility:
            // We'll retry all the test in a file as long as any of them is modified.
            const retriedTests = tests.filter(
              test => test.meta[TEST_IS_RETRY] === 'true' &&
              test.meta[TEST_NAME] === 'impacted tests can pass normally'
            )
            assert.strictEqual(retriedTests.length, NUM_RETRIES)
            let retriedTestNew = 0
            let retriedTestsWithReason = 0
            retriedTests.forEach(test => {
              if (test.meta[TEST_IS_NEW] === 'true') {
                retriedTestNew++
              }
              if (test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd) {
                retriedTestsWithReason++
              }
            })
            assert.strictEqual(retriedTestNew, isNew ? NUM_RETRIES : 0)
            assert.strictEqual(retriedTestsWithReason, NUM_RETRIES)
          }
        })

    const runImpactedTest = async (
      { isModified, isEfd = false, isParallel = false, isNew = false },
      extraEnvVars = {}
    ) => {
      const testAssertionsPromise = getTestAssertions({ isModified, isEfd, isParallel, isNew })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-impacted-test/test-impacted-1',
            ]),
            // we need to trick this process into not reading the event.json contents for GitHub,
            // otherwise we'll take the diff from the base repository, not from the test project in `cwd`
            GITHUB_BASE_REF: '',
            ...extraEnvVars,
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        testAssertionsPromise,
      ])
    }

    const setAttemptToFixForManualRetryTest = () => {
      receiver.setTestManagementTests({
        mocha: {
          suites: {
            'ci-visibility/test-impacted-test/test-impacted-1.js': {
              tests: {
                [manualRetryTestName]: {
                  properties: {
                    attempt_to_fix: true,
                  },
                },
              },
            },
          },
        },
      })
    }

    const setQuarantineForManualRetryTest = () => {
      receiver.setTestManagementTests({
        mocha: {
          suites: {
            'ci-visibility/test-impacted-test/test-impacted-1.js': {
              tests: {
                [manualRetryTestName]: {
                  properties: {
                    quarantined: true,
                  },
                },
              },
            },
          },
        },
      })
    }

    const assertAttemptToFixFailThenPass = (tests) => {
      assert.strictEqual(tests.length, 3)

      const originalAttempts = tests.filter(test => !(TEST_IS_RETRY in test.meta))
      assert.strictEqual(originalAttempts.length, 1)
      assert.strictEqual(originalAttempts[0].meta[TEST_STATUS], 'fail')
      assert.strictEqual(originalAttempts[0].meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
      assert.strictEqual(originalAttempts[0].meta[TEST_IS_MODIFIED], 'true')
      assert.ok(!(TEST_RETRY_REASON in originalAttempts[0].meta))

      const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
      assert.strictEqual(retriedTests.length, 2)
      for (const test of retriedTests) {
        assert.strictEqual(test.meta[TEST_STATUS], 'pass')
        assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
        assert.strictEqual(test.meta[TEST_IS_MODIFIED], 'true')
        assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
      }

      const finalStatusTests = tests.filter(test => TEST_FINAL_STATUS in test.meta)
      assert.strictEqual(finalStatusTests.length, 1)
      assert.strictEqual(finalStatusTests[0].meta[TEST_FINAL_STATUS], 'fail')
      assert.strictEqual(finalStatusTests[0].meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
    }

    context('test is not new', () => {
      it('should be detected as impacted', async () => {
        receiver.setSettings({ impacted_tests_enabled: true })

        await runImpactedTest({ isModified: true })
      })

      onlyLatestIt('disables manual Mocha retries for modified tests retried by EFD', async () => {
        receiver.setKnownTests({
          mocha: {
            'ci-visibility/test-impacted-test/test-impacted-1.js': [
              'impacted tests can pass normally',
              'impacted tests can fail',
              manualRetryTestName,
            ],
          },
        })
        receiver.setSettings({
          flaky_test_retries_enabled: true,
          flaky_test_retries_count: 5,
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events
              .filter(event => event.type === 'test')
              .map(event => event.content)
              .filter(test => test.meta[TEST_NAME] === manualRetryTestName)
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            assert.strictEqual(tests.length, NUM_RETRIES + 1)
            assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
            assert.strictEqual(tests[0].meta[TEST_IS_MODIFIED], 'true')
            assert.ok(!(TEST_IS_NEW in tests[0].meta))
            assert.ok(!(TEST_IS_RETRY in tests[0].meta))
            assert.ok(!(TEST_RETRY_REASON in tests[0].meta))

            const retriedTests = tests.slice(1)
            retriedTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_STATUS], 'pass')
              assert.strictEqual(test.meta[TEST_IS_MODIFIED], 'true')
              assert.ok(!(TEST_IS_NEW in test.meta))
              assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
              assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
            })

            const externalRetries = tests.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.ext
            )
            assert.strictEqual(externalRetries.length, 0)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify([
                './test-impacted-test/test-impacted-1',
              ]),
              GITHUB_BASE_REF: '',
              MOCHA_RETRIES: '2',
              SET_RETRIES_INSIDE_TEST: '1',
              SKIP_IMPACTED_NON_MANUAL_RETRY_TESTS: '1',
              SHOULD_CHECK_RESULTS: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
        assert.strictEqual(exitCode, 0)
      })

      onlyLatestIt('does not double-subtract quarantined modified tests retried by EFD', async () => {
        setQuarantineForManualRetryTest()
        receiver.setKnownTests({
          mocha: {
            'ci-visibility/test-impacted-test/test-impacted-1.js': [
              'impacted tests can pass normally',
              'impacted tests can fail',
              manualRetryTestName,
            ],
          },
        })
        receiver.setSettings({
          flaky_test_retries_enabled: false,
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
          test_management: { enabled: true },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            const tests = events
              .filter(event => event.type === 'test')
              .map(event => event.content)
              .filter(test => test.meta[TEST_NAME] === manualRetryTestName)
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
            assert.strictEqual(tests.length, NUM_RETRIES + 1)
            assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
            assert.strictEqual(tests[0].meta[TEST_IS_MODIFIED], 'true')
            assert.strictEqual(tests[0].meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            assert.ok(!(TEST_IS_NEW in tests[0].meta))
            assert.ok(!(TEST_IS_RETRY in tests[0].meta))
            assert.ok(!(TEST_RETRY_REASON in tests[0].meta))

            const retriedTests = tests.slice(1)
            retriedTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_STATUS], 'pass')
              assert.strictEqual(test.meta[TEST_IS_MODIFIED], 'true')
              assert.ok(!(TEST_IS_NEW in test.meta))
              assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
              assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
            })
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify([
                './test-impacted-test/test-impacted-1',
              ]),
              GITHUB_BASE_REF: '',
              SKIP_IMPACTED_NON_MANUAL_RETRY_TESTS: '1',
              SHOULD_CHECK_RESULTS: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
        assert.strictEqual(exitCode, 0)
      })

      onlyLatestIt('preserves passing exit status for modified tests retried by EFD in parallel mode', async () => {
        receiver.setKnownTests({
          mocha: {
            'ci-visibility/test-impacted-test/test-impacted-1.js': [
              'impacted tests can pass normally',
              'impacted tests can fail',
              manualRetryTestName,
            ],
            'ci-visibility/test-impacted-test/parallel-helper.js': [
              'impacted tests parallel helper can pass normally',
            ],
          },
        })
        receiver.setSettings({
          flaky_test_retries_enabled: true,
          flaky_test_retries_count: 5,
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha --parallel --jobs 2 --retries 2 ' +
          './ci-visibility/test-impacted-test/test-impacted-1.js ' +
          './ci-visibility/test-impacted-test/parallel-helper.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              GITHUB_BASE_REF: '',
              SET_RETRIES_INSIDE_TEST: '1',
              SKIP_IMPACTED_NON_MANUAL_RETRY_TESTS: '1',
            },
          }
        )

        const eventsPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content

              assert.strictEqual(testSession.meta[MOCHA_IS_PARALLEL], 'true')

              const tests = events
                .filter(event => event.type === 'test')
                .map(event => event.content)
                .filter(test => test.meta[TEST_NAME] === manualRetryTestName)
                .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

              assert.strictEqual(tests.length, NUM_RETRIES + 1)
              assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
              assert.strictEqual(tests[0].meta[TEST_IS_MODIFIED], 'true')
              assert.ok(!(TEST_IS_NEW in tests[0].meta))
              assert.ok(!(TEST_IS_RETRY in tests[0].meta))
              assert.ok(!(TEST_RETRY_REASON in tests[0].meta))

              const retriedTests = tests.slice(1)
              retriedTests.forEach(test => {
                assert.strictEqual(test.meta[TEST_STATUS], 'pass')
                assert.strictEqual(test.meta[TEST_IS_MODIFIED], 'true')
                assert.ok(!(TEST_IS_NEW in test.meta))
                assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
              })

              const externalRetries = tests.filter(
                test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.ext
              )
              assert.strictEqual(externalRetries.length, 0)
            },
            { hardTimeout: 60_000 }
          )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
        assert.strictEqual(exitCode, 0)
      })

      onlyLatestIt('does not suppress attempt-to-fix failures for modified tests when EFD is enabled', async () => {
        setAttemptToFixForManualRetryTest()
        receiver.setSettings({
          flaky_test_retries_enabled: false,
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES,
            },
            faulty_session_threshold: 100,
          },
          test_management: { enabled: true, attempt_to_fix_retries: 2 },
        })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify([
                './test-impacted-test/test-impacted-1',
              ]),
              GITHUB_BASE_REF: '',
              SKIP_IMPACTED_NON_MANUAL_RETRY_TESTS: '1',
              SHOULD_CHECK_RESULTS: '1',
            },
          }
        )

        await receiver.gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events
              .filter(event => event.type === 'test')
              .map(event => event.content)
              .filter(test => test.meta[TEST_NAME] === manualRetryTestName)
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            assertAttemptToFixFailThenPass(tests)
          },
          { hardTimeout: 60_000 }
        )
        assert.strictEqual(childProcess.exitCode, 1)
      })

      onlyLatestIt('does not suppress attempt-to-fix failures for modified tests in parallel mode', async () => {
        setAttemptToFixForManualRetryTest()
        receiver.setSettings({
          flaky_test_retries_enabled: false,
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES,
            },
            faulty_session_threshold: 100,
          },
          test_management: { enabled: true, attempt_to_fix_retries: 2 },
        })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha --parallel --jobs 2 ' +
          './ci-visibility/test-impacted-test/test-impacted-1.js ' +
          './ci-visibility/test-impacted-test/parallel-helper.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              GITHUB_BASE_REF: '',
              SKIP_IMPACTED_NON_MANUAL_RETRY_TESTS: '1',
            },
          }
        )

        const eventsPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content

              assert.strictEqual(testSession.meta[MOCHA_IS_PARALLEL], 'true')

              const tests = events
                .filter(event => event.type === 'test')
                .map(event => event.content)
                .filter(test => test.meta[TEST_NAME] === manualRetryTestName)
                .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

              assertAttemptToFixFailThenPass(tests)
            },
            { hardTimeout: 60_000 }
          )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
        assert.strictEqual(exitCode, 1)
      })

      it('should not be detected as impacted if disabled', async () => {
        receiver.setSettings({ impacted_tests_enabled: false })

        await runImpactedTest({ isModified: false })
      })

      it('should not be detected as impacted if DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED is false',
        async () => {
          receiver.setSettings({ impacted_tests_enabled: false })

          await runImpactedTest(
            { isModified: false },
            { DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: '0' }
          )
        })

      onlyLatestIt('should be detected as impacted in parallel mode', async () => {
        receiver.setSettings({ impacted_tests_enabled: true })

        await runImpactedTest(
          { isModified: true, isParallel: true },
          {
            // we need to run more than 1 suite for parallel mode to kick in
            TESTS_TO_RUN: JSON.stringify([
              './test-impacted-test/test-impacted-1',
              './test-impacted-test/test-impacted-2',
            ]),
            RUN_IN_PARALLEL: 'true',
          }
        )
      })

      context('test is new', () => {
        it('should be retried and marked both as new and modified', async () => {
          receiver.setKnownTests({
            mocha: {},
          })
          receiver.setSettings({
            impacted_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES,
              },
            },
            known_tests_enabled: true,
          })
          await runImpactedTest(
            { isModified: true, isEfd: true, isNew: true }
          )
        })
      })
    })
  })

  context('preserves test function on retries', () => {
    const getTestAssertions = () =>
      receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        if (supportsMochaRetryEvents) {
          assert.strictEqual(tests.length, 3)
          const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(failedTests.length, 2)
          const passedTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          assert.strictEqual(passedTests.length, 1)
          const [passedTest] = passedTests
          assert.strictEqual(passedTest.meta[TEST_IS_RETRY], 'true')
        } else {
          // there's no `retry` handled so it's just reported as a single passed test event
          // because the test ends up passing after retries
          assert.strictEqual(tests.length, 1)
          const passedTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          assert.strictEqual(passedTests.length, 1)
        }
      })

    it('respects "done" callback', async () => {
      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './mocha-retries-test-fn/mocha-done.js',
            ]),
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        getTestAssertions(),
      ])
    })
    it('respects async/await', async () => {
      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './mocha-retries-test-fn/mocha-async.js',
            ]),
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        getTestAssertions(),
      ])
    })
    it('respects promises', async () => {
      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './mocha-retries-test-fn/mocha-promise.js',
            ]),
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        getTestAssertions(),
      ])
    })
    it('respects sync functions', async () => {
      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './mocha-retries-test-fn/mocha-sync.js',
            ]),
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        getTestAssertions(),
      ])
    })
  })

  context('coverage report upload', () => {
    const gitCommitSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const gitRepositoryUrl = 'https://github.com/datadog/test-repo.git'

    it('uploads coverage report when coverage_report_upload_enabled is true', async () => {
      receiver.setSettings({
        coverage_report_upload_enabled: true,
      })

      const coverageReportPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/cicovreprt', (payloads) => {
          assert.strictEqual(payloads.length, 1)

          const coverageReport = payloads[0]

          assert.ok(
            coverageReport.headers['content-type'].includes('multipart/form-data'),
            `Got: ${inspect(coverageReport.headers['content-type'])}`
          )

          assert.strictEqual(coverageReport.coverageFile.name, 'coverage')
          assert.ok(
            coverageReport.coverageFile.content.includes('SF:'),
            `Got: ${inspect(coverageReport.coverageFile.content)}`
          ) // LCOV format

          assert.strictEqual(coverageReport.eventFile.name, 'event')
          assert.strictEqual(coverageReport.eventFile.content.type, 'coverage_report')
          assert.strictEqual(coverageReport.eventFile.content.format, 'lcov')
          assert.strictEqual(coverageReport.eventFile.content[GIT_COMMIT_SHA], gitCommitSha)
          assert.strictEqual(coverageReport.eventFile.content[GIT_REPOSITORY_URL], gitRepositoryUrl)
        })

      const runTestsWithLcovCoverageCommand = `./node_modules/nyc/bin/nyc.js -r=lcov ${runTestsCommand}`

      childProcess = exec(
        runTestsWithLcovCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_GIT_COMMIT_SHA: gitCommitSha,
            DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
          },
        }
      )

      await Promise.all([
        coverageReportPromise,
        once(childProcess, 'exit'),
      ])
    })

    it('does not upload coverage report when coverage_report_upload_enabled is false', async () => {
      receiver.setSettings({
        coverage_report_upload_enabled: false,
      })

      let coverageReportUploaded = false
      receiver.assertPayloadReceived(() => {
        coverageReportUploaded = true
      }, ({ url }) => url === '/api/v2/cicovreprt')

      const runTestsWithLcovCoverageCommand = `./node_modules/nyc/bin/nyc.js -r=lcov -r=text-summary ${runTestsCommand}`

      childProcess = exec(
        runTestsWithLcovCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_GIT_COMMIT_SHA: gitCommitSha,
            DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
          },
        }
      )

      await once(childProcess, 'exit')

      assert.strictEqual(coverageReportUploaded, false, 'coverage report should not be uploaded')
    })
  })
  context('final status tag', function () {
    it('sets final_status tag to test status on regular tests without retry features', async () => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: false,
        early_flake_detection: { enabled: false },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          tests.forEach(test => {
            assert.strictEqual(
              test.meta[TEST_FINAL_STATUS],
              test.meta[TEST_STATUS],
              `Expected TEST_FINAL_STATUS to match TEST_STATUS for test "${test.meta[TEST_NAME]}"`
            )
          })

          const skippedTest = tests.find(test => test.meta[TEST_NAME] === 'mocha-skips can report skipped tests')
          assert.ok(skippedTest, 'Expected to find the skipped test')
          assert.strictEqual(skippedTest.meta[TEST_FINAL_STATUS], 'skip')
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: JSON.stringify([
            './test/ci-visibility-test.js',
            './test/fail-test.js',
            './mocha-skips/skip-test.js',
          ]),
        },
      })

      await Promise.all([once(childProcess, 'exit'), eventsPromise])
    })

    onlyLatestIt('sets tag only on last ATR retry when EFD is enabled but not active and ATR is active', async () => {
      // All mocha-flaky tests are known, so EFD will be enabled but not active for them
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/mocha-flaky/flaky-passes.js': [
            'mocha-flaky can retry flaky tests',
            'mocha-flaky will not retry passed tests',
          ],
          'ci-visibility/mocha-hooks/flaky-passes-with-hooks.js': [
            'mocha-hooks flaky-passes can retry flaky tests',
            'mocha-hooks flaky-passes will not retry passed tests',
          ],
        },
      })
      receiver.setSettings({
        flaky_test_retries_enabled: true, // ATR enabled
        early_flake_detection: {
          enabled: true,
          slow_test_retries: { '5s': 3 },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const allTests = events
            .filter(event => event.type === 'test')
            .map(event => event.content)
          const tests = allTests.filter(test => test.meta[TEST_NAME] === 'mocha-flaky can retry flaky tests')

          // We expect 2 executions: the failed (retry) and the passed (last one)
          assert.strictEqual(tests.length, 2)

          // Only the last execution (the one with status 'pass') should have TEST_FINAL_STATUS tag
          tests.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).forEach((test, idx) => {
            if (idx < tests.length - 1) {
              assert.ok(!(TEST_FINAL_STATUS in test.meta),
                'TEST_FINAL_STATUS should not be set on previous runs'
              )
            } else {
              assert.strictEqual(test.meta[TEST_FINAL_STATUS], test.meta[TEST_STATUS])
              assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            }
          })

          // A test that passes on the first run (no retries) should have TEST_FINAL_STATUS set immediately
          const alwaysPassingTests = allTests.filter(
            test => test.meta[TEST_NAME] === 'mocha-flaky will not retry passed tests'
          )
          assert.strictEqual(alwaysPassingTests.length, 1)
          assert.strictEqual(alwaysPassingTests[0].meta[TEST_FINAL_STATUS], 'pass')

          // With hooks: same behavior — only the last execution of the flaky test should have the tag
          const testsWithHooks = allTests.filter(
            test => test.meta[TEST_NAME] === 'mocha-hooks flaky-passes can retry flaky tests'
          )
          assert.strictEqual(testsWithHooks.length, 2)
          testsWithHooks.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).forEach((test, idx) => {
            if (idx < testsWithHooks.length - 1) {
              assert.ok(!(TEST_FINAL_STATUS in test.meta),
                'TEST_FINAL_STATUS should not be set on previous runs (with hooks)'
              )
            } else {
              assert.strictEqual(test.meta[TEST_FINAL_STATUS], test.meta[TEST_STATUS])
              assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            }
          })

          const alwaysPassingTestsWithHooks = allTests.filter(
            test => test.meta[TEST_NAME] === 'mocha-hooks flaky-passes will not retry passed tests'
          )
          assert.strictEqual(alwaysPassingTestsWithHooks.length, 1)
          assert.strictEqual(alwaysPassingTestsWithHooks[0].meta[TEST_FINAL_STATUS], 'pass')
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: JSON.stringify([
            './mocha-flaky/flaky-passes.js',
            './mocha-hooks/flaky-passes-with-hooks.js',
          ]),
        },
      })

      await Promise.all([once(childProcess, 'exit'), eventsPromise])
    })

    it('sets final_status tag to test status reported to test framework on last retry (EFD active only)', async () => {
      // ci-visibility-test-2.js and new-test-with-hooks.js will be treated as new tests (not in known tests)
      const knownTestFile = 'ci-visibility/test/ci-visibility-test.js'
      const knownTestSuiteWithHooks = 'ci-visibility/mocha-hooks/known-test-with-hooks.js'
      receiver.setKnownTests({
        mocha: {
          [knownTestFile]: ['ci visibility can report tests'],
          [knownTestSuiteWithHooks]: ['mocha-hooks known can report known tests'],
        },
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: { '5s': NUM_RETRIES_EFD },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // Known tests are not retried so every execution is final
          const knownTests = tests.filter(test => test.meta[TEST_SUITE] === knownTestFile)
          knownTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
            assert.ok(!(TEST_IS_RETRY in test.meta))
            assert.strictEqual(test.meta[TEST_FINAL_STATUS], test.meta[TEST_STATUS])
          })

          // New test: only the last retry should have the tag
          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )

          newTests.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).forEach((test, index) => {
            if (index < newTests.length - 1) {
              assert.ok(!(TEST_FINAL_STATUS in test.meta))
            } else {
              // only the last execution should have the final status
              assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
            }
          })

          // Known tests with hooks: every execution is final
          const knownTestsWithHooks = tests.filter(test => test.meta[TEST_SUITE] === knownTestSuiteWithHooks)
          knownTestsWithHooks.forEach(test => {
            assert.strictEqual(test.meta[TEST_FINAL_STATUS], test.meta[TEST_STATUS])
          })

          // New test with hooks: only the last retry should have the tag
          const newTestsWithHooks = tests.filter(
            test => test.meta[TEST_SUITE] === 'ci-visibility/mocha-hooks/new-test-with-hooks.js'
          )
          newTestsWithHooks.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
            .forEach((test, index) => {
              if (index < newTestsWithHooks.length - 1) {
                assert.ok(!(TEST_FINAL_STATUS in test.meta))
              } else {
                assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
              }
            })
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: JSON.stringify([
            './test/ci-visibility-test.js',
            './test/ci-visibility-test-2.js',
            './mocha-hooks/known-test-with-hooks.js',
            './mocha-hooks/new-test-with-hooks.js',
          ]),
        },
      })

      await Promise.all([once(childProcess, 'exit'), eventsPromise])
    })

    onlyLatestIt(
      'sets final_status tag to test status reported to test framework on last retry (ATR active only)',
      async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: { enabled: false },
        })

        const assertEvents = (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const expectedTestsBySuite = new Map([
            ['ci-visibility/mocha-flaky/flaky-passes.js', 3],
            ['ci-visibility/test/ci-visibility-test.js', 1],
            ['ci-visibility/mocha-flaky/flaky-fails.js', 6],
            ['ci-visibility/mocha-hooks/flaky-passes-with-hooks.js', 3],
            ['ci-visibility/mocha-hooks/flaky-fails-with-hooks.js', 6],
          ])
          assert.strictEqual(tests.length, 19)
          for (const [suite, expectedCount] of expectedTestsBySuite) {
            assert.strictEqual(tests.filter(test => test.meta[TEST_SUITE] === suite).length, expectedCount)
          }

          // Test that eventually passes: finalStatus 'pass' only on last attempt per test name
          // These tests will pass after the second retry
          const eventuallyPassingTests = tests.filter(
            test => test.meta[TEST_SUITE] === 'ci-visibility/mocha-flaky/flaky-passes.js'
          )
          const eventuallyPassingByName = eventuallyPassingTests.reduce((acc, test) => {
            const name = test.meta[TEST_NAME]
            if (!acc[name]) acc[name] = []
            acc[name].push(test)
            return acc
          }, {}) // Object that associates name to test retries events
          Object.values(eventuallyPassingByName).forEach(testGroup => {
            testGroup.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).forEach((test, index) => {
              if (index < testGroup.length - 1) {
                assert.ok(!(TEST_FINAL_STATUS in test.meta))
              } else {
                assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
              }
            })
          })

          // Test that always passes: finalStatus 'pass' only on last attempt
          const alwaysPassingTests = tests.filter(
            test => test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          alwaysPassingTests.sort((a, b) =>
            (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).forEach((test, index) => {
            if (index < alwaysPassingTests.length - 1) {
              assert.ok(!(TEST_FINAL_STATUS in test.meta))
            } else {
              assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
            }
          })

          // Test that always fails: finalStatus 'fail' only on last attempt
          const alwaysFailingTests = tests.filter(
            test => test.meta[TEST_SUITE] === 'ci-visibility/mocha-flaky/flaky-fails.js'
          )
          alwaysFailingTests.sort((a, b) =>
            (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).forEach((test, index) => {
            if (index < alwaysFailingTests.length - 1) {
              assert.ok(!(TEST_FINAL_STATUS in test.meta))
            } else {
              assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'fail')
            }
          })

          // With hooks — test that eventually passes
          const eventuallyPassingTestsWithHooks = tests.filter(
            test => test.meta[TEST_SUITE] === 'ci-visibility/mocha-hooks/flaky-passes-with-hooks.js'
          )
          const eventuallyPassingByNameWithHooks = eventuallyPassingTestsWithHooks.reduce((acc, test) => {
            const name = test.meta[TEST_NAME]
            if (!acc[name]) acc[name] = []
            acc[name].push(test)
            return acc
          }, {})
          Object.values(eventuallyPassingByNameWithHooks).forEach(testGroup => {
            testGroup.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).forEach((test, index) => {
              if (index < testGroup.length - 1) {
                assert.ok(!(TEST_FINAL_STATUS in test.meta))
              } else {
                assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
              }
            })
          })

          // With hooks — test that always fails
          const alwaysFailingTestsWithHooks = tests.filter(
            test => test.meta[TEST_SUITE] === 'ci-visibility/mocha-hooks/flaky-fails-with-hooks.js'
          )
          const alwaysFailingByNameWithHooks = alwaysFailingTestsWithHooks.reduce((acc, test) => {
            const name = test.meta[TEST_NAME]
            if (!acc[name]) acc[name] = []
            acc[name].push(test)
            return acc
          }, {})
          Object.values(alwaysFailingByNameWithHooks).forEach(testGroup => {
            testGroup.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).forEach((test, index) => {
              if (index < testGroup.length - 1) {
                assert.ok(!(TEST_FINAL_STATUS in test.meta))
              } else {
                assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'fail')
              }
            })
          })
        }

        const payloadsPromise = receiver.gatherPayloadsMaxTimeout(
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          assertEvents
        )

        childProcess = exec(runTestsCommand, {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './mocha-flaky/flaky-passes.js',
              './test/ci-visibility-test.js',
              './mocha-flaky/flaky-fails.js',
              './mocha-hooks/flaky-passes-with-hooks.js',
              './mocha-hooks/flaky-fails-with-hooks.js',
            ]),
          },
        })

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          payloadsPromise,
        ])
        assert.strictEqual(exitCode, 0)
      })

    it('sets final_status tag to skip for disabled tests', async () => {
      receiver.setSettings({ test_management: { enabled: true } })
      receiver.setTestManagementTests({
        mocha: {
          suites: {
            'ci-visibility/test-management/test-disabled-1.js': {
              tests: {
                'disable tests can disable a test': {
                  properties: { disabled: true },
                },
              },
            },
            'ci-visibility/mocha-hooks/disabled-with-hooks.js': {
              tests: {
                'disable tests with hooks can disable a test with hooks': {
                  properties: { disabled: true },
                },
              },
            },
          },
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const disabledTest = tests.find(test => test.meta[TEST_NAME] === 'disable tests can disable a test')
          assert.ok(disabledTest)
          assert.strictEqual(disabledTest.meta[TEST_STATUS], 'skip')
          assert.strictEqual(disabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
          assert.strictEqual(disabledTest.meta[TEST_FINAL_STATUS], 'skip')

          const disabledTestWithHooks = tests.find(
            test => test.meta[TEST_NAME] === 'disable tests with hooks can disable a test with hooks'
          )
          assert.ok(disabledTestWithHooks)
          assert.strictEqual(disabledTestWithHooks.meta[TEST_STATUS], 'skip')
          assert.strictEqual(disabledTestWithHooks.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
          assert.strictEqual(disabledTestWithHooks.meta[TEST_FINAL_STATUS], 'skip')
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: JSON.stringify([
            './test-management/test-disabled-1.js',
            './mocha-hooks/disabled-with-hooks.js',
          ]),
          SHOULD_CHECK_RESULTS: '1',
        },
      })

      await Promise.all([once(childProcess, 'exit'), eventsPromise])
    })

    it('sets final_status tag to skip for quarantined tests', async () => {
      receiver.setSettings({ test_management: { enabled: true } })
      receiver.setTestManagementTests({
        mocha: {
          suites: {
            'ci-visibility/test-management/test-quarantine-1.js': {
              tests: {
                'quarantine tests can quarantine a test': {
                  properties: { quarantined: true },
                },
              },
            },
            'ci-visibility/mocha-hooks/test-quarantine-with-hooks.js': {
              tests: {
                'quarantine tests with hooks can quarantine a test with hooks': {
                  properties: { quarantined: true },
                },
              },
            },
          },
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const quarantinedTest = tests.find(test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test')
          assert.ok(quarantinedTest)

          // Quarantined tests still run and report their actual status.
          // However, the final status tag must be reported as 'skip'
          // because test errors are supressed
          assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
          assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
          assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')

          const passingTest = tests.find(test => test.meta[TEST_NAME] === 'quarantine tests can pass normally')
          assert.ok(passingTest)
          assert.strictEqual(passingTest.meta[TEST_STATUS], 'pass')
          assert.strictEqual(passingTest.meta[TEST_FINAL_STATUS], 'pass')

          const quarantinedTestWithHooks = tests.find(
            test => test.meta[TEST_NAME] === 'quarantine tests with hooks can quarantine a test with hooks'
          )
          assert.ok(quarantinedTestWithHooks)
          assert.strictEqual(quarantinedTestWithHooks.meta[TEST_STATUS], 'fail')
          assert.strictEqual(quarantinedTestWithHooks.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
          assert.strictEqual(quarantinedTestWithHooks.meta[TEST_FINAL_STATUS], 'skip')

          const passingTestWithHooks = tests.find(
            test => test.meta[TEST_NAME] === 'quarantine tests with hooks can pass normally with hooks'
          )
          assert.ok(passingTestWithHooks)
          assert.strictEqual(passingTestWithHooks.meta[TEST_STATUS], 'pass')
          assert.strictEqual(passingTestWithHooks.meta[TEST_FINAL_STATUS], 'pass')
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: JSON.stringify([
            './test-management/test-quarantine-1.js',
            './mocha-hooks/test-quarantine-with-hooks.js',
          ]),
          SHOULD_CHECK_RESULTS: '1',
        },
      })

      await Promise.all([once(childProcess, 'exit'), eventsPromise])
    })

    it('sets final_status tag to skip for quarantined tests when hook throws', async () => {
      receiver.setSettings({ test_management: { enabled: true } })
      receiver.setTestManagementTests({
        mocha: {
          suites: {
            'ci-visibility/mocha-hooks/test-quarantine-with-failing-after-each.js': {
              tests: {
                'quarantine tests with failing afterEach can quarantine a test whose afterEach hook fails': {
                  properties: { quarantined: true },
                },
              },
            },
          },
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const quarantinedTest = tests.find(
            test => test.meta[TEST_NAME] ===
              'quarantine tests with failing afterEach can quarantine a test whose afterEach hook fails'
          )
          assert.ok(quarantinedTest)
          assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
          assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
          assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: JSON.stringify(['./mocha-hooks/test-quarantine-with-failing-after-each.js']),
        },
      })
      await Promise.all([once(childProcess, 'exit'), eventsPromise])
    })
  })
})
