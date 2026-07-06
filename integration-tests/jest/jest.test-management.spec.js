'use strict'

const assert = require('node:assert/strict')

const { once } = require('node:events')
const { exec, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { inspect } = require('node:util')
const { assertObjectContains } = require('../helpers')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_SUITE,
  TEST_STATUS,
  TEST_SOURCE_FILE,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_NAME,
  TEST_RETRY_REASON,
  TEST_SESSION_NAME,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
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
  TEST_IS_MODIFIED,
  TEST_RETRY_REASON_TYPES,
  DD_CAPABILITIES_IMPACTED_TESTS,
  TEST_FINAL_STATUS,
  GIT_COMMIT_SHA,
  GIT_REPOSITORY_URL,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { TELEMETRY_COVERAGE_UPLOAD } = require('../../packages/dd-trace/src/ci-visibility/telemetry')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')
const { DD_MAJOR } = require('../../version')

const runTestsCommand = 'node ./ci-visibility/run-jest.js'

const requestedJestVersion = process.env.JEST_VERSION || 'latest'
const oldestJestVersion = DD_MAJOR >= 6 ? '28.0.0' : '24.8.0'
const JEST_VERSION = requestedJestVersion === 'oldest' ? oldestJestVersion : requestedJestVersion
const onlyLatestIt = JEST_VERSION === 'latest' ? it : it.skip
const shouldInstallJestEnvironmentJsdom = JEST_VERSION === 'latest' || Number(JEST_VERSION.split('.')[0]) >= 28

// TODO: add ESM tests
describe(`jest@${JEST_VERSION} commonJS`, () => {
  let receiver
  let childProcess
  let cwd
  useSandbox([
    `jest@${JEST_VERSION}`,
    `jest-jasmine2@${JEST_VERSION}`,
    `babel-jest@${JEST_VERSION}`,
    // jest-environment-jsdom is included in older versions of jest
    shouldInstallJestEnvironmentJsdom ? `jest-environment-jsdom@${JEST_VERSION}` : '',
    // jest-circus is not included in older versions of jest
    JEST_VERSION !== 'latest' ? `jest-circus@${JEST_VERSION}` : '',
    '@babel/core',
    '@babel/preset-typescript',
    '@happy-dom/jest-environment',
    'office-addin-mock',
    'winston',
    'jest-image-snapshot',
  ].filter(Boolean), true)

  before(function () {
    cwd = sandboxCwd()
  })

  beforeEach(async function () {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess.kill()
    await receiver.stop()
  })

  context('lage', () => {
    it('uses the Lage package name as the test session name', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: false,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)
          metadataDicts.forEach(metadata => {
            assert.strictEqual(metadata.test_levels[TEST_SESSION_NAME], 'my-lage-package')
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            DD_ENABLE_LAGE_PACKAGE_NAME: 'true',
            LAGE_PACKAGE_NAME: 'my-lage-package',
            TESTS_TO_RUN: 'test/ci-visibility-test',
          },
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      assert.strictEqual(exitCode, 0)
    })

    it('updates the test session name across repeated jest.runCLI calls in the same process', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
          'ci-visibility/test/ci-visibility-test-2.js': ['ci visibility 2 can report tests 2'],
        },
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: false,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

          assert.ok(
            metadataDicts.some(metadata => metadata.test_levels?.[TEST_SESSION_NAME] === 'my-lage-package-a'),
            `Got: ${inspect(metadataDicts)}`
          )
          assert.ok(
            metadataDicts.some(metadata => metadata.test_levels?.[TEST_SESSION_NAME] === 'my-lage-package-b'),
            `Got: ${inspect(metadataDicts)}`
          )
        })

      childProcess = exec(
        'node ./ci-visibility/run-jest-lage-multi.js',
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            DD_ENABLE_LAGE_PACKAGE_NAME: 'true',
            LAGE_PACKAGE_NAME: 'my-initial-lage-package',
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
          ...getCiVisEvpProxyConfig(receiver.port),
          TESTS_TO_RUN: 'test/ci-visibility-test',
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
          jest: {
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
        isParallel,
        isQuarantined,
        isDisabled,
        shouldAlwaysPass,
        shouldFailSometimes,
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

            if (isParallel) {
              // Parallel mode in jest requires more than a single test suite
              // Here we check that the second test suite is actually running,
              // so we can be sure that parallel mode is on
              const parallelTestName = 'ci-visibility/test-management/test-attempt-to-fix-2.js.' +
                'attempt to fix tests 2 can attempt to fix a test'
              assertObjectContains(resourceNames, [parallelTestName])
            }

            const retriedTests = tests.filter(
              test => test.meta[TEST_NAME] === 'attempt to fix tests can attempt to fix a test'
            )

            for (let i = 0; i < retriedTests.length; i++) {
              const test = retriedTests[i]
              if (!isAttemptToFix) {
                assert.ok(!(TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX in test.meta))
                assert.ok(!(TEST_IS_RETRY in test.meta))
                assert.ok(!(TEST_RETRY_REASON in test.meta))
                continue
              }

              if (isQuarantined) {
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              }

              if (isDisabled) {
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
              }

              const isFirstAttempt = i === 0
              const isLastAttempt = i === retriedTests.length - 1
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')

              if (isFirstAttempt) {
                assert.ok(!(TEST_IS_RETRY in test.meta))
                assert.ok(!(TEST_RETRY_REASON in test.meta))
              } else {
                assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
              }

              if (isLastAttempt) {
                if (shouldAlwaysPass) {
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
                  assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
                } else if (shouldFailSometimes) {
                  assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                  assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'fail')
                } else {
                  assert.strictEqual(test.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                  assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'fail')
                }
              } else {
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
       *   extraEnvVars?: Record<string, string>,
       *   isParallel?: boolean
       * }} [options]
       */
      const runAttemptToFixTest = (done, {
        isAttemptToFix,
        isQuarantined,
        isDisabled,
        shouldAlwaysPass,
        shouldFailSometimes,
        extraEnvVars = {},
        isParallel = false,
      } = {}) => {
        let stdout = ''
        const testAssertionsPromise = getTestAssertions({
          isAttemptToFix,
          isParallel,
          isQuarantined,
          isDisabled,
          shouldAlwaysPass,
          shouldFailSometimes,
        })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-attempt-to-fix-1',
              SHOULD_CHECK_RESULTS: '1',
              ...(shouldAlwaysPass ? { SHOULD_ALWAYS_PASS: '1' } : {}),
              ...(shouldFailSometimes ? { SHOULD_FAIL_SOMETIMES: '1' } : {}),
              ...extraEnvVars,
            },
          }
        )

        childProcess.stderr?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        childProcess.stdout?.on('data', (chunk) => {
          stdout += chunk.toString()
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
                assert.match(stdout, /Attempt to fix passed: all 4 execution\(s\) passed for 1 test\(s\)\./)
              } else {
                const numFailedExecutions = shouldFailSometimes ? 2 : 4
                assert.match(
                  stdout,
                  new RegExp(
                    `Attempt to fix failed: ${numFailedExecutions} of 4 execution\\(s\\) failed ` +
                    'across 1 of 1 test\\(s\\)\\.'
                  )
                )
                assert.doesNotMatch(stdout, /execution(?:s)? [\d, -]+:/)
              }
              if (isQuarantined || isDisabled) {
                assert.doesNotMatch(stdout, /Errors are suppressed because this test is/)
                assert.doesNotMatch(stdout, /test failure\(s\) were ignored/)
              }
              if (isQuarantined) {
                assert.match(
                  stdout,
                  /Test was marked as quarantined but was not quarantined because it is attempt to fix\./
                )
              }
              if (isDisabled) {
                assert.match(stdout, /Test was marked as disabled but was run because it is attempt to fix\./)
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

      it('can attempt to fix and mark last attempt as failed if every attempt fails', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done, { isAttemptToFix: true })
      })

      it('can attempt to fix when a custom environment returns an async add_test result', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done, {
          isAttemptToFix: true,
          extraEnvVars: {
            CUSTOM_TEST_ENVIRONMENT: './ci-visibility/jestEnvironmentAsyncAddTest.js',
          },
        })
      })

      it('can attempt to fix and mark last attempt as passed if every attempt passes', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done, { isAttemptToFix: true, shouldAlwaysPass: true })
      })

      it('can attempt to fix and not mark last attempt if attempts both pass and fail', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done, { isAttemptToFix: true, shouldFailSometimes: true })
      })

      it('does not attempt to fix tests if test management is not enabled', (done) => {
        receiver.setSettings({ test_management: { enabled: false, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done)
      })

      it('does not enable attempt to fix tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done, { extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } })
      })

      it('attempt to fix takes precedence over ATR', async () => {
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: 2 },
          flaky_test_retries_enabled: true,
        })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/jest-flaky/flaky-fails.js': {
                tests: {
                  'test-flaky-test-retries can retry failed tests': {
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
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 3)
            const atfRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atf)
            const atrRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)
            assert.strictEqual(atfRetries.length, 2)
            assert.strictEqual(atrRetries.length, 0)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'jest-flaky/flaky-fails.js',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('preserves test errors when ATR retry suppression is active due to attempt to fix', async () => {
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: 2 },
          flaky_test_retries_enabled: true,
        })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/jest-flaky/flaky-fails.js': {
                tests: {
                  'test-flaky-test-retries can retry failed tests': {
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
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')

            // Verify that all failing tests have error messages preserved
            // even though ATR retry suppression is active (due to attempt to fix)
            failingTests.forEach(test => {
              assert.ok(
                ERROR_MESSAGE in test.meta,
                'Test error message should be preserved when ATR retry suppression is active due to attempt to fix'
              )
              assert.ok(test.meta[ERROR_MESSAGE].length > 0, 'Test error message should not be empty')
              // The error should contain information about the assertion failure
              assert.match(test.meta[ERROR_MESSAGE], /deepStrictEqual|Expected|actual/i)
            })

            // Verify attempt to fix is active (ATR should be suppressed)
            const atfRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atf)
            const atrRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)
            assert.strictEqual(atfRetries.length, 2)
            assert.strictEqual(atrRetries.length, 0)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'jest-flaky/flaky-fails.js',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('attempt to fix takes precedence over EFD for new tests', async () => {
        const NUM_RETRIES_EFD = 2
        receiver.setKnownTests({ jest: {} })
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: 2 },
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/jest-flaky/flaky-fails.js': {
                tests: {
                  'test-flaky-test-retries can retry failed tests': {
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
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 3)
            const atfRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atf)
            const efdRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd)
            assert.strictEqual(atfRetries.length, 2)
            assert.strictEqual(efdRetries.length, 0)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'jest-flaky/flaky-fails.js',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('does not tag known attempt to fix tests as new', async () => {
        receiver.setKnownTests({
          jest: {
            'ci-visibility/jest-flaky/flaky-fails.js': [
              'test-flaky-test-retries can retry failed tests',
            ],
          },
        })
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: 2 },
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 2,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/jest-flaky/flaky-fails.js': {
                tests: {
                  'test-flaky-test-retries can retry failed tests': {
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
              TESTS_TO_RUN: 'jest-flaky/flaky-fails.js',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('resets mock state between attempt to fix retries', async () => {
        const NUM_RETRIES = 3
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: NUM_RETRIES } })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-attempt-to-fix-with-mock.js': {
                tests: {
                  'attempt to fix tests with mock resets mock state between retries': {
                    properties: {
                      attempt_to_fix: true,
                    },
                  },
                },
              },
            },
          },
        })

        let stdout = ''
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // Should have 1 original + NUM_RETRIES retry attempts
            const mockTests = tests.filter(
              test => test.meta[TEST_NAME] === 'attempt to fix tests with mock resets mock state between retries'
            )
            assert.strictEqual(mockTests.length, NUM_RETRIES + 1)

            // All tests should pass because mock state is reset between retries
            for (const test of mockTests) {
              assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            }

            // Last attempt should be marked as attempt_to_fix_passed
            const lastTest = mockTests[mockTests.length - 1]
            assert.strictEqual(lastTest.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-attempt-to-fix-with-mock',
            },
          }
        )

        childProcess.stdout?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        childProcess.stderr?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        const [exitCode] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])

        // Verify the test actually ran
        assert.match(stdout, /I am running attempt to fix with mock/)

        // All retries should pass, so exit code should be 0
        assert.strictEqual(exitCode[0], 0)
      })

      it('ignores quarantine when attempting to fix a test', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
        receiver.setTestManagementTests({
          jest: {
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

      it('ignores disabled when attempting to fix a test', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
        receiver.setTestManagementTests({
          jest: {
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

      onlyLatestIt('works with snapshot tests', async () => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-snapshot-attempt-to-fix-1.js': {
                tests: {
                  'attempt to fix snapshot is flaky': {
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
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')

            assert.strictEqual(tests.length, 4)
            const retriedTests = tests.filter(
              test => test.meta[TEST_IS_RETRY] === 'true'
            )

            assert.strictEqual(retriedTests.length, 3)
            const failedTests = tests.filter(
              test => test.meta[TEST_STATUS] === 'fail'
            )
            assert.strictEqual(failedTests.length, 2)

            const passedTests = tests.filter(
              test => test.meta[TEST_STATUS] === 'pass'
            )
            assert.strictEqual(passedTests.length, 2)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-snapshot-attempt-to-fix-1',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      onlyLatestIt('works with snapshot tests when every attempt passes', async () => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-snapshot-attempt-to-fix-1.js': {
                tests: {
                  'attempt to fix snapshot is flaky': {
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
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')

            assert.strictEqual(tests.length, 4)

            const passedTests = tests.filter(
              test => test.meta[TEST_STATUS] === 'pass'
            )
            assert.strictEqual(passedTests.length, 4)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-snapshot-attempt-to-fix-1',
              SHOULD_PASS_ALWAYS: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
        assert.strictEqual(exitCode, 0)
      })

      onlyLatestIt('works with image snapshot tests', async () => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-snapshot-image.js': {
                tests: {
                  'snapshot can match': {
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
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')

            assert.strictEqual(tests.length, 4)
            const retriedTests = tests.filter(
              test => test.meta[TEST_IS_RETRY] === 'true'
            )

            assert.strictEqual(retriedTests.length, 3)
            const failedTests = tests.filter(
              test => test.meta[TEST_STATUS] === 'fail'
            )
            assert.strictEqual(failedTests.length, 2)

            const passedTests = tests.filter(
              test => test.meta[TEST_STATUS] === 'pass'
            )
            assert.strictEqual(passedTests.length, 2)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-snapshot-image',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      context('parallel mode', () => {
        it('can attempt to fix in parallel mode', (done) => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

          runAttemptToFixTest(
            done,
            {
              isAttemptToFix: true,
              isParallel: true,
              extraEnvVars: {
                // we need to run more than 1 suite for parallel mode to kick in
                TESTS_TO_RUN: 'test-management/test-attempt-to-fix',
                RUN_IN_PARALLEL: 'true',
              },
            }
          )
        })

        it('reports attempt to fix summary when not running in band', (done) => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
          receiver.setTestManagementTests({
            jest: {
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

          runAttemptToFixTest(
            done,
            {
              isAttemptToFix: true,
              isParallel: true,
              isQuarantined: true,
              extraEnvVars: {
                // we need to run more than 1 suite for parallel mode to kick in
                TESTS_TO_RUN: 'test-management/test-attempt-to-fix',
                RUN_IN_PARALLEL: 'true',
              },
            }
          )
        })

        onlyLatestIt('works with snapshot tests', async () => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

          receiver.setTestManagementTests({
            jest: {
              suites: {
                'ci-visibility/test-management/test-snapshot-attempt-to-fix-1.js': {
                  tests: {
                    'attempt to fix snapshot is flaky': {
                      properties: {
                        attempt_to_fix: true,
                      },
                    },
                  },
                },
                'ci-visibility/test-management/test-snapshot-attempt-to-fix-2.js': {
                  tests: {
                    'attempt to fix snapshot 2 is flaky': {
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
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const testSession = events.find(event => event.type === 'test_session_end').content

              assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')

              assert.strictEqual(tests.length, 8)
              const retriedTests = tests.filter(
                test => test.meta[TEST_IS_RETRY] === 'true'
              )

              assert.strictEqual(retriedTests.length, 6)
              const failedTests = tests.filter(
                test => test.meta[TEST_STATUS] === 'fail'
              )
              assert.strictEqual(failedTests.length, 4)

              const passedTests = tests.filter(
                test => test.meta[TEST_STATUS] === 'pass'
              )
              assert.strictEqual(passedTests.length, 4)
            })

          childProcess = exec(
            runTestsCommand,
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TESTS_TO_RUN: 'test-management/test-snapshot-attempt-to-fix-',
                RUN_IN_PARALLEL: 'true',
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
          ])
        })
      })
    })

    context('disabled', () => {
      beforeEach(() => {
        receiver.setTestManagementTests({
          jest: {
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

      const getTestAssertions = (isDisabling, isParallel) =>
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

            if (isParallel) {
              // Parallel mode in jest requires more than a single test suite
              // Here we check that the second test suite is actually running,
              // so we can be sure that parallel mode is on
              assertObjectContains(resourceNames, [
                'ci-visibility/test-management/test-disabled-2.js.disable tests 2 can disable a test',
              ])
            }

            const skippedTest = tests.find(
              test => test.meta[TEST_NAME] === 'disable tests can disable a test'
            )

            if (isDisabling) {
              assert.strictEqual(skippedTest.meta[TEST_STATUS], 'skip')
              assert.strictEqual(skippedTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
            } else {
              assert.strictEqual(skippedTest.meta[TEST_STATUS], 'fail')
              assert.ok(!(TEST_MANAGEMENT_IS_DISABLED in skippedTest.meta))
            }
          })

      const runDisableTest = (done, isDisabling, extraEnvVars = {}, isParallel = false) => {
        let stdout = ''
        const testAssertionsPromise = getTestAssertions(isDisabling, isParallel)

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-disabled-1',
              SHOULD_CHECK_RESULTS: '1',
              ...extraEnvVars,
            },
          }
        )

        // jest uses stderr to output logs
        childProcess.stderr?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        childProcess.on('exit', exitCode => {
          testAssertionsPromise.then(() => {
            if (isDisabling) {
              assert.doesNotMatch(stdout, /I am running/)
              // even though a test fails, the exit code is 0 because the test is disabled
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

      it('pass if disable is not enabled', (done) => {
        receiver.setSettings({ test_management: { enabled: false } })

        runDisableTest(done, false)
      })

      it('does not enable disable tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runDisableTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
      })

      it('can disable in parallel mode', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runDisableTest(
          done,
          true,
          {
            // we need to run more than 1 suite for parallel mode to kick in
            TESTS_TO_RUN: 'test-management/test-disabled',
            RUN_IN_PARALLEL: 'true',
          },
          true
        )
      })

      // Regression test: with workerIdleMemoryLimit=0, jest restarts the worker after every suite.
      // Before the fix, sendWrapper was only applied to the original child process. After restart,
      // the new child process was not wrapped, so _ddTestManagementTests was never injected.
      it('can disable in parallel mode after worker restart', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        receiver.setTestManagementTests({
          jest: {
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
              'ci-visibility/test-management/test-worker-restart-disabled.js': {
                tests: {
                  'worker restart disabled tests can disable a test': {
                    properties: {
                      disabled: true,
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
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')

            const disabledTest1 = tests.find(
              test => test.meta[TEST_NAME] === 'disable tests can disable a test'
            )
            const disabledTestRestart = tests.find(
              test => test.meta[TEST_NAME] === 'worker restart disabled tests can disable a test'
            )

            // Both tests must be skipped, including the one that runs on a restarted worker
            assert.strictEqual(disabledTest1.meta[TEST_STATUS], 'skip')
            assert.strictEqual(disabledTest1.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
            assert.strictEqual(disabledTest1.meta[TEST_FINAL_STATUS], 'skip')
            assert.strictEqual(disabledTestRestart.meta[TEST_STATUS], 'skip')
            assert.strictEqual(disabledTestRestart.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
            assert.strictEqual(disabledTestRestart.meta[TEST_FINAL_STATUS], 'skip')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              // Runs 3 suites with maxWorkers=1 and workerIdleMemoryLimit=0: spacer,
              // test-disabled-1, and test-worker-restart-disabled. The memory limit forces
              // the single worker to restart after each suite. By the 3rd suite the child
              // process has been replaced and its send is no longer wrapped by sendWrapper.
              TESTS_TO_RUN: 'test-management/test-(disabled-1|worker-restart)',
              RUN_IN_PARALLEL: 'true',
              MAX_WORKERS: '1',
              SHOULD_CHECK_RESULTS: '1',
              WORKER_IDLE_MEMORY_LIMIT: '0',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('sets final_status tag to skip for disabled tests', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const disabledTest = tests.find(
              test => test.meta[TEST_NAME] === 'disable tests can disable a test'
            )

            assert.strictEqual(disabledTest.meta[TEST_STATUS], 'skip')
            assert.strictEqual(disabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
            assert.strictEqual(disabledTest.meta[TEST_FINAL_STATUS], 'skip')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-disabled-1',
            },
            stdio: 'inherit',
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })
    })

    context('quarantine', () => {
      beforeEach(() => {
        receiver.setTestManagementTests({
          jest: {
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

      const getTestAssertions = (isQuarantining, isParallel) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isQuarantining) {
              assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
              // test session is passed even though a test fails because the test is quarantined
              assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
              const quarantinedSuite = suites.find(
                suite => suite.meta[TEST_SUITE] === 'ci-visibility/test-management/test-quarantine-1.js'
              )
              assert.strictEqual(quarantinedSuite.meta[TEST_STATUS], 'pass')
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

            if (isParallel) {
              // Parallel mode in jest requires more than a single test suite
              // Here we check that the second test suite is actually running,
              // so we can be sure that parallel mode is on
              assertObjectContains(resourceNames, [
                'ci-visibility/test-management/test-quarantine-2.js.quarantine tests 2 can quarantine a test',
                'ci-visibility/test-management/test-quarantine-2.js.quarantine tests 2 can pass normally',
              ])
            }

            const failedTest = tests.find(
              test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
            )
            assert.strictEqual(failedTest.meta[TEST_STATUS], 'fail')

            if (isQuarantining) {
              assert.strictEqual(failedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            } else {
              assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in failedTest.meta))
            }
          })

      const runQuarantineTest = async (isQuarantining, extraEnvVars = {}, isParallel = false) => {
        let stdout = ''
        const testAssertionsPromise = getTestAssertions(isQuarantining, isParallel)

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-quarantine-1',
              SHOULD_CHECK_RESULTS: '1',
              ...extraEnvVars,
            },
          }
        )

        // jest uses stderr to output logs, stdout for console.log from tests
        childProcess.stdout?.on('data', (chunk) => {
          stdout += chunk.toString()
        })
        childProcess.stderr?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), testAssertionsPromise])

        // it runs regardless of quarantine status
        assert.match(stdout, /I am running when quarantined/)
        if (isQuarantining) {
          // even though a test fails, the exit code is 0 because the test is quarantined
          assert.strictEqual(exitCode, 0)
          // Verify Datadog Test Optimization message is shown for suppressed quarantine failures
          assert.match(stdout, /Datadog Test Optimization/)
          assert.match(stdout, /\d+ test failure\(s\) were ignored/)
          assert.match(stdout, /Quarantine/)
          assert.match(stdout, /test-quarantine-1.*›.*quarantine tests can quarantine a test/)
        } else {
          assert.strictEqual(exitCode, 1)
        }
      }

      it('can quarantine tests', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        await runQuarantineTest(true)
      })

      it('fails if quarantine is not enabled', async () => {
        receiver.setSettings({ test_management: { enabled: false } })

        await runQuarantineTest(false)
      })

      it('does not enable quarantine tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        await runQuarantineTest(false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
      })

      it('can quarantine in parallel mode', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        await runQuarantineTest(
          true,
          {
            // we need to run more than 1 suite for parallel mode to kick in
            TESTS_TO_RUN: 'test-management/test-quarantine',
            RUN_IN_PARALLEL: 'true',
          },
          true
        )
      })

      it('fails if a non-quarantined test fails even when a quarantined test also fails', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        // Only quarantine one of the failing tests, leaving another failing test non-quarantined
        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-partial-quarantine.js': {
                tests: {
                  'partial quarantine tests quarantined failing test': {
                    properties: {
                      quarantined: true,
                    },
                  },
                  // Note: 'partial quarantine tests non-quarantined failing test' is NOT quarantined
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

            // Session should be marked as failed because a non-quarantined test failed
            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
            assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')

            // Verify the quarantined test has the quarantine tag
            const quarantinedTest = tests.find(
              test => test.meta[TEST_NAME] === 'partial quarantine tests quarantined failing test'
            )
            assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
            assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

            // Verify the non-quarantined test does NOT have the quarantine tag
            const nonQuarantinedTest = tests.find(
              test => test.meta[TEST_NAME] === 'partial quarantine tests non-quarantined failing test'
            )
            assert.strictEqual(nonQuarantinedTest.meta[TEST_STATUS], 'fail')
            assert.ok(
              !(TEST_MANAGEMENT_IS_QUARANTINED in nonQuarantinedTest.meta),
              'Non-quarantined test should not have quarantine tag'
            )
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-partial-quarantine',
              SHOULD_CHECK_RESULTS: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), testAssertionsPromise])

        // Exit code should be 1 because a non-quarantined test failed
        assert.strictEqual(exitCode, 1)
      })

      it('sets final_status tag to skip for quarantined tests', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const quarantinedTest = tests.find(
              test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
            )
            // Quarantined tests still run and report their actual status
            assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
            assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')

            const passingTest = tests.find(
              test => test.meta[TEST_NAME] === 'quarantine tests can pass normally'
            )
            assert.strictEqual(passingTest.meta[TEST_STATUS], 'pass')
            assert.strictEqual(passingTest.meta[TEST_FINAL_STATUS], 'pass')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-quarantine-1',
            },
            stdio: 'inherit',
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('quarantine prevents session failure when ATR is also enabled', async () => {
        receiver.setSettings({
          test_management: { enabled: true },
          flaky_test_retries_enabled: true,
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            // Session should pass because the only failing test is quarantined
            assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')

            // All executions of the quarantined test should be tagged as quarantined
            const quarantinedTests = tests.filter(
              test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
            )
            assert.ok(quarantinedTests.length > 1, 'quarantined test should have been retried by ATR')
            for (const test of quarantinedTests) {
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            }

            // The last execution should have final_status = skip
            const lastExecution = quarantinedTests[quarantinedTests.length - 1]
            assert.strictEqual(lastExecution.meta[TEST_FINAL_STATUS], 'skip')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-quarantine-1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])

        // Exit code should be 0 because the failing test is quarantined
        assert.strictEqual(exitCode, 0)
      })

      it('session passes when EFD flaky retries and quarantine failures are combined', async () => {
        const NUM_RETRIES_EFD = 3

        // The new flaky test is NOT in known tests so EFD will retry it
        receiver.setKnownTests({ jest: {} })

        receiver.setSettings({
          test_management: { enabled: true },
          early_flake_detection: {
            enabled: true,
            slow_test_retries: { '5s': NUM_RETRIES_EFD },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        // Only quarantine the always-failing test
        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-efd-and-quarantine.js': {
                tests: {
                  'efd and quarantine is a quarantined failing test': {
                    properties: {
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
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            // Session should pass:
            // - The new flaky test has at least one passing EFD retry (so EFD can ignore its failures)
            // - The quarantined test is quarantined (so quarantine can ignore its failure)
            assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')

            // Verify the quarantined test is tagged
            const quarantinedTests = tests.filter(
              test => test.meta[TEST_NAME] === 'efd and quarantine is a quarantined failing test'
            )
            assert.ok(quarantinedTests.length >= 1, `Expected ${quarantinedTests.length} >= 1`)
            for (const test of quarantinedTests) {
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            }

            // Verify the new flaky test has EFD retries (at least original + retries)
            const flakyTests = tests.filter(
              test => test.meta[TEST_NAME] === 'efd and quarantine is a new flaky test'
            )
            assert.ok(flakyTests.length > 1, 'flaky test should have been retried by EFD')

            // At least one EFD retry should have passed
            const passingFlakyTests = flakyTests.filter(t => t.meta[TEST_STATUS] === 'pass')
            assert.ok(passingFlakyTests.length > 0, 'at least one EFD retry should pass')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-efd-and-quarantine',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])

        // Exit code should be 0 because:
        // - The flaky test has at least one passing retry (EFD considers it OK)
        // - The always-failing test is quarantined
        assert.strictEqual(exitCode, 0)
      })

      it('does not flip exit code to 0 when a test suite fails to parse', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        // Scenario: (1) test-suite-failed-to-run-parse.js fails to parse so no tests run,
        // (2) test-quarantine-1.js parses and runs, its only failing test is quarantined.
        receiver.setTestManagementTests({
          jest: {
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

        const testAssertionsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end')?.content
            assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true', 'test management should be running')

            // TODO: parsing errors do not report test suite
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const quarantine1Tests = tests.filter(t => t.resource?.includes('test-quarantine-1'))
            const withQuarantineTag = quarantine1Tests.filter(t => t.meta?.[TEST_MANAGEMENT_IS_QUARANTINED] === 'true')
            assert.strictEqual(withQuarantineTag.length, 1, 'only one test from test-quarantine-1 has quarantine tag')
            assert.strictEqual(withQuarantineTag[0].meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/(test-suite-failed-to-run-parse|test-quarantine-1)',
              SHOULD_CHECK_RESULTS: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), testAssertionsPromise])
        assert.strictEqual(exitCode, 1, 'exit code should be 1 when a test suite fails to parse')
      })

      it('does not flip exit code to 0 when a test suite fails due to module resolution error', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        // Scenario: (1) test-suite-failed-to-run-resolution.js fails to load (invalid require),
        // (2) test-quarantine-1.js parses and runs, its only failing test is quarantined.
        receiver.setTestManagementTests({
          jest: {
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

        const testAssertionsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end')?.content
            assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true', 'test management should be running')

            const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
            const failedSuite = suites.find(s => s.meta?.[TEST_SUITE]?.includes('test-suite-failed-to-run-resolution'))
            assert.ok(failedSuite, 'failing test suite should be reported')
            assert.strictEqual(failedSuite.meta[TEST_STATUS], 'fail')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const quarantine1Tests = tests.filter(t => t.resource?.includes('test-quarantine-1'))
            const withQuarantineTag = quarantine1Tests.filter(t => t.meta?.[TEST_MANAGEMENT_IS_QUARANTINED] === 'true')
            assert.strictEqual(withQuarantineTag.length, 1, 'only one test from test-quarantine-1 has quarantine tag')
            assert.strictEqual(withQuarantineTag[0].meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/(test-suite-failed-to-run-resolution|test-quarantine-1)',
              SHOULD_CHECK_RESULTS: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), testAssertionsPromise])
        assert.strictEqual(exitCode, 1, 'exit code 1 when suite fails (resolution error)')
      })
    })

    context('jest --bail option', () => {
      const bailCases = [
        {
          label: 'quarantined',
          testSuite: 'ci-visibility/test-management/test-quarantine-1.js',
          testName: 'quarantine tests can quarantine a test',
          propertyName: 'quarantined',
          testsToRun: 'test-management/test-quarantine',
          attemptingToFixMessage:
            /Datadog Test Optimization: attempting to fix .*quarantine tests can quarantine a test/,
          executionLogMessage:
            /(?:console\.log\s+I am running when quarantined|console\.log [^\n]*test-quarantine-1\.js:7)/g,
        },
        {
          label: 'disabled',
          testSuite: 'ci-visibility/test-management/test-disabled-1.js',
          testName: 'disable tests can disable a test',
          propertyName: 'disabled',
          testsToRun: 'test-management/test-disabled',
          attemptingToFixMessage:
            /Datadog Test Optimization: attempting to fix .*disable tests can disable a test/,
          executionLogMessage:
            /(?:console\.log\s+I am running|console\.log [^\n]*test-disabled-1\.js:7)/g,
        },
      ]

      const setManagedTest = ({ testSuite, testName, propertyName }, attemptToFix = false) => {
        receiver.setTestManagementTests({
          jest: {
            suites: {
              [testSuite]: {
                tests: {
                  [testName]: {
                    properties: {
                      [propertyName]: true,
                      ...(attemptToFix ? { attempt_to_fix: true } : {}),
                    },
                  },
                },
              },
            },
          },
        })
      }

      const runJestWithBail = async (testsToRun) => {
        let output = ''
        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: testsToRun,
              JEST_BAIL: '1',
              SHOULD_CHECK_RESULTS: '1',
            },
          }
        )
        childProcess.stderr?.on('data', (chunk) => {
          output += chunk.toString()
        })
        childProcess.stdout?.on('data', (chunk) => {
          output += chunk.toString()
        })

        const [exitCode] = await once(childProcess, 'exit')
        return { exitCode, output }
      }

      it('does not bail if the failing test is quarantined or disabled', async () => {
        for (const bailCase of bailCases) {
          receiver.setSettings({ test_management: { enabled: true } })
          setManagedTest(bailCase)

          const { exitCode, output } = await runJestWithBail(bailCase.testsToRun)

          assert.match(output, /Test Suites:.*2 total/, bailCase.label)
          assert.strictEqual(exitCode, 0, bailCase.label)
        }
      })

      it('bails when attempt to fix makes quarantine and disabled a noop', async () => {
        for (const bailCase of bailCases) {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 2 } })
          setManagedTest(bailCase, true)

          const { exitCode, output } = await runJestWithBail(bailCase.testsToRun)

          assert.match(output, bailCase.attemptingToFixMessage, bailCase.label)
          assert.strictEqual((output.match(bailCase.executionLogMessage) || []).length, 3, bailCase.label)
          assert.match(output, /Test Suites:.*1 failed/, bailCase.label)
          assert.strictEqual(exitCode, 1, bailCase.label)
        }
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

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: 'test-management/test-attempt-to-fix-1',
          DD_TRACE_DEBUG: '1',
        },
      })

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
  })

  context('libraries capabilities', () => {
    it('adds capabilities to tests', (done) => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

          assert.ok(metadataDicts.length > 0, `Expected ${metadataDicts.length} > 0`)
          metadataDicts.forEach(metadata => {
            assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], '1')
            assert.strictEqual(metadata.test[DD_CAPABILITIES_EARLY_FLAKE_DETECTION], '1')
            assert.strictEqual(metadata.test[DD_CAPABILITIES_AUTO_TEST_RETRIES], '1')
            assert.strictEqual(metadata.test[DD_CAPABILITIES_IMPACTED_TESTS], '1')
            assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE], '1')
            assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE], '1')
            assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX], '5')
            assert.strictEqual(metadata.test[DD_CAPABILITIES_FAILED_TEST_REPLAY], '1')
            // capabilities logic does not overwrite test session name
            assert.strictEqual(metadata.test_levels[TEST_SESSION_NAME], 'my-test-session-name')
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_TEST_SESSION_NAME: 'my-test-session-name',
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

  context('custom tagging', () => {
    it('does detect custom tags in the tests', (done) => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const test = events.find(event => event.type === 'test').content

          assertObjectContains(test, {
            meta: {
              'outer_scope.beforeEach': 'true',
              'custom_tag.beforeEach': 'true',
              'custom_tag.it': 'true',
              'custom_tag.afterEach': 'true',
              'outer_scope.afterEach': 'true',
            },
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'ci-visibility/test-custom-tags',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('does detect custom tags on test suites from beforeAll and afterAll hooks', (done) => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSuite = events.find(event => event.type === 'test_suite_end').content

          assertObjectContains(testSuite, {
            meta: {
              'suite.beforeAll': 'true',
              'suite.afterAll': 'true',
            },
          })

          const suiteSpanId = testSuite.test_suite_id.toString()
          const sessionTraceId = testSuite.test_session_id.toString()

          // Spans created in beforeAll/afterAll appear as 'span' events and are children of the test suite span
          const spans = events.filter(event => event.type === 'span').map(event => event.content)
          const beforeAllSpan = spans.find(span => span.resource === 'beforeAll.setup')
          const afterAllSpan = spans.find(span => span.resource === 'afterAll.teardown')

          assert.ok(beforeAllSpan)
          assert.strictEqual(beforeAllSpan.parent_id.toString(), suiteSpanId)
          assert.strictEqual(beforeAllSpan.trace_id.toString(), sessionTraceId)

          assert.ok(afterAllSpan)
          assert.strictEqual(afterAllSpan.parent_id.toString(), suiteSpanId)
          assert.strictEqual(afterAllSpan.trace_id.toString(), sessionTraceId)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'ci-visibility/test-suite-custom-tags',
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

  context('impacted tests', () => {
    const NUM_RETRIES = 3

    beforeEach(() => {
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test-impacted-test/test-impacted-1.js': [
            'impacted tests can pass normally',
          ],
          'ci-visibility/test-impacted-test/test-impacted-2.js': [
            'impacted tests 2 can pass normally',
          ],
        },
      })
    })

    // Modify test file to mark it as impacted
    before(() => {
      execSync('git checkout -b feature-branch', { cwd, stdio: 'ignore' })

      fs.writeFileSync(
        path.join(cwd, 'ci-visibility/test-impacted-test/test-impacted-1.js'),
        `const assert = require('assert')

        describe('impacted tests', () => {
          it('can pass normally', () => {
            assert.strictEqual(1 + 2, 4)
          })
          it('can fail', () => {
            assert.strictEqual(1 + 2, 4)
          })
        })`
      )
      execSync('git add ci-visibility/test-impacted-test/test-impacted-1.js', { cwd, stdio: 'ignore' })

      // Also modify test file with mock for mock state reset test
      fs.writeFileSync(
        path.join(cwd, 'ci-visibility/test-impacted-test/test-impacted-with-mock.js'),
        `'use strict'

        const mockFn = jest.fn()

        describe('impacted tests with mock', () => {
          it('resets mock state between retries', () => {
            console.log('I am running impacted test with mock')
            mockFn()
            expect(mockFn).toHaveBeenCalledTimes(1)
          })
        })`
      )
      execSync('git add ci-visibility/test-impacted-test/test-impacted-with-mock.js', { cwd, stdio: 'ignore' })

      execSync('git commit -m "modify test-impacted-1.js"', { cwd, stdio: 'ignore' })
    })

    after(() => {
      execSync('git checkout -', { cwd, stdio: 'ignore' })
      execSync('git branch -D feature-branch', { cwd, stdio: 'ignore' })
    })

    const getTestAssertions = ({ isModified, isEfd, isNew, isParallel }) =>
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
            // Parallel mode in jest requires more than a single test suite
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
            const retriedTests = tests.filter(test =>
              test.meta[TEST_IS_RETRY] === 'true' &&
              test.meta[TEST_NAME] !== 'impacted tests can pass normally'
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

    const runImpactedTest = (
      done,
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
            TESTS_TO_RUN: 'test-impacted-test/test-impacted-1',
            GITHUB_BASE_REF: '',
            ...extraEnvVars,
          },
        }
      )

      childProcess.on('exit', () => {
        testAssertionsPromise.then(done).catch(done)
      })
    }

    context('test is not new', () => {
      it('should be detected as impacted', (done) => {
        receiver.setSettings({ impacted_tests_enabled: true })

        runImpactedTest(done, { isModified: true })
      })

      it('attempt to fix takes precedence over EFD for impacted tests', async () => {
        const NUM_RETRIES_EFD = 2
        receiver.setSettings({
          impacted_tests_enabled: true,
          test_management: { enabled: true, attempt_to_fix_retries: 2 },
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })
        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-impacted-test/test-impacted-1.js': {
                tests: {
                  'impacted tests can pass normally': {
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
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const impactedAtfTests = tests.filter(test =>
              test.meta[TEST_SOURCE_FILE] === 'ci-visibility/test-impacted-test/test-impacted-1.js' &&
              test.meta[TEST_NAME] === 'impacted tests can pass normally'
            )

            assert.strictEqual(impactedAtfTests.length, 3)
            const atfRetries = impactedAtfTests.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atf
            )
            const efdRetries = impactedAtfTests.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd
            )
            assert.strictEqual(atfRetries.length, 2)
            assert.strictEqual(efdRetries.length, 0)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-impacted-test/test-impacted-1',
              GITHUB_BASE_REF: '',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('should not be detected as impacted if disabled', (done) => {
        receiver.setSettings({ impacted_tests_enabled: false })

        runImpactedTest(done, { isModified: false })
      })

      it('should not be detected as impacted if DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED is false',
        (done) => {
          receiver.setSettings({ impacted_tests_enabled: true })

          runImpactedTest(done,
            { isModified: false },
            { DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: '0' }
          )
        })

      it('should be detected as impacted in parallel mode', (done) => {
        receiver.setSettings({ impacted_tests_enabled: true })

        runImpactedTest(done, { isModified: true, isParallel: true }, {
          TESTS_TO_RUN: 'test-impacted-test/test-impacted',
          RUN_IN_PARALLEL: 'true',
        })
      })

      // Regression test: without the fix, _ddModifiedFiles is not injected after worker restart,
      // so tests that should be detected as impacted are not marked as such.
      it('should be detected as impacted after worker restart', async () => {
        receiver.setSettings({ impacted_tests_enabled: true })

        // Modify the impacted file in test-management/ and commit so git diff picks it up
        fs.writeFileSync(
          path.join(cwd, 'ci-visibility/test-management/test-worker-restart-z-impacted.js'),
          `const assert = require('assert')
          describe('worker restart impacted tests', () => {
            it('can pass normally', () => {
              assert.strictEqual(1 + 2, 3)
            })
          })`
        )
        execSync('git add ci-visibility/test-management/test-worker-restart-z-impacted.js', { cwd, stdio: 'ignore' })
        execSync('git commit --amend --no-edit', { cwd, stdio: 'ignore' })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const impactedTest = tests.find(test =>
              test.meta[TEST_NAME] === 'worker restart impacted tests can pass normally'
            )

            assert.ok(impactedTest, 'impacted test not found in payloads')
            assert.strictEqual(impactedTest.meta[TEST_IS_MODIFIED], 'true')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              // 3 suites in test-management/ with workerIdleMemoryLimit=0:
              // test-worker-restart-known-tests-spacer, test-worker-restart-spacer,
              // then test-worker-restart-z-impacted (sorts last). The worker restarts
              // after each suite, and the impacted test runs on a replaced child process.
              TESTS_TO_RUN: 'test-management/test-worker-restart-(spacer|known-tests-spacer|z-impacted)',
              RUN_IN_PARALLEL: 'true',
              MAX_WORKERS: '1',
              WORKER_IDLE_MEMORY_LIMIT: '0',
              GITHUB_BASE_REF: '',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })
    })

    context('test is new', () => {
      it('should be retried and marked both as new and modified', (done) => {
        receiver.setKnownTests({ jest: {} })
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
        runImpactedTest(done, { isModified: true, isEfd: true, isNew: true })
      })

      it('resets mock state between impacted test retries', async () => {
        // Test is considered new (not in known tests)
        receiver.setKnownTests({ jest: {} })
        receiver.setSettings({
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

        let stdout = ''
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // Should have 1 original + NUM_RETRIES retry attempts
            const mockTests = tests.filter(
              test => test.meta[TEST_NAME] === 'impacted tests with mock resets mock state between retries'
            )
            assert.strictEqual(mockTests.length, NUM_RETRIES + 1)

            // All tests should pass because mock state is reset between retries
            for (const test of mockTests) {
              assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            }

            // All should be marked as modified (impacted)
            for (const test of mockTests) {
              assert.strictEqual(test.meta[TEST_IS_MODIFIED], 'true')
            }
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-impacted-test/test-impacted-with-mock',
              GITHUB_BASE_REF: '',
            },
          }
        )

        childProcess.stdout?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        childProcess.stderr?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        const [exitCode] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])

        // Verify the test actually ran
        assert.match(stdout, /I am running impacted test with mock/)

        // All retries should pass, so exit code should be 0
        assert.strictEqual(exitCode[0], 0)
      })
    })
  })

  context('winston mocking', () => {
    it('should allow winston to be mocked and verify createLogger is called', async () => {
      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'jest-mock-bypass-require/winston-mock-test',
            SHOULD_CHECK_RESULTS: '1',
          },
        }
      )

      const [code] = await once(childProcess, 'exit')
      assert.strictEqual(code, 0, `Jest should pass but failed with code ${code}`)
    })
  })

  context('seed suffix normalization', () => {
    onlyLatestIt('should remove seed suffix from reported test names', async () => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 1)
          assert.strictEqual(tests[0].meta[TEST_NAME], 'seed suffix should strip seed')
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'jest-seed-suffix/jest-seed-suffix',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    onlyLatestIt('does not mark seed-suffixed tests as new when known tests use the stripped name', async () => {
      receiver.setKnownTests({
        jest: {
          'ci-visibility/jest-seed-suffix/jest-seed-suffix.js': [
            'seed suffix should strip seed',
          ],
        },
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 2,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 1)
          assert.strictEqual(tests[0].meta[TEST_NAME], 'seed suffix should strip seed')
          assert.ok(!(TEST_IS_NEW in tests[0].meta))
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'jest-seed-suffix/jest-seed-suffix',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    onlyLatestIt('keeps seed-like describe suffixes when matching test management tests', async () => {
      const testName = 'seed suffix (with seed=12) should preserve describe seed suffix'
      receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 2 } })
      receiver.setTestManagementTests({
        jest: {
          suites: {
            'ci-visibility/jest-seed-suffix/jest-describe-seed-suffix.js': {
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
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_NAME] === testName)

          assert.strictEqual(retriedTests.length, 3)
          assert.ok(!(TEST_IS_RETRY in retriedTests[0].meta))
          assert.deepStrictEqual(
            retriedTests.map(test => test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX]),
            ['true', 'true', 'true']
          )
          assert.deepStrictEqual(
            retriedTests.slice(1).map(test => ({
              reason: test.meta[TEST_RETRY_REASON],
              retry: test.meta[TEST_IS_RETRY],
            })),
            [
              { reason: TEST_RETRY_REASON_TYPES.atf, retry: 'true' },
              { reason: TEST_RETRY_REASON_TYPES.atf, retry: 'true' },
            ]
          )
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'jest-seed-suffix/jest-describe-seed-suffix',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })
  })

  it('does not crash with mocks that are not dependencies', async () => {
    let testOutput = ''

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: 'jest-package-mock/non-dependency-mock-test',
          SETUP_FILES_AFTER_ENV: '<rootDir>/ci-visibility/jest-setup-files-after-env.js',
          RUN_IN_PARALLEL: 'true',
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
      receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
          assert.strictEqual(tests.length, 6)
          assert.strictEqual(testSuites.length, 6)
          assert.strictEqual(testSuites.every(suite => suite.meta[TEST_STATUS] === 'pass'), true)
          assert.strictEqual(tests.every(test => test.meta[TEST_STATUS] === 'pass'), true)
        }),
    ])
    assert.doesNotMatch(testOutput, /Cannot find module/)
    assert.match(testOutput, /6 passed/)
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

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            ENABLE_CODE_COVERAGE: 'true',
            COVERAGE_REPORTERS: 'lcov',
            COLLECT_COVERAGE_FROM: 'ci-visibility/test/*.js',
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

    it('sends coverage_upload.request telemetry metric when coverage is uploaded', async () => {
      receiver.setSettings({
        coverage_report_upload_enabled: true,
      })
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

      const telemetryPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/apmtelemetry'), (payloads) => {
          const telemetryMetrics = payloads.flatMap(({ payload }) => payload.payload.series)

          const coverageUploadMetric = telemetryMetrics.find(
            ({ metric }) => metric === TELEMETRY_COVERAGE_UPLOAD
          )

          assert.ok(coverageUploadMetric, 'coverage_upload.request telemetry metric should be sent')
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
            ENABLE_CODE_COVERAGE: 'true',
            COVERAGE_REPORTERS: 'lcov',
            COLLECT_COVERAGE_FROM: 'ci-visibility/test/*.js',
            DD_GIT_COMMIT_SHA: gitCommitSha,
            DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        telemetryPromise,
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

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            ENABLE_CODE_COVERAGE: 'true',
            COVERAGE_REPORTERS: 'lcov',
            COLLECT_COVERAGE_FROM: 'ci-visibility/test/*.js',
            DD_GIT_COMMIT_SHA: gitCommitSha,
            DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
          },
        }
      )

      await once(childProcess, 'exit')

      assert.strictEqual(coverageReportUploaded, false, 'coverage report should not be uploaded')
    })
  })
})
