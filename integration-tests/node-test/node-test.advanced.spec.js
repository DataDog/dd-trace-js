'use strict'

const assert = require('node:assert/strict')
const { exec, execSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { assertObjectContains } = require('../helpers')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_FINAL_STATUS,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_IS_MODIFIED,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_NAME,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')

describe('node:test advanced features', () => {
  let cwd
  let receiver
  let childProcess

  useSandbox([], true)

  before(function () {
    cwd = sandboxCwd()
  })

  beforeEach(async function () {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess?.kill()
    await receiver.stop()
  })

  function getEvents (payloads) {
    return payloads.flatMap(({ payload }) => payload.events)
  }

  function getTests (events) {
    return events.filter(event => event.type === 'test').map(event => event.content)
  }

  function assertHookAttemptCounts (tests) {
    tests.forEach((test, index) => {
      const expectedCount = String(index + 1)
      assert.strictEqual(test.meta['test.before_each_count'], expectedCount)
      assert.strictEqual(test.meta['test.after_each_count'], expectedCount)
    })
  }

  context('auto test retries', () => {
    it('retries failing tests and tags retry attempts', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        early_flake_detection: { enabled: false },
        known_tests_enabled: false,
        test_management: { enabled: false },
        impacted_tests_enabled: false,
      })

      const eventsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
            'flaky test retries > can retry tests that eventually pass',
            'flaky test retries > can retry tests that never pass',
            'flaky test retries > does not retry if unnecessary',
          ])

          const eventuallyPasses = tests
            .filter(test => test.meta[TEST_NAME] === 'flaky test retries > can retry tests that eventually pass')
            .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0)
          assert.strictEqual(eventuallyPasses.length, 3)
          assertHookAttemptCounts(eventuallyPasses)
          assert.strictEqual(eventuallyPasses[0].meta[TEST_STATUS], 'fail')
          assert.ok(!(TEST_FINAL_STATUS in eventuallyPasses[0].meta))
          assert.strictEqual(eventuallyPasses[1].meta[TEST_STATUS], 'fail')
          assert.strictEqual(eventuallyPasses[1].meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(eventuallyPasses[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
          assert.ok(!(TEST_FINAL_STATUS in eventuallyPasses[1].meta))
          assert.strictEqual(eventuallyPasses[2].meta[TEST_STATUS], 'pass')
          assert.strictEqual(eventuallyPasses[2].meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(eventuallyPasses[2].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
          assert.strictEqual(eventuallyPasses[2].meta[TEST_FINAL_STATUS], 'pass')

          const neverPasses = tests
            .filter(test => test.meta[TEST_NAME] === 'flaky test retries > can retry tests that never pass')
            .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0)
          assert.strictEqual(neverPasses.length, 6)
          assertHookAttemptCounts(neverPasses)
          neverPasses.slice(1).forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
          })
          assert.strictEqual(neverPasses.at(-1).meta[TEST_STATUS], 'fail')
          assert.strictEqual(neverPasses.at(-1).meta[TEST_FINAL_STATUS], 'fail')
          assert.strictEqual(neverPasses.at(-1).meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')

          const passing = tests.filter(
            test => test.meta[TEST_NAME] === 'flaky test retries > does not retry if unnecessary'
          )
          assert.strictEqual(passing.length, 1)
          assertHookAttemptCounts(passing)
          assert.strictEqual(passing[0].meta[TEST_STATUS], 'pass')
          assert.strictEqual(passing[0].meta[TEST_FINAL_STATUS], 'pass')
          assert.ok(!(TEST_IS_RETRY in passing[0].meta))
        }
      )

      childProcess = exec(
        'node --test ci-visibility/node-test-tests/flaky-test-retries.cjs',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '5',
          },
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 1)
    })

    it('does not retry when auto test retries are disabled by environment', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        early_flake_detection: { enabled: false },
        known_tests_enabled: false,
        test_management: { enabled: false },
        impacted_tests_enabled: false,
      })

      const eventsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const tests = getTests(getEvents(payloads))

          assert.strictEqual(tests.length, 3)
          for (const test of tests) {
            assert.ok(!(TEST_IS_RETRY in test.meta))
            assert.ok(!(TEST_RETRY_REASON in test.meta))
          }

          const eventuallyPasses = tests.find(
            test => test.meta[TEST_NAME] === 'flaky test retries > can retry tests that eventually pass'
          )
          assert.strictEqual(eventuallyPasses.meta[TEST_STATUS], 'fail')
          assert.strictEqual(eventuallyPasses.meta[TEST_FINAL_STATUS], 'fail')
        }
      )

      childProcess = exec(
        'node --test ci-visibility/node-test-tests/flaky-test-retries.cjs',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false',
          },
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 1)
    })
  })

  context('early flake detection', () => {
    it('retries new tests and suppresses intermittent failures', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: false,
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 2,
          },
        },
        known_tests_enabled: true,
        test_management: { enabled: false },
        impacted_tests_enabled: false,
      })
      receiver.setKnownTests({
        'node-test': {
          'ci-visibility/node-test-tests/early-flake-detection.cjs': [
            'early flake detection > does not retry known tests',
          ],
        },
      })

      const eventsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const retried = tests.filter(test => {
            return test.meta[TEST_NAME] === 'early flake detection > retries new tests with intermittent failures'
          })
            .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0)
          assert.strictEqual(retried.length, 3)
          assertHookAttemptCounts(retried)
          retried.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          assert.strictEqual(retried[0].meta[TEST_STATUS], 'fail')
          assert.ok(!(TEST_FINAL_STATUS in retried[0].meta))
          assert.strictEqual(retried[1].meta[TEST_STATUS], 'pass')
          assert.strictEqual(retried[1].meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(retried[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          assert.ok(!(TEST_FINAL_STATUS in retried[1].meta))
          assert.strictEqual(retried[2].meta[TEST_STATUS], 'pass')
          assert.strictEqual(retried[2].meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(retried[2].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          assert.strictEqual(retried[2].meta[TEST_FINAL_STATUS], 'pass')

          const known = tests.filter(
            test => test.meta[TEST_NAME] === 'early flake detection > does not retry known tests'
          )
          assert.strictEqual(known.length, 1)
          assertHookAttemptCounts(known)
          assert.ok(!(TEST_IS_NEW in known[0].meta))
          assert.ok(!(TEST_IS_RETRY in known[0].meta))

          const testSessionEvent = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testSessionEvent.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
        }
      )

      childProcess = exec(
        'node --test ci-visibility/node-test-tests/early-flake-detection.cjs',
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 0)
    })

    it('does not retry new tests if the known tests request fails', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: false,
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 2,
          },
        },
        known_tests_enabled: true,
        test_management: { enabled: false },
        impacted_tests_enabled: false,
      })
      receiver.setKnownTestsResponseCode(500)
      receiver.setKnownTests({
        'node-test': {
          'ci-visibility/node-test-tests/early-flake-detection.cjs': [
            'early flake detection > does not retry known tests',
          ],
        },
      })

      const eventsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = getEvents(payloads)
          const tests = getTests(events)
          const retried = tests.filter(test => {
            return test.meta[TEST_NAME] === 'early flake detection > retries new tests with intermittent failures'
          })

          assert.strictEqual(retried.length, 1)
          assert.strictEqual(retried[0].meta[TEST_STATUS], 'fail')
          assert.strictEqual(retried[0].meta[TEST_FINAL_STATUS], 'fail')
          assert.ok(!(TEST_IS_NEW in retried[0].meta))
          assert.ok(!(TEST_IS_RETRY in retried[0].meta))

          const testSessionEvent = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
          assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSessionEvent.meta))
        }
      )

      childProcess = exec(
        'node --test ci-visibility/node-test-tests/early-flake-detection.cjs',
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 1)
    })

    it('does not retry parent tests that create subtests', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: false,
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 2,
          },
        },
        known_tests_enabled: true,
        test_management: { enabled: false },
        impacted_tests_enabled: false,
      })
      receiver.setKnownTests({
        'node-test': {
          'ci-visibility/node-test-tests/early-flake-detection-subtests.cjs': [],
        },
      })

      const parentName = 'early flake detection subtests > does not retry parent tests that create subtests'
      const childName = `${parentName} > retries child subtests`
      const eventsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = getEvents(payloads)
          const tests = getTests(events)
          const parentAttempts = tests.filter(test => test.meta[TEST_NAME] === parentName)
          const childAttempts = tests
            .filter(test => test.meta[TEST_NAME] === childName)
            .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0)

          assert.strictEqual(parentAttempts.length, 1)
          assert.strictEqual(parentAttempts[0].meta[TEST_IS_NEW], 'true')
          assert.strictEqual(parentAttempts[0].meta[TEST_STATUS], 'pass')
          assert.strictEqual(parentAttempts[0].meta[TEST_FINAL_STATUS], 'pass')
          assert.strictEqual(parentAttempts[0].meta['test.parent_attempt'], '1')
          assert.ok(!(TEST_IS_RETRY in parentAttempts[0].meta))

          assert.strictEqual(childAttempts.length, 3)
          assert.strictEqual(childAttempts[0].meta[TEST_STATUS], 'fail')
          assert.strictEqual(childAttempts[0].meta['test.child_attempt'], '1')
          assert.ok(!(TEST_FINAL_STATUS in childAttempts[0].meta))
          childAttempts.slice(1).forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
            assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          })
          assert.strictEqual(childAttempts[1].meta[TEST_STATUS], 'pass')
          assert.strictEqual(childAttempts[1].meta['test.child_attempt'], '2')
          assert.ok(!(TEST_FINAL_STATUS in childAttempts[1].meta))
          assert.strictEqual(childAttempts[2].meta[TEST_STATUS], 'pass')
          assert.strictEqual(childAttempts[2].meta['test.child_attempt'], '3')
          assert.strictEqual(childAttempts[2].meta[TEST_FINAL_STATUS], 'pass')
        }
      )

      childProcess = exec(
        'node --test ci-visibility/node-test-tests/early-flake-detection-subtests.cjs',
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 0)
    })
  })

  context('test management', () => {
    it('disables and quarantines managed tests', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: false,
        early_flake_detection: { enabled: false },
        known_tests_enabled: false,
        test_management: { enabled: true },
        impacted_tests_enabled: false,
      })
      receiver.setTestManagementTests({
        'node-test': {
          suites: {
            'ci-visibility/node-test-tests/test-management.cjs': {
              tests: {
                'test management > can disable tests': {
                  properties: {
                    disabled: true,
                  },
                },
                'test management > can quarantine tests': {
                  properties: {
                    quarantined: true,
                  },
                },
              },
            },
          },
        },
      })

      const eventsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const disabled = tests.find(test => test.meta[TEST_NAME] === 'test management > can disable tests')
          assert.strictEqual(disabled.meta[TEST_STATUS], 'skip')
          assert.strictEqual(disabled.meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(disabled.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')

          const quarantined = tests.find(test => test.meta[TEST_NAME] === 'test management > can quarantine tests')
          assert.strictEqual(quarantined.meta[TEST_STATUS], 'fail')
          assert.strictEqual(quarantined.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
          assert.strictEqual(quarantined.meta[TEST_FINAL_STATUS], 'skip')

          const normal = tests.find(test => test.meta[TEST_NAME] === 'test management > passes normally')
          assert.strictEqual(normal.meta[TEST_STATUS], 'pass')
          assert.ok(!(TEST_MANAGEMENT_IS_DISABLED in normal.meta))
          assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in normal.meta))

          const testSessionEvent = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testSessionEvent.meta[TEST_MANAGEMENT_ENABLED], 'true')
        }
      )

      childProcess = exec(
        'node --test ci-visibility/node-test-tests/test-management.cjs',
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 0)
    })

    it('does not apply managed test properties if the test-management request fails', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: false,
        early_flake_detection: { enabled: false },
        known_tests_enabled: false,
        test_management: { enabled: true },
        impacted_tests_enabled: false,
      })
      receiver.setTestManagementTestsResponseCode(500)
      receiver.setTestManagementTests({
        'node-test': {
          suites: {
            'ci-visibility/node-test-tests/test-management.cjs': {
              tests: {
                'test management > can disable tests': {
                  properties: {
                    disabled: true,
                  },
                },
              },
            },
          },
        },
      })

      const eventsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = getEvents(payloads)
          const tests = getTests(events)

          const disabled = tests.find(test => test.meta[TEST_NAME] === 'test management > can disable tests')
          assert.strictEqual(disabled.meta[TEST_STATUS], 'fail')
          assert.strictEqual(disabled.meta[TEST_FINAL_STATUS], 'fail')
          assert.ok(!(TEST_MANAGEMENT_IS_DISABLED in disabled.meta))

          const testSessionEvent = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
          assert.ok(!(TEST_MANAGEMENT_ENABLED in testSessionEvent.meta))
        }
      )

      childProcess = exec(
        'node --test ci-visibility/node-test-tests/test-management.cjs',
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 1)
    })

    it('retries attempt-to-fix tests and tags the final outcome', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: false,
        early_flake_detection: { enabled: false },
        known_tests_enabled: false,
        test_management: {
          enabled: true,
          attempt_to_fix_retries: 2,
        },
        impacted_tests_enabled: false,
      })
      receiver.setTestManagementTests({
        'node-test': {
          suites: {
            'ci-visibility/node-test-tests/attempt-to-fix.cjs': {
              tests: {
                'attempt to fix > can attempt to fix passing tests': {
                  properties: {
                    attempt_to_fix: true,
                  },
                },
                'attempt to fix > can attempt to fix failing tests': {
                  properties: {
                    attempt_to_fix: true,
                  },
                },
                'attempt to fix > can attempt to fix disabled tests': {
                  properties: {
                    attempt_to_fix: true,
                    disabled: true,
                  },
                },
                'attempt to fix > can attempt to fix quarantined failing tests': {
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

      const eventsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const passing = tests
            .filter(test => test.meta[TEST_NAME] === 'attempt to fix > can attempt to fix passing tests')
            .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0)
          assert.strictEqual(passing.length, 3)
          passing.forEach(test => {
            assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
          })
          assert.ok(!(TEST_IS_RETRY in passing[0].meta))
          assert.ok(!(TEST_FINAL_STATUS in passing[0].meta))
          assert.strictEqual(passing[1].meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(passing[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
          assert.ok(!(TEST_FINAL_STATUS in passing[1].meta))
          assert.strictEqual(passing[2].meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(passing[2].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
          assert.strictEqual(passing[2].meta[TEST_FINAL_STATUS], 'pass')
          assert.strictEqual(passing[2].meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')

          const failing = tests
            .filter(test => test.meta[TEST_NAME] === 'attempt to fix > can attempt to fix failing tests')
            .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0)
          assert.strictEqual(failing.length, 3)
          failing.forEach(test => {
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
          })
          assert.ok(!(TEST_FINAL_STATUS in failing[0].meta))
          assert.strictEqual(failing[1].meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(failing[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
          assert.ok(!(TEST_FINAL_STATUS in failing[1].meta))
          assert.strictEqual(failing[2].meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(failing[2].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
          assert.strictEqual(failing[2].meta[TEST_FINAL_STATUS], 'fail')
          assert.strictEqual(failing[2].meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
          assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in failing[2].meta))

          const disabled = tests
            .filter(test => test.meta[TEST_NAME] === 'attempt to fix > can attempt to fix disabled tests')
            .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0)
          assert.strictEqual(disabled.length, 3)
          disabled.forEach(test => {
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
            assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
          })
          assert.strictEqual(disabled[2].meta[TEST_FINAL_STATUS], 'pass')
          assert.strictEqual(disabled[2].meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')

          const quarantined = tests
            .filter(test => test.meta[TEST_NAME] === 'attempt to fix > can attempt to fix quarantined failing tests')
            .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0)
          assert.strictEqual(quarantined.length, 3)
          quarantined.forEach(test => {
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
            assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
          })
          assert.strictEqual(quarantined[2].meta[TEST_FINAL_STATUS], 'fail')
          assert.strictEqual(quarantined[2].meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')

          const testSessionEvent = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
          assert.strictEqual(testSessionEvent.meta[TEST_MANAGEMENT_ENABLED], 'true')
        }
      )

      childProcess = exec(
        'node --test ci-visibility/node-test-tests/attempt-to-fix.cjs',
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 1)
    })

    it('applies disabled and quarantine behavior to tests with hooks', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: false,
        early_flake_detection: { enabled: false },
        known_tests_enabled: false,
        test_management: { enabled: true },
        impacted_tests_enabled: false,
      })
      receiver.setTestManagementTests({
        'node-test': {
          suites: {
            'ci-visibility/node-test-tests/hooks-test-management.cjs': {
              tests: {
                'node test management with hooks > can disable a failing test with hooks': {
                  properties: {
                    disabled: true,
                  },
                },
                'node test management with hooks > can quarantine a failing test with hooks': {
                  properties: {
                    quarantined: true,
                  },
                },
                'node test management with hooks > can quarantine a test whose afterEach hook fails': {
                  properties: {
                    quarantined: true,
                  },
                },
              },
            },
          },
        },
      })

      const eventsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = getEvents(payloads)
          const tests = getTests(events)

          const disabled = tests.find(
            test => test.meta[TEST_NAME] === (
              'node test management with hooks > can disable a failing test with hooks'
            )
          )
          assert.strictEqual(disabled.meta[TEST_STATUS], 'skip')
          assert.strictEqual(disabled.meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(disabled.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
          assert.ok(!(disabled.meta['test.before_each']))

          const quarantined = tests.find(
            test => test.meta[TEST_NAME] === (
              'node test management with hooks > can quarantine a failing test with hooks'
            )
          )
          assert.strictEqual(quarantined.meta[TEST_STATUS], 'fail')
          assert.strictEqual(quarantined.meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(quarantined.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

          const quarantinedAfterEach = tests.find(
            test => test.meta[TEST_NAME] === (
              'node test management with hooks > can quarantine a test whose afterEach hook fails'
            )
          )
          assert.strictEqual(quarantinedAfterEach.meta[TEST_STATUS], 'fail')
          assert.strictEqual(quarantinedAfterEach.meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(quarantinedAfterEach.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

          const testSessionEvent = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testSessionEvent.meta[TEST_MANAGEMENT_ENABLED], 'true')
        }
      )

      childProcess = exec(
        'node --test ci-visibility/node-test-tests/hooks-test-management.cjs',
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 0)
    })
  })

  context('impacted tests', () => {
    before(() => {
      execSync('git checkout -B node-test-feature-branch', { cwd, stdio: 'ignore' })
      fs.writeFileSync(
        path.join(cwd, 'ci-visibility/node-test-tests/impacted-test.cjs'),
        `'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

describe('impacted test', () => {
  it('can mark impacted tests', () => {
    assert.strictEqual(2 + 2, 4)
  })
})
`
      )
      execSync('git add ci-visibility/node-test-tests/impacted-test.cjs', { cwd, stdio: 'ignore' })
      execSync('git commit -m "modify node-test impacted test"', { cwd, stdio: 'ignore' })
    })

    after(() => {
      execSync('git checkout -', { cwd, stdio: 'ignore' })
      execSync('git branch -D node-test-feature-branch', { cwd, stdio: 'ignore' })
    })

    it('marks tests from modified files as impacted', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: false,
        early_flake_detection: { enabled: false },
        known_tests_enabled: false,
        test_management: { enabled: false },
        impacted_tests_enabled: true,
      })

      const eventsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const impacted = tests.find(test => test.meta[TEST_NAME] === 'impacted test > can mark impacted tests')

          assert.strictEqual(impacted.meta[TEST_STATUS], 'pass')
          assert.strictEqual(impacted.meta[TEST_IS_MODIFIED], 'true')
          assert.ok(!(TEST_IS_NEW in impacted.meta))
        }
      )

      childProcess = exec(
        'node --test ci-visibility/node-test-tests/impacted-test.cjs',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            GITHUB_BASE_REF: '',
          },
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 0)
    })

    it('marks modified new tests and applies early flake detection', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: false,
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 2,
          },
        },
        known_tests_enabled: true,
        test_management: { enabled: false },
        impacted_tests_enabled: true,
      })
      receiver.setKnownTests({
        'node-test': {},
      })

      const eventsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const impacted = events
            .filter(event => event.type === 'test')
            .map(event => event.content)
            .filter(test => test.meta[TEST_NAME] === 'impacted test > can mark impacted tests')
            .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0)

          assert.strictEqual(impacted.length, 3)
          impacted.forEach(test => {
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            assert.strictEqual(test.meta[TEST_IS_MODIFIED], 'true')
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          assert.ok(!(TEST_IS_RETRY in impacted[0].meta))
          assert.strictEqual(impacted[1].meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(impacted[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          assert.strictEqual(impacted[2].meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(impacted[2].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          assert.strictEqual(impacted[2].meta[TEST_FINAL_STATUS], 'pass')

          const testSessionEvent = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSessionEvent.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
        }
      )

      childProcess = exec(
        'node --test ci-visibility/node-test-tests/impacted-test.cjs',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            GITHUB_BASE_REF: '',
          },
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 0)
    })
  })
})
