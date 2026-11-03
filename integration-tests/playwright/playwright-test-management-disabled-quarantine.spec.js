'use strict'

const assert = require('node:assert')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const satisfies = require('semifies')

const {
  TEST_STATUS,
  TEST_FINAL_STATUS,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_RETRY_REASON,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_NAME,
  TEST_RETRY_REASON_TYPES,
  TEST_FAILURE_SCREENSHOT_UPLOADED,
  TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR,
  TEST_SESSION_EMPTY_REASON,
  TEST_SKIP_REASON,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { assertObjectContains, getCiVisAgentlessConfig } = require('../helpers')
const {
  PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT,
  describePlaywrightTestManagement,
} = require('./playwright-test-management')

const DISABLED_MANAGEMENT_TESTS = {
  playwright: {
    suites: {
      'disabled-test.js': {
        tests: {
          'disable should disable test': {
            properties: {
              disabled: true,
            },
          },
        },
      },
      'disabled-2-test.js': {
        tests: {
          'disable should disable test': {
            properties: {
              disabled: true,
            },
          },
        },
      },
      'disabled-serial-test.js': {
        tests: {
          'disabled serial retry should not run disabled sibling': {
            properties: {
              disabled: true,
            },
          },
        },
      },
    },
  },
}

const ALL_DISABLED_MANAGEMENT_TESTS = {
  playwright: {
    suites: {
      'managed-off-test.js': {
        tests: {
          'should be disabled': {
            properties: {
              disabled: true,
            },
          },
        },
      },
    },
  },
}

const QUARANTINE_MANAGEMENT_TESTS = {
  playwright: {
    suites: {
      'quarantine-test.js': {
        tests: {
          'quarantine should quarantine failed test': {
            properties: {
              quarantined: true,
            },
          },
        },
      },
    },
  },
}

const QUARANTINE_WITH_DISABLED_ATF_MANAGEMENT_TESTS = {
  playwright: {
    suites: {
      ...QUARANTINE_MANAGEMENT_TESTS.playwright.suites,
      'zzz-passing-test.js': {
        tests: {
          'should run unless max failures is reached': {
            properties: {
              attempt_to_fix: true,
              disabled: true,
            },
          },
        },
      },
    },
  },
}

describePlaywrightTestManagement(({ contextNewVersions, it, latest, runtime, version }) => {
  contextNewVersions('test management', () => {
    context('disabled', () => {
      const getTestAssertions = (receiver, isDisabling) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const resourceNames = events.filter(event => event.type === 'test').map(event => event.content.resource)
            assertObjectContains(resourceNames.sort(), [
              'disabled-test.js.disable should disable test',
              'disabled-test.js.not disabled should not disable test',
              'disabled-test.js.not disabled 2 should not disable test 2',
              'disabled-test.js.not disabled 3 should not disable test 3',
              'disabled-2-test.js.disable should disable test',
              'disabled-2-test.js.not disabled should not disable test',
              'disabled-2-test.js.not disabled 2 should not disable test 2',
              'disabled-2-test.js.not disabled 3 should not disable test 3',
            ].sort())

            const testSession = events.find(event => event.type === 'test_session_end').content
            if (isDisabling) {
              assertObjectContains(testSession.meta, {
                [TEST_MANAGEMENT_ENABLED]: 'true',
              })
            } else {
              assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
            }

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 8)

            const disabledTests = tests.filter(test => test.meta[TEST_NAME] === 'disable should disable test')
            assert.strictEqual(disabledTests.length, 2)

            disabledTests.forEach(test => {
              if (isDisabling) {
                assert.strictEqual(test.meta[TEST_STATUS], 'skip')
                assertObjectContains(test.meta, {
                  [TEST_MANAGEMENT_IS_DISABLED]: 'true',
                })
              } else {
                assert.strictEqual(test.meta[TEST_STATUS], 'fail')
                assert.ok(!(TEST_MANAGEMENT_IS_DISABLED in test.meta))
              }
            })
          }, PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT)

      const runDisableTest = async (receiver, isDisabling, extraEnvVars) => {
        const testAssertionsPromise = getTestAssertions(receiver, isDisabling)
        let testOutput = ''
        let proc
        try {
          proc = exec(
            './node_modules/.bin/playwright test -c playwright.config.js disabled-test.js disabled-2-test.js',
            {
              cwd: runtime.cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${runtime.webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
                ...extraEnvVars,
              },
            }
          )

          proc.stdout?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          proc.stderr?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })

          const [[exitCode]] = await Promise.all([
            once(proc, 'exit'),
            once(proc.stdout, 'end'),
            once(proc.stderr, 'end'),
            testAssertionsPromise,
          ])

          // the testOutput checks whether the test is actually skipped
          if (isDisabling) {
            assert.doesNotMatch(testOutput, /SHOULD NOT BE EXECUTED/)
            assert.match(testOutput, /Disabled: \d+ tests? skipped\./)
            assert.strictEqual(exitCode, 0, testOutput)
          } else {
            assert.match(testOutput, /SHOULD NOT BE EXECUTED/)
            assert.strictEqual(exitCode, 1)
          }
        } finally {
          proc?.kill()
        }
      }

      it('can disable tests', async (receiver) => {
        receiver.setTestManagementTests(DISABLED_MANAGEMENT_TESTS)
        receiver.setSettings({ test_management: { enabled: true } })
        await runDisableTest(receiver, true)
      })

      it('can disable tests in fullyParallel mode', async (receiver) => {
        receiver.setTestManagementTests(DISABLED_MANAGEMENT_TESTS)
        receiver.setSettings({ test_management: { enabled: true } })
        await runDisableTest(receiver, true, { FULLY_PARALLEL: true, PLAYWRIGHT_WORKERS: '3' })
      })

      it('reports a shard with only disabled tests as all skipped', async (receiver, run) => {
        receiver.setTestManagementTests(ALL_DISABLED_MANAGEMENT_TESTS)
        receiver.setSettings({ test_management: { enabled: true } })

        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js managed-off-test.js --shard=1/1',
          {
            cwd: runtime.cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${runtime.webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-test-management',
            },
          }
        )

        const eventsPromise = receiver.gatherPayloadsUntilChildExit(
          proc,
          ({ url }) => url === '/api/v2/citestcycle',
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(({ type }) => type === 'test').map(({ content }) => content)

            assert.strictEqual(tests.length, 1)
            assert.strictEqual(tests[0].meta[TEST_STATUS], 'skip')
            assert.strictEqual(tests[0].meta[TEST_MANAGEMENT_IS_DISABLED], 'true')

            for (const eventType of ['test_session_end', 'test_module_end']) {
              const event = events.find(({ type }) => type === eventType)
              assert.ok(event, `expected ${eventType}`)
              assert.strictEqual(event.content.meta[TEST_STATUS], 'skip')
              assert.strictEqual(event.content.meta[TEST_SKIP_REASON], 'All tests were skipped')
              assert.strictEqual(event.content.meta[TEST_SESSION_EMPTY_REASON], 'all_tests_skipped')
            }
          }
        )

        const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, 0)
      })

      // Playwright itself only started ignoring unknown worker events in 1.39.0.
      if (version === latest || satisfies(version, '>=1.39.0')) {
        it('skips and reports a disabled sibling added by a serial retry', async (receiver, run) => {
          receiver.setTestManagementTests(DISABLED_MANAGEMENT_TESTS)
          receiver.setSettings({ test_management: { enabled: true } })

          const testAssertionsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const disabledTestName = 'disabled serial retry should not run disabled sibling'
              const events = payloads.flatMap(({ payload }) => payload.events)
              const disabledTests = events
                .filter(event => event.type === 'test')
                .map(event => event.content)
                .filter(test => test.meta[TEST_NAME] === disabledTestName)

              assert.strictEqual(disabledTests.length, 1)
              assert.strictEqual(disabledTests[0].meta[TEST_STATUS], 'skip')
              assert.strictEqual(disabledTests[0].meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
            }, PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT)

          const proc = run(
            './node_modules/.bin/playwright test -c playwright.config.js disabled-serial-test.js --retries=1',
            {
              cwd: runtime.cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
              },
            }
          )
          let testOutput = ''
          proc.stdout?.on('data', chunk => { testOutput += chunk.toString() })
          proc.stderr?.on('data', chunk => { testOutput += chunk.toString() })

          const [[exitCode]] = await Promise.all([
            once(proc, 'exit'),
            once(proc.stdout, 'end'),
            once(proc.stderr, 'end'),
            testAssertionsPromise,
          ])

          assert.doesNotMatch(testOutput, /SHOULD NOT BE EXECUTED/)
          assert.strictEqual(exitCode, 0, testOutput)
        })

        it('keeps failure screenshots aligned after a disabled serial retry sibling', async (receiver, run) => {
          receiver.setTestManagementTests(DISABLED_MANAGEMENT_TESTS)
          receiver.setSettings({ test_management: { enabled: true } })

          const proc = run(
            './node_modules/.bin/playwright test -c playwright.config.js disabled-serial-test.js --retries=1',
            {
              cwd: runtime.cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                DD_TEST_FAILURE_SCREENSHOTS_ENABLED: 'true',
                FAIL_AFTER_DISABLED: 'true',
                PLAYWRIGHT_FAILURE_SCREENSHOT_MODE: 'only-on-failure',
                PW_BASE_URL: `http://localhost:${runtime.webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
              },
            }
          )
          const payloadsPromise = receiver.gatherPayloadsUntilChildExit(
            proc,
            ({ url }) => url.startsWith('/api/v2/ci/test-runs/') || url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
              const mediaPayloads = payloads.filter(({ url }) => url.startsWith('/api/v2/ci/test-runs/'))
              const failedTest = payloads
                .filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
                .flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test')
                .map(event => event.content)
                .find(test => test.meta[TEST_NAME] ===
                  'disabled serial retry uploads screenshot after disabled sibling')

              assert.ok(failedTest)
              assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOADED], 'true')
              assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], undefined)
              assert.strictEqual(mediaPayloads.length, 1)
            },
            { hardTimeout: PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT }
          )

          const [[exitCode]] = await Promise.all([once(proc, 'exit'), payloadsPromise])
          assert.strictEqual(exitCode, 1)
        })
      }

      it('fails if disable is not enabled', async (receiver) => {
        receiver.setTestManagementTests(DISABLED_MANAGEMENT_TESTS)
        receiver.setSettings({ test_management: { enabled: false } })
        await runDisableTest(receiver, false)
      })

      it('does not enable disable tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async (receiver) => {
        receiver.setTestManagementTests(DISABLED_MANAGEMENT_TESTS)
        receiver.setSettings({ test_management: { enabled: true } })
        await runDisableTest(receiver, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
      })
    })

    context('quarantine', () => {
      const getTestAssertions = (receiver, {
        isQuarantining,
        hasFlakyTests,
        expectedQuarantinedTestCount,
      }) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content

            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const flakyTests = tests.filter(test => test.meta[TEST_NAME] === 'flaky should be flaky')
            const quarantinedTests = tests.filter(
              test => test.meta[TEST_NAME] === 'quarantine should quarantine failed test'
            )

            quarantinedTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            })

            if (hasFlakyTests) {
              assert.strictEqual(flakyTests.length, 2) // first attempt fails, second attempt passes
              assert.strictEqual(quarantinedTests.length, 2) // both fail
              assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in flakyTests[0].meta))
              assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in flakyTests[1].meta))
              const failedFlakyTest = flakyTests.filter(test => test.meta[TEST_STATUS] === 'fail')
              const passedFlakyTest = flakyTests.filter(test => test.meta[TEST_STATUS] === 'pass')
              assert.strictEqual(failedFlakyTest.length, 1)
              assert.strictEqual(passedFlakyTest.length, 1)
            }

            if (isQuarantining) {
              if (hasFlakyTests) {
                assert.strictEqual(quarantinedTests[1].meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              } else {
                assert.strictEqual(quarantinedTests.length, expectedQuarantinedTestCount)
              }
              assert.strictEqual(quarantinedTests[0].meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              assertObjectContains(testSession.meta, {
                [TEST_MANAGEMENT_ENABLED]: 'true',
              })
            } else {
              if (hasFlakyTests) {
                assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in quarantinedTests[1].meta))
              } else {
                assert.strictEqual(quarantinedTests.length, 1)
              }
              assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in quarantinedTests[0].meta))
              assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
            }
          }, PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT)

      /**
       * @param {import('../ci-visibility-intake').FakeCiVisIntake} receiver
       * @param {{
       *   isQuarantining?: boolean,
       *   extraEnvVars?: Record<string, string>,
       *   cliArgs?: string,
       *   hasFlakyTests?: boolean,
       *   expectedQuarantinedTestCount?: number
       * }} options
       */
      const runQuarantineTest = async (receiver, {
        isQuarantining,
        extraEnvVars,
        cliArgs = 'quarantine-test.js',
        hasFlakyTests = false,
        expectedQuarantinedTestCount = 1,
      }) => {
        const testAssertionsPromise = getTestAssertions(receiver, {
          isQuarantining,
          hasFlakyTests,
          expectedQuarantinedTestCount,
        })
        let testOutput = ''
        let proc
        try {
          proc = exec(
            `./node_modules/.bin/playwright test -c playwright.config.js ${cliArgs}`,
            {
              cwd: runtime.cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${runtime.webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
                ...extraEnvVars,
              },
            }
          )
          proc.stdout?.on('data', chunk => { testOutput += chunk.toString() })
          proc.stderr?.on('data', chunk => { testOutput += chunk.toString() })

          const [[exitCode]] = await Promise.all([
            once(proc, 'exit'),
            testAssertionsPromise,
          ])

          if (isQuarantining) {
            assert.match(
              testOutput,
              /Quarantined: \d+ tests? run; \d+ failures? did not affect the test session\./
            )
            assert.strictEqual(exitCode, 0)
          } else {
            assert.strictEqual(exitCode, 1)
          }
        } finally {
          proc?.kill()
        }
      }

      it('can quarantine tests', async (receiver) => {
        receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
        receiver.setSettings({ test_management: { enabled: true } })
        await runQuarantineTest(receiver, { isQuarantining: true })
      })

      it('can quarantine each repeated test instance', async (receiver) => {
        receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
        receiver.setSettings({ test_management: { enabled: true } })
        await runQuarantineTest(receiver, {
          isQuarantining: true,
          cliArgs: 'quarantine-test.js --repeat-each=2',
          expectedQuarantinedTestCount: 2,
        })
      })

      it('can quarantine tests when there are other flaky tests retried with --retries', async (receiver) => {
        receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
        receiver.setSettings({ test_management: { enabled: true } })
        await runQuarantineTest(receiver, {
          isQuarantining: true,
          cliArgs: 'quarantine-test.js quarantine-2-test.js --retries=1',
          hasFlakyTests: true,
        })
      })

      it('can quarantine tests when there are other flaky tests retried with ATR', async (receiver) => {
        receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
        receiver.setSettings({
          test_management: { enabled: true },
          flaky_test_retries_enabled: true,
        })
        await runQuarantineTest(receiver, {
          isQuarantining: true,
          cliArgs: 'quarantine-test.js quarantine-2-test.js',
          hasFlakyTests: true,
          extraEnvVars: { DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1' },
        })
      })

      const runQuarantineMustFailTest = async (receiver, {
        cliArgs = 'quarantine-test.js',
        extraEnvVars,
      }) => {
        receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
        receiver.setSettings({ test_management: { enabled: true } })

        let testOutput = ''
        let proc
        try {
          proc = exec(
            `./node_modules/.bin/playwright test -c playwright.config.js ${cliArgs}`,
            {
              cwd: runtime.cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${runtime.webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
                ...extraEnvVars,
              },
            }
          )
          proc.stdout?.on('data', data => { testOutput += data.toString() })
          proc.stderr?.on('data', data => { testOutput += data.toString() })

          const eventsPromise = receiver
            .gatherPayloadsUntilChildExit(proc, ({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content

              assert.strictEqual(testSession.meta[TEST_STATUS], 'fail', testOutput)
            }, { hardTimeout: PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT })

          const [[exitCode]] = await Promise.all([
            once(proc, 'exit'),
            once(proc.stdout, 'end'),
            once(proc.stderr, 'end'),
            eventsPromise,
          ])
          assert.strictEqual(exitCode, 1, testOutput)
        } finally {
          proc?.kill()
        }
      }

      for (const hook of ['BEFORE', 'AFTER']) {
        it(`does not quarantine a ${hook.toLowerCase()}All failure in the quarantined suite`, async (receiver) => {
          await runQuarantineMustFailTest(receiver, {
            extraEnvVars: { [`FAIL_QUARANTINE_${hook}_ALL`]: '1' },
          })
        })
      }

      it('does not quarantine an expected failure that unexpectedly passes', async (receiver) => {
        await runQuarantineMustFailTest(receiver, {
          extraEnvVars: { EXPECTED_FAILURE_PASSES: '1' },
        })
      })

      if (version === 'latest' || satisfies(version, '>=1.52.0')) {
        it('does not quarantine a failure caused by failOnFlakyTests', async (receiver) => {
          await runQuarantineMustFailTest(receiver, {
            cliArgs: 'quarantine-test.js attempt-to-fix-test.js --retries=1',
            extraEnvVars: {
              FAIL_ON_FLAKY_TESTS: '1',
              SHOULD_ALWAYS_PASS: '1',
              SHOULD_INCLUDE_FLAKY_TEST: '1',
            },
          })
        })
      }

      const runEfdQuarantineTest = async (receiver, {
        durationRetryCount = 3,
        shouldUseCustomReporter = false,
        shouldFailBeforeAll = false,
        shouldFailGlobalTeardown = false,
        shouldReachMaxFailures = false,
        shouldPassRetries = false,
        shouldIncludeDisabledAttemptToFix = false,
      } = {}) => {
        const numRetries = 3
        receiver.setKnownTests({ playwright: {} })
        receiver.setTestManagementTests(shouldIncludeDisabledAttemptToFix
          ? QUARANTINE_WITH_DISABLED_ATF_MANAGEMENT_TESTS
          : QUARANTINE_MANAGEMENT_TESTS)
        receiver.setSettings({
          known_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': durationRetryCount,
              '10s': durationRetryCount,
              '30s': durationRetryCount,
              '5m': numRetries,
            },
            faulty_session_threshold: 100,
          },
          test_management: {
            enabled: true,
            ...(shouldIncludeDisabledAttemptToFix ? { attempt_to_fix_retries: 0 } : {}),
          },
        })

        let testOutput = ''
        let proc
        try {
          proc = exec(
            './node_modules/.bin/playwright test -c playwright.config.js quarantine-test.js ' +
              (shouldFailBeforeAll ? 'failing-before-all-test.js ' : '') +
              (shouldReachMaxFailures ? 'zzz-passing-test.js' : ''),
            {
              cwd: runtime.cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                ...(shouldUseCustomReporter ? { PLAYWRIGHT_FROZEN_REPORTER: '1' } : {}),
                ...(shouldFailGlobalTeardown ? { FAIL_GLOBAL_TEARDOWN: '1' } : {}),
                ...(shouldReachMaxFailures ? { MAX_FAILURES: '1', PLAYWRIGHT_WORKERS: '1' } : {}),
                PW_BASE_URL: `http://localhost:${runtime.webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
                ...(shouldPassRetries ? { SHOULD_PASS_EFD_RETRIES: '1' } : {}),
              },
            }
          )
          proc.stdout?.on('data', data => { testOutput += data.toString() })
          proc.stderr?.on('data', data => { testOutput += data.toString() })
          const eventsPromise = receiver
            .gatherPayloadsUntilChildExit(proc, ({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              const allTests = events
                .filter(event => event.type === 'test')
                .map(event => event.content)
              const tests = allTests
                .filter(test => test.meta[TEST_NAME] === 'quarantine should quarantine failed test')

              assert.strictEqual(
                testSession.meta[TEST_STATUS],
                shouldFailBeforeAll || shouldFailGlobalTeardown || shouldReachMaxFailures ? 'fail' : 'pass'
              )
              if (shouldReachMaxFailures) {
                assert.ok(tests.length >= 1 && tests.length <= numRetries + 1)
                assert.ok(tests.some(test => test.meta[TEST_STATUS] === 'fail'))
              } else {
                assert.strictEqual(tests.length, durationRetryCount + 1)
                assert.strictEqual(
                  tests.filter(test => test.meta[TEST_STATUS] === 'fail').length,
                  shouldPassRetries ? 1 : durationRetryCount + 1
                )
                assert.strictEqual(
                  tests.filter(test => test.meta[TEST_STATUS] === 'pass').length,
                  shouldPassRetries ? durationRetryCount : 0
                )
              }
              for (const test of tests) {
                assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              }
              if (shouldIncludeDisabledAttemptToFix) {
                const disabledAttemptToFixTests = allTests.filter(
                  test => test.meta[TEST_NAME] === 'should run unless max failures is reached'
                )
                assert.strictEqual(disabledAttemptToFixTests.length, 1)
                assert.strictEqual(disabledAttemptToFixTests[0].meta[TEST_STATUS], 'skip')
                assert.strictEqual(disabledAttemptToFixTests[0].meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
                assert.strictEqual(disabledAttemptToFixTests[0].meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
              }

              const retries = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
              assert.ok(retries.every(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd))

              const finalTests = tests.filter(test => TEST_FINAL_STATUS in test.meta)
              if (!shouldReachMaxFailures) {
                assert.strictEqual(retries.length, durationRetryCount)
                assert.strictEqual(finalTests.length, 1)
                assert.strictEqual(finalTests[0].meta[TEST_FINAL_STATUS], 'skip')
                assert.strictEqual(
                  finalTests[0].meta[TEST_EARLY_FLAKE_ABORT_REASON],
                  durationRetryCount === 0 ? 'slow' : undefined
                )
              }
            }, { hardTimeout: PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT })

          const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
          assert.match(testOutput, /Quarantined: 1 test run; 1 failure did not affect the test session\./)
          const shouldFail = shouldFailBeforeAll || shouldFailGlobalTeardown || shouldReachMaxFailures
          assert.strictEqual(exitCode, shouldFail ? 1 : 0, testOutput)
        } finally {
          proc?.kill()
        }
      }

      it('can quarantine a new test when all EFD attempts fail', async (receiver) => {
        await runEfdQuarantineTest(receiver)
      })

      it('ignores EFD clones outside a quarantined test retry budget', async (receiver) => {
        await runEfdQuarantineTest(receiver, { durationRetryCount: 1 })
      })

      it('ignores EFD clones after a quarantined test aborts slow retries', async (receiver) => {
        await runEfdQuarantineTest(receiver, { durationRetryCount: 0 })
      })

      it('can quarantine a new test with a custom reporter', async (receiver) => {
        await runEfdQuarantineTest(receiver, { shouldUseCustomReporter: true })
      })

      it('can quarantine a new test when an EFD retry passes', async (receiver) => {
        await runEfdQuarantineTest(receiver, { shouldPassRetries: true })
      })

      it('does not quarantine an independent hook failure when an EFD retry passes', async (receiver) => {
        await runEfdQuarantineTest(receiver, { shouldFailBeforeAll: true, shouldPassRetries: true })
      })

      it('does not quarantine a global teardown failure when an EFD retry passes', async (receiver) => {
        await runEfdQuarantineTest(receiver, { shouldFailGlobalTeardown: true, shouldPassRetries: true })
      })

      it('does not quarantine tests skipped after max failures is reached', async (receiver) => {
        await runEfdQuarantineTest(receiver, { shouldReachMaxFailures: true })
      })

      it('does not quarantine disabled attempt to fix tests skipped after max failures', async (receiver) => {
        await runEfdQuarantineTest(receiver, {
          shouldReachMaxFailures: true,
          shouldIncludeDisabledAttemptToFix: true,
        })
      })

      it('quarantines failures when a hook passes on a native retry', async (receiver) => {
        receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
        receiver.setSettings({ test_management: { enabled: true } })

        let testOutput = ''
        let proc
        try {
          proc = exec(
            './node_modules/.bin/playwright test -c playwright.config.js ' +
              'quarantine-test.js flaky-before-all-test.js --retries=1',
            {
              cwd: runtime.cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${runtime.webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
              },
            }
          )
          proc.stdout?.on('data', data => { testOutput += data.toString() })
          proc.stderr?.on('data', data => { testOutput += data.toString() })
          const eventsPromise = receiver
            .gatherPayloadsUntilChildExit(proc, ({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content

              assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
            }, { hardTimeout: PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT })

          const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
          assert.strictEqual(exitCode, 0, testOutput)
        } finally {
          proc?.kill()
        }
      })

      it('does not quarantine an independent hook failure when a native retry passes', async (receiver) => {
        receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
        receiver.setSettings({ test_management: { enabled: true } })

        let testOutput = ''
        let proc
        try {
          proc = exec(
            './node_modules/.bin/playwright test -c playwright.config.js ' +
              'quarantine-test.js failing-before-all-test.js --retries=1',
            {
              cwd: runtime.cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${runtime.webAppPort}`,
                SHOULD_PASS_NATIVE_RETRIES: '1',
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
              },
            }
          )
          proc.stdout?.on('data', data => { testOutput += data.toString() })
          proc.stderr?.on('data', data => { testOutput += data.toString() })
          const eventsPromise = receiver
            .gatherPayloadsUntilChildExit(proc, ({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              const tests = events
                .filter(event => event.type === 'test')
                .map(event => event.content)
                .filter(test => test.meta[TEST_NAME] === 'quarantine should quarantine failed test')

              assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
              assert.strictEqual(tests.length, 2)
              assert.strictEqual(tests.filter(test => test.meta[TEST_STATUS] === 'fail').length, 1)
              assert.strictEqual(tests.filter(test => test.meta[TEST_STATUS] === 'pass').length, 1)
              for (const test of tests) {
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              }
            }, { hardTimeout: PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT })

          const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
          assert.strictEqual(exitCode, 1, testOutput)
        } finally {
          proc?.kill()
        }
      })

      it('fails if quarantine is not enabled', async (receiver) => {
        receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
        receiver.setSettings({ test_management: { enabled: false } })
        await runQuarantineTest(receiver, { isQuarantining: false })
      })

      it('does not enable quarantine tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async (receiver) => {
        receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
        receiver.setSettings({ test_management: { enabled: true } })
        await runQuarantineTest(
          receiver,
          { isQuarantining: false, extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } }
        )
      })
    })
  })
})
