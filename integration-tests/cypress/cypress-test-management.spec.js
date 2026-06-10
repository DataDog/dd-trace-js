'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const semver = require('semver')
const {
  sandboxCwd,
  useSandbox,
  getCiVisEvpProxyConfig,
  assertObjectContains,
  stopCiVisTestEnv,
  warmCypressBinary,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { startWebAppServer, stopWebAppServer } = require('../ci-visibility/web-app-server')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')
const {
  TEST_STATUS,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_RETRY_REASON,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_NAME,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_RETRY_REASON_TYPES,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')

const requestedVersion = process.env.CYPRESS_VERSION
const oldestVersion = DD_MAJOR >= 6 ? '12.0.0' : '6.7.0'
const version = requestedVersion === 'oldest' ? oldestVersion : requestedVersion
const hookFile = 'dd-trace/loader-hook.mjs'
const over12It = (version === 'latest' || semver.gte(version, '12.0.0')) ? it : it.skip
const MINIMUM_ATTEMPT_TO_FIX_RETRIES = 1

function shouldTestsRun (type) {
  if (DD_MAJOR === 5) {
    if (NODE_MAJOR <= 16) {
      return version === '6.7.0' && type === 'commonJS'
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      if (NODE_MAJOR <= 18) {
        return version === '12.0.0' || version === '14.5.4'
      }
      return version === '12.0.0' || version === '14.5.4' || version === 'latest'
    }
  }
  if (DD_MAJOR === 6) {
    if (NODE_MAJOR <= 16) {
      return false
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      if (NODE_MAJOR <= 18) {
        return version === '12.0.0' || version === '14.5.4'
      }
      return version === '12.0.0' || version === '14.5.4' || version === 'latest'
    }
  }
  return false
}

const moduleTypes = [
  {
    type: 'commonJS',
    testCommand: function commandWithSuffic (version) {
      const commandSuffix = version === '6.7.0' ? '--config-file cypress-config.json --spec "cypress/e2e/*.cy.js"' : ''
      return `./node_modules/.bin/cypress run ${commandSuffix}`
    },
  },
  {
    type: 'esm',
    testCommand: `node --loader=${hookFile} ./cypress-esm-config.mjs`,
  },
].filter(moduleType => !process.env.CYPRESS_MODULE_TYPE || process.env.CYPRESS_MODULE_TYPE === moduleType.type)

moduleTypes.forEach(({
  type,
  testCommand,
}) => {
  if (typeof testCommand === 'function') {
    testCommand = testCommand(version)
  }

  describe(`cypress@${version} ${type}`, function () {
    if (!shouldTestsRun(type)) {
      // eslint-disable-next-line no-console
      console.log(`Skipping tests for cypress@${version} ${type} for dd-trace@${DD_MAJOR} node@${NODE_MAJOR}`)
      return
    }

    this.timeout(80_000)
    let cwd, receiver, childProcess, webAppBaseUrl, webAppServer, secondWebAppBaseUrl, secondWebAppServer

    // cypress-fail-fast is required as an incompatible plugin.
    // typescript is required to compile .cy.ts spec files in the pre-compiled JS tests.
    useSandbox([`cypress@${version}`, 'cypress-fail-fast@7.1.0', 'typescript'], true)

    before(async function () {
      this.timeout(180_000)
      cwd = sandboxCwd()
      await warmCypressBinary(cwd)

      const webApp = await startWebAppServer()
      webAppBaseUrl = webApp.baseUrl
      webAppServer = webApp.server

      if (version === 'latest') {
        const secondWebApp = await startWebAppServer({
          body: '<div class="hella-world">Hella World</div>',
          includeCoverage: false,
          includeRum: false,
          title: 'Hella World',
        })
        secondWebAppBaseUrl = secondWebApp.baseUrl
        secondWebAppServer = secondWebApp.server
      }
    })

    after(async () => {
      await stopWebAppServer(secondWebAppServer)
      await stopWebAppServer(webAppServer)
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      await stopCiVisTestEnv({ childProcess, receiver })
      childProcess = undefined
    })

    context('known tests without early flake detection', () => {
      it('detects new tests without retrying them', async () => {
        receiver.setSettings({
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          cypress: {
            'cypress/e2e/spec.cy.js': [
              // 'context passes', // This test will be considered new
              'other context fails',
            ],
          },
        })

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/spec.cy.js'
        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              SPEC_PATTERN: specToRun,
              DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false',
            },
          }
        )

        await receiver.gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 2)

            // new tests are detected but not retried
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 1)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
          }
        )
      })
    })

    // cy.origin is not available in old versions of Cypress
    if (version === 'latest') {
      it('does not crash for multi origin tests', async () => {
        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/multi-origin.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              CYPRESS_BASE_URL_SECOND: secondWebAppBaseUrl,
              SPEC_PATTERN: specToRun,
              DD_TRACE_DEBUG: 'true',
            },
          }
        )

        await Promise.all([
          once(childProcess.stdout, 'end'),
          once(childProcess.stderr, 'end'),
          // cypress@latest esm + multi-origin browser context switching adds cold-start overhead
          // that the suite-level `warmCypressBinary` (commonJS path) doesn't reach, so this one
          // child run takes measurably longer than the rest of the suite and earns its own backstop.
          receiver.gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
                .filter(event => event.type !== 'span')
              assert.strictEqual(events.length, 4)

              const test = events.find(event => event.type === 'test').content
              assert.strictEqual(test.resource, 'cypress/e2e/multi-origin.js.tests multiple origins')
              assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            },
            { hardTimeout: 50_000 }
          ),
        ])
      })
    }

    it('sets _dd.test.is_user_provided_service to true if DD_SERVICE is used', async () => {
      const envVars = getCiVisEvpProxyConfig(receiver.port)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            DD_SERVICE: 'my-service',
            SPEC_PATTERN: 'cypress/e2e/spec.cy.js',
          },
        }
      )

      await receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')

          testEvents.forEach(({ content: { meta } }) => {
            assert.strictEqual(meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'true')
          })
        }
      )
    })

    context('test management', () => {
      context('attempt to fix', () => {
        beforeEach(() => {
          receiver.setTestManagementTests({
            cypress: {
              suites: {
                'cypress/e2e/attempt-to-fix.js': {
                  tests: {
                    'attempt to fix is attempt to fix': {
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

        const awaitTestAssertions = ({
          isAttemptToFix,
          shouldAlwaysPass,
          shouldFailSometimes,
          isQuarantined,
          isDisabled,
          attemptToFixRetries = MINIMUM_ATTEMPT_TO_FIX_RETRIES,
        }, child) =>
          receiver
            .gatherPayloadsUntilChildExit(child, ({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
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
                  'cypress/e2e/attempt-to-fix.js.attempt to fix is attempt to fix',
                ]
              )

              const attemptToFixTests = tests.filter(
                test => test.meta[TEST_NAME] === 'attempt to fix is attempt to fix'
              )

              if (isAttemptToFix) {
                assert.strictEqual(attemptToFixTests.length, attemptToFixRetries + 1)
              } else {
                assert.strictEqual(attemptToFixTests.length, 1)
              }

              for (let i = attemptToFixTests.length - 1; i >= 0; i--) {
                const test = attemptToFixTests[i]
                if (!isAttemptToFix) {
                  assert.ok(!(TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX in test.meta))
                  assert.ok(!(TEST_IS_RETRY in test.meta))
                  assert.ok(!(TEST_RETRY_REASON in test.meta))
                  continue
                }
                if (isQuarantined) {
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
                  assert.notStrictEqual(test.meta[TEST_STATUS], 'skip')
                }
                if (isDisabled) {
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
                  assert.notStrictEqual(test.meta[TEST_STATUS], 'skip')
                }

                const isLastAttempt = i === attemptToFixTests.length - 1
                const isFirstAttempt = i === 0
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
                if (isFirstAttempt) {
                  assert.ok(!(TEST_IS_RETRY in test.meta))
                  assert.ok(!(TEST_RETRY_REASON in test.meta))
                } else {
                  assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                  assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
                }
                if (isLastAttempt) {
                  if (shouldFailSometimes) {
                    assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                  } else if (shouldAlwaysPass) {
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
                    assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                  } else {
                    assert.strictEqual(test.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                  }
                }
              }
            })

        /**
         * @param {{
         *   isAttemptToFix?: boolean,
         *   shouldAlwaysPass?: boolean,
         *   shouldFailSometimes?: boolean,
         *   isQuarantined?: boolean,
         *   isDisabled?: boolean,
         *   attemptToFixRetries?: number,
         *   extraEnvVars?: Record<string, string>
         * }} [options]
         */
        const runAttemptToFixTest = async ({
          isAttemptToFix,
          shouldAlwaysPass,
          shouldFailSometimes,
          isQuarantined,
          isDisabled,
          attemptToFixRetries = MINIMUM_ATTEMPT_TO_FIX_RETRIES,
          extraEnvVars = {},
        } = {}) => {
          let stdout = ''

          const envVars = getCiVisEvpProxyConfig(receiver.port)

          const specToRun = 'cypress/e2e/attempt-to-fix.js'

          childProcess = exec(
            version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
            {
              cwd,
              env: {
                ...envVars,
                CYPRESS_BASE_URL: webAppBaseUrl,
                SPEC_PATTERN: specToRun,
                ...extraEnvVars,
                ...(shouldAlwaysPass ? { CYPRESS_SHOULD_ALWAYS_PASS: '1' } : {}),
                ...(shouldFailSometimes ? { CYPRESS_SHOULD_FAIL_SOMETIMES: '1' } : {}),
              },
            }
          )

          childProcess.stdout?.on('data', data => {
            stdout += data
            process.stdout.write(data)
          })
          childProcess.stderr?.on('data', data => {
            stdout += data
            process.stderr.write(data)
          })

          await awaitTestAssertions({
            isAttemptToFix,
            shouldAlwaysPass,
            shouldFailSometimes,
            isQuarantined,
            isDisabled,
            attemptToFixRetries,
          }, childProcess)

          if (isAttemptToFix) {
            assert.match(stdout, /Datadog Test Optimization: attempting to fix .*attempt to fix is attempt to fix/)
            assert.strictEqual(
              (stdout.match(
                /Datadog Test Optimization: attempting to fix .*attempt to fix is attempt to fix/g
              ) || []).length,
              1
            )
            assert.match(stdout, /Datadog Test Optimization/)
            if (shouldAlwaysPass) {
              assert.match(stdout, /Attempt to fix passed/)
            } else {
              assert.match(stdout, /Attempt to fix failed/)
              assert.doesNotMatch(stdout, /execution(?:s)? [\d, -]+:/)
            }
            if (isQuarantined || isDisabled) {
              assert.doesNotMatch(stdout, /Errors are suppressed because this test is/)
            }
            if (isQuarantined) {
              assert.match(
                stdout,
                /Test was marked as quarantined but was not quarantined because it is attempt to fix\./
              )
            }
            if (isDisabled) {
              assert.match(
                stdout,
                /Test was marked as disabled but was run because it is attempt to fix\./
              )
            }
          }

          if (shouldAlwaysPass) {
            assert.strictEqual(childProcess.exitCode, 0)
          } else {
            assert.strictEqual(childProcess.exitCode, 1)
          }
        }

        it('can attempt to fix and mark last attempt as failed if every attempt fails', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: MINIMUM_ATTEMPT_TO_FIX_RETRIES },
            flaky_test_retries_enabled: false,
          })

          await runAttemptToFixTest({ isAttemptToFix: true, extraEnvVars: { CYPRESS_RETRIES: '1' } })
        })

        it('can attempt to fix and mark last attempt as passed if every attempt passes', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: MINIMUM_ATTEMPT_TO_FIX_RETRIES },
          })

          await runAttemptToFixTest({ isAttemptToFix: true, shouldAlwaysPass: true })
        })

        it('can attempt to fix and not mark last attempt if attempts both pass and fail', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: MINIMUM_ATTEMPT_TO_FIX_RETRIES },
          })

          await runAttemptToFixTest({ isAttemptToFix: true, shouldFailSometimes: true })
        })

        it('keeps after hook failures on attempt to fix tests', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: MINIMUM_ATTEMPT_TO_FIX_RETRIES },
          })
          receiver.setTestManagementTests({
            cypress: {
              suites: {
                'cypress/e2e/attempt-to-fix-after-hook.js': {
                  tests: {
                    'attempt to fix after hook passes before after hook fails': {
                      properties: {
                        attempt_to_fix: true,
                      },
                    },
                  },
                },
              },
            },
          })

          const envVars = getCiVisEvpProxyConfig(receiver.port)
          const specToRun = 'cypress/e2e/attempt-to-fix-after-hook.js'

          childProcess = exec(
            version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
            {
              cwd,
              env: {
                ...envVars,
                CYPRESS_BASE_URL: webAppBaseUrl,
                SPEC_PATTERN: specToRun,
              },
            }
          )

          await receiver.gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const attemptToFixTests = tests
                .filter(test => test.meta[TEST_NAME] === 'attempt to fix after hook passes before after hook fails')
                .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

              assert.strictEqual(attemptToFixTests.length, MINIMUM_ATTEMPT_TO_FIX_RETRIES + 1)

              const lastAttempt = attemptToFixTests[attemptToFixTests.length - 1]
              assert.strictEqual(lastAttempt.meta[TEST_STATUS], 'fail')
              assert.match(lastAttempt.meta[ERROR_MESSAGE], /error in after hook/)
              assert.strictEqual(lastAttempt.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
            }
          )

          assert.strictEqual(childProcess.exitCode, 1)
        })

        it('does not attempt to fix tests if test management is not enabled', async () => {
          receiver.setSettings({
            test_management: { enabled: false, attempt_to_fix_retries: MINIMUM_ATTEMPT_TO_FIX_RETRIES },
          })

          await runAttemptToFixTest()
        })

        it('does not enable attempt to fix tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: MINIMUM_ATTEMPT_TO_FIX_RETRIES },
          })

          await runAttemptToFixTest({ extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } })
        })

        it('does not tag known attempt to fix tests as new', async () => {
          receiver.setKnownTests({
            cypress: {
              'cypress/e2e/attempt-to-fix.js': [
                'attempt to fix is attempt to fix',
              ],
            },
          })
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: MINIMUM_ATTEMPT_TO_FIX_RETRIES },
            early_flake_detection: {
              enabled: true,
              slow_test_retries: { '5s': 1 },
              faulty_session_threshold: 100,
            },
            known_tests_enabled: true,
          })

          const envVars = getCiVisEvpProxyConfig(receiver.port)
          const specToRun = 'cypress/e2e/attempt-to-fix.js'

          childProcess = exec(
            version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
            {
              cwd,
              env: {
                ...envVars,
                CYPRESS_BASE_URL: webAppBaseUrl,
                SPEC_PATTERN: specToRun,
                CYPRESS_SHOULD_ALWAYS_PASS: '1',
              },
            }
          )

          await receiver.gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
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
            }
          )
        })

        it('ignores quarantine when attempting to fix a test', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: MINIMUM_ATTEMPT_TO_FIX_RETRIES },
          })
          receiver.setTestManagementTests({
            cypress: {
              suites: {
                'cypress/e2e/attempt-to-fix.js': {
                  tests: {
                    'attempt to fix is attempt to fix': {
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

          await runAttemptToFixTest({ isAttemptToFix: true, isQuarantined: true })
        })

        it('ignores disabled when attempting to fix a test', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: MINIMUM_ATTEMPT_TO_FIX_RETRIES },
          })
          receiver.setTestManagementTests({
            cypress: {
              suites: {
                'cypress/e2e/attempt-to-fix.js': {
                  tests: {
                    'attempt to fix is attempt to fix': {
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

          await runAttemptToFixTest({ isAttemptToFix: true, isDisabled: true })
        })
      })

      context('disabled and quarantine', () => {
        beforeEach(() => {
          receiver.setTestManagementTests({
            cypress: {
              suites: {
                'cypress/e2e/disable.js': {
                  tests: {
                    'disable is disabled': {
                      properties: {
                        disabled: true,
                      },
                    },
                  },
                },
                'cypress/e2e/quarantine.js': {
                  tests: {
                    'quarantine is quarantined': {
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

        const awaitTestAssertions = (isManagingTests, child) =>
          receiver
            .gatherPayloadsUntilChildExit(child, ({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const testSession = events.find(event => event.type === 'test_session_end').content
              const disabledTest = tests.find(test => test.resource === 'cypress/e2e/disable.js.disable is disabled')
              const quarantinedTest = tests.find(
                test => test.resource === 'cypress/e2e/quarantine.js.quarantine is quarantined'
              )

              assert.ok(disabledTest, 'disabled test should be reported')
              assert.ok(quarantinedTest, 'quarantined test should be reported')

              if (isManagingTests) {
                assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
                // Session status should be 'pass' because Cypress sees the quarantined test as passed
                assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
              } else {
                assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
                assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
              }

              if (isManagingTests) {
                assert.strictEqual(disabledTest.meta[TEST_STATUS], 'skip')
                assert.strictEqual(disabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
                // Quarantined tests run normally but their failures are suppressed by Cypress.on('fail')
                // in support.js. The test actually fails (reports 'fail' to Datadog) but Cypress sees
                // it as passed, so the exit code is 0.
                assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
                assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              } else {
                assert.strictEqual(disabledTest.meta[TEST_STATUS], 'fail')
                assert.ok(!(TEST_MANAGEMENT_IS_DISABLED in disabledTest.meta))
                assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
                assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in quarantinedTest.meta))
              }
            })

        const runDisableAndQuarantineTest = async (isManagingTests, extraEnvVars = {}) => {
          const envVars = getCiVisEvpProxyConfig(receiver.port)

          const specToRun = 'cypress/e2e/{disable,quarantine}.js'

          childProcess = exec(
            version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
            {
              cwd,
              env: {
                ...envVars,
                CYPRESS_BASE_URL: webAppBaseUrl,
                SPEC_PATTERN: specToRun,
                ...extraEnvVars,
              },
            }
          )

          await awaitTestAssertions(isManagingTests, childProcess)

          if (isManagingTests) {
            assert.strictEqual(childProcess.exitCode, 0)
          } else {
            assert.strictEqual(childProcess.exitCode, type === 'esm' ? 1 : 2)
          }
        }

        it('can disable and quarantine tests', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runDisableAndQuarantineTest(true)
        })

        it('does not disable or quarantine tests if test management is not enabled', async () => {
          receiver.setSettings({ test_management: { enabled: false } })

          await runDisableAndQuarantineTest(false)
        })

        it('does not disable or quarantine tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runDisableAndQuarantineTest(false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
        })
      })

      it('does not crash if the request to get test management tests fails', async () => {
        receiver.setSettings({
          test_management: { enabled: true },
          flaky_test_retries_enabled: false,
        })
        receiver.setTestManagementTestsResponseCode(404)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/attempt-to-fix.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              SPEC_PATTERN: specToRun,
              DD_TRACE_DEBUG: '1',
            },
          }
        )

        await receiver.gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSessionEnd = events.find(event => event.type === 'test_session_end')
            assert.ok(testSessionEnd, 'expected test_session_end event in payloads')
            const testSession = testSessionEnd.content
            assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            // it is not retried
            assert.strictEqual(tests.length, 1)
          }
        )
      })

      over12It('does not retry attempt to fix tests when testIsolation is false', async () => {
        receiver.setSettings({
          test_management: { enabled: true },
        })

        receiver.setTestManagementTests({
          cypress: {
            suites: {
              'cypress/e2e/attempt-to-fix.js': {
                tests: {
                  'attempt to fix is attempt to fix': {
                    properties: {
                      attempt_to_fix: true,
                    },
                  },
                },
              },
            },
          },
        })

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/attempt-to-fix.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              SPEC_PATTERN: specToRun,
              CYPRESS_SHOULD_ALWAYS_PASS: '1',
              CYPRESS_TEST_ISOLATION: 'false',
            },
          }
        )

        await receiver.gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            assertObjectContains(testSession.meta, {
              [TEST_MANAGEMENT_ENABLED]: 'true',
            })

            const attemptToFixTests = tests.filter(
              test => test.meta[TEST_NAME] === 'attempt to fix is attempt to fix'
            )

            // Should only have 1 test, no retries when testIsolation is false
            assert.equal(attemptToFixTests.length, 1)

            attemptToFixTests.forEach(test => {
              // No retries should occur
              assert.ok(!(TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX in test.meta))
              assert.ok(!(TEST_IS_RETRY in test.meta))
              assert.ok(!(TEST_RETRY_REASON in test.meta))
            })
          }
        )
      })

      it('retries attempt to fix tests in the correct order (right after original test)', async () => {
        let testOutput = ''
        receiver.setSettings({
          test_management: {
            enabled: true,
            attempt_to_fix_retries: MINIMUM_ATTEMPT_TO_FIX_RETRIES,
          },
        })

        receiver.setTestManagementTests({
          cypress: {
            suites: {
              'cypress/e2e/attempt-to-fix-order.js': {
                tests: {
                  'attempt to fix order second test': {
                    properties: {
                      attempt_to_fix: true,
                    },
                  },
                  // 'first test' and 'third test' won't be retried
                },
              },
            },
          },
        })

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/attempt-to-fix-order.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              SPEC_PATTERN: specToRun,
            },
          }
        )

        childProcess.stdout?.on('data', (data) => {
          testOutput += data.toString()
        })
        childProcess.stderr?.on('data', (data) => {
          testOutput += data.toString()
        })

        await Promise.all([
          once(childProcess.stdout, 'end'),
          once(childProcess.stderr, 'end'),
          receiver.gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              // 1 test with attempt to fix (1 original + 1 retry) + 2 tests without = 4 tests total
              assert.equal(tests.length, 4)

              // Extract test execution order with full details
              const testExecutionOrder = tests.map(test => ({
                name: test.meta[TEST_NAME],
                isRetry: test.meta[TEST_IS_RETRY] === 'true',
                isAttemptToFix: test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] === 'true',
              }))

              // Expected order:
              // 1. "first test" (original, no retries)
              // 2. "second test" (original)
              // 3. "second test" (retry 1)
              // 4. "third test" (original, no retries)

              assertObjectContains(testExecutionOrder, [
                { name: 'attempt to fix order first test', isRetry: false, isAttemptToFix: false },
                { name: 'attempt to fix order second test', isRetry: false, isAttemptToFix: true },
                { name: 'attempt to fix order second test', isRetry: true, isAttemptToFix: true },
                { name: 'attempt to fix order third test', isRetry: false, isAttemptToFix: false },
              ])

              const testSession = events.find(event => event.type === 'test_session_end').content
              assertObjectContains(testSession.meta, {
                [TEST_MANAGEMENT_ENABLED]: 'true',
              })
            }
          ),
        ])

        assert.match(testOutput, /Retrying "attempt to fix order second test" because it is an attempt to fix/)
      })
    })
  })
})
