'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const http = require('node:http')

const semver = require('semver')
const {
  sandboxCwd,
  useSandbox,
  getCiVisEvpProxyConfig,
  assertObjectContains,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
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

const RECEIVER_STOP_TIMEOUT = 20000
const version = process.env.CYPRESS_VERSION
const hookFile = 'dd-trace/loader-hook.mjs'
const over12It = (version === 'latest' || semver.gte(version, '12.0.0')) ? it : it.skip

function shouldTestsRun (type) {
  if (DD_MAJOR === 5) {
    if (NODE_MAJOR <= 16) {
      return version === '6.7.0' && type === 'commonJS'
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      return NODE_MAJOR > 18 ? version === 'latest' : version === '14.5.4'
    }
  }
  if (DD_MAJOR === 6) {
    if (NODE_MAJOR <= 16) {
      return false
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      if (NODE_MAJOR <= 18) {
        return version === '10.2.0' || version === '14.5.4'
      }
      return version === '10.2.0' || version === '14.5.4' || version === 'latest'
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

    this.retries(2)
    this.timeout(80000)
    let cwd, receiver, childProcess, webAppPort, webAppServer, secondWebAppServer

    // cypress-fail-fast is required as an incompatible plugin.
    // typescript is required to compile .cy.ts spec files in the pre-compiled JS tests.
    useSandbox([`cypress@${version}`, 'cypress-fail-fast@7.1.0', 'typescript'], true)

    before(async function () {
      // Note: Cypress binary is already installed during useSandbox() via the postinstall script
      // when the cypress npm package is installed, so no explicit install is needed here
      cwd = sandboxCwd()
    })

    after(async () => {
      // Cleanup second web app server if it exists
      if (secondWebAppServer) {
        await new Promise(resolve => secondWebAppServer.close(resolve))
      }
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()

      // Create a fresh web server for each test to avoid state issues
      webAppServer = createWebAppServer()
      await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        webAppServer.once('error', reject)
        webAppServer.listen(0, 'localhost', () => {
          webAppPort = webAppServer.address().port
          webAppServer.removeListener('error', reject)
          resolve()
        })
      }))
    })

    // Cypress child processes can sometimes hang or take longer to
    // terminate. This can cause `FakeCiVisIntake#stop` to be delayed
    // because there are pending connections.
    afterEach(async () => {
      if (childProcess && childProcess.pid) {
        try {
          childProcess.kill('SIGKILL')
        } catch (error) {
          // Process might already be dead - this is fine, ignore error
        }

        // Don't wait for exit - Cypress processes can hang indefinitely in uninterruptible I/O
        // The OS will clean up zombies, and fresh server per test prevents port conflicts
      }

      // Close web server before stopping receiver
      if (webAppServer) {
        await /** @type {Promise<void>} */ (new Promise((resolve) => {
          webAppServer.close((err) => {
            if (err) {
              // eslint-disable-next-line no-console
              console.error('Web server close error:', err)
            }
            resolve()
          })
        }))
      }

      // Add timeout to prevent hanging
      const stopPromise = receiver.stop()
      const timeoutPromise = new Promise((resolve, reject) =>
        setTimeout(() => reject(new Error('Receiver stop timeout')), RECEIVER_STOP_TIMEOUT)
      )

      try {
        await Promise.race([stopPromise, timeoutPromise])
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Receiver stop timed out:', error.message)
      }

      // Small delay to allow OS to release ports
      await new Promise(resolve => setTimeout(resolve, 100))
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

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
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
          }, 25000)

        const specToRun = 'cypress/e2e/spec.cy.js'
        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
              DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })
    })

    // cy.origin is not available in old versions of Cypress
    if (version === 'latest') {
      it('does not crash for multi origin tests', async () => {
        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
              .filter(event => event.type !== 'span')
            assert.strictEqual(events.length, 4)

            const test = events.find(event => event.type === 'test').content
            assert.strictEqual(test.resource, 'cypress/e2e/multi-origin.js.tests multiple origins')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
          }, 25000)

        secondWebAppServer = http.createServer((req, res) => {
          res.setHeader('Content-Type', 'text/html')
          res.writeHead(200)
          res.end(`
            <!DOCTYPE html>
            <html>
              <div class="hella-world">Hella World</div>
            </html>
          `)
        })

        const secondWebAppPort = await new Promise(resolve => {
          secondWebAppServer.listen(0, 'localhost', () => resolve(secondWebAppServer.address().port))
        })

        const specToRun = 'cypress/e2e/multi-origin.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              CYPRESS_BASE_URL_SECOND: `http://localhost:${secondWebAppPort}`,
              SPEC_PATTERN: specToRun,
              DD_TRACE_DEBUG: 'true',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          once(childProcess.stdout, 'end'),
          once(childProcess.stderr, 'end'),
          receiverPromise,
        ])
      })
    }

    it('sets _dd.test.is_user_provided_service to true if DD_SERVICE is used', async () => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')

          testEvents.forEach(({ content: { meta } }) => {
            assert.strictEqual(meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'true')
          })
        }, 25000)

      const envVars = getCiVisEvpProxyConfig(receiver.port)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            DD_SERVICE: 'my-service',
            SPEC_PATTERN: 'cypress/e2e/spec.cy.js',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
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

        const getTestAssertions = ({
          isAttemptToFix,
          shouldAlwaysPass,
          shouldFailSometimes,
          isQuarantined,
          isDisabled,
        }) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
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
                assert.strictEqual(attemptToFixTests.length, 4)
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
            }, 25000)

        /**
         * @param {{
         *   isAttemptToFix?: boolean,
         *   shouldAlwaysPass?: boolean,
         *   shouldFailSometimes?: boolean,
         *   isQuarantined?: boolean,
         *   isDisabled?: boolean,
         *   extraEnvVars?: Record<string, string>
         * }} [options]
         */
        const runAttemptToFixTest = async ({
          isAttemptToFix,
          shouldAlwaysPass,
          shouldFailSometimes,
          isQuarantined,
          isDisabled,
          extraEnvVars = {},
        } = {}) => {
          const testAssertionsPromise = getTestAssertions({
            isAttemptToFix,
            shouldAlwaysPass,
            shouldFailSometimes,
            isQuarantined,
            isDisabled,
          })
          let stdout = ''

          const envVars = getCiVisEvpProxyConfig(receiver.port)

          const specToRun = 'cypress/e2e/attempt-to-fix.js'

          childProcess = exec(
            version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
            {
              cwd,
              env: {
                ...envVars,
                CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
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

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            testAssertionsPromise,
          ])

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
          }

          if (shouldAlwaysPass) {
            assert.strictEqual(exitCode, 0)
          } else {
            assert.strictEqual(exitCode, 1)
          }
        }

        it('can attempt to fix and mark last attempt as failed if every attempt fails', async () => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

          await runAttemptToFixTest({ isAttemptToFix: true })
        })

        it('can attempt to fix and mark last attempt as passed if every attempt passes', async () => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

          await runAttemptToFixTest({ isAttemptToFix: true, shouldAlwaysPass: true })
        })

        it('can attempt to fix and not mark last attempt if attempts both pass and fail', async () => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

          await runAttemptToFixTest({ isAttemptToFix: true, shouldFailSometimes: true })
        })

        it('does not attempt to fix tests if test management is not enabled', async () => {
          receiver.setSettings({ test_management: { enabled: false, attempt_to_fix_retries: 3 } })

          await runAttemptToFixTest()
        })

        it('does not enable attempt to fix tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async () => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

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
              assert.ok(atfTests.length > 0)
              for (const test of atfTests) {
                assert.ok(
                  !(TEST_IS_NEW in test.meta),
                  'ATF test that is in known tests should not be tagged as new'
                )
              }
            }, 25000)

          const envVars = getCiVisEvpProxyConfig(receiver.port)
          const specToRun = 'cypress/e2e/attempt-to-fix.js'

          childProcess = exec(
            version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
            {
              cwd,
              env: {
                ...envVars,
                CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
                SPEC_PATTERN: specToRun,
                CYPRESS_SHOULD_ALWAYS_PASS: '1',
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
          ])
        })

        it('ignores quarantine when attempting to fix a test', async () => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
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
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
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

      context('disabled', () => {
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
              },
            },
          })
        })

        const getTestAssertions = (isDisabling) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const failedTest = events.find(event => event.type === 'test').content
              const testSession = events.find(event => event.type === 'test_session_end').content

              if (isDisabling) {
                assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
              } else {
                assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
              }

              assert.strictEqual(failedTest.resource, 'cypress/e2e/disable.js.disable is disabled')

              if (isDisabling) {
                assert.strictEqual(failedTest.meta[TEST_STATUS], 'skip')
                assert.strictEqual(failedTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
              } else {
                assert.strictEqual(failedTest.meta[TEST_STATUS], 'fail')
                assert.ok(!(TEST_MANAGEMENT_IS_DISABLED in failedTest.meta))
              }
            }, 25000)

        const runDisableTest = async (isDisabling, extraEnvVars = {}) => {
          const testAssertionsPromise = getTestAssertions(isDisabling)

          const envVars = getCiVisEvpProxyConfig(receiver.port)

          const specToRun = 'cypress/e2e/disable.js'

          childProcess = exec(
            version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
            {
              cwd,
              env: {
                ...envVars,
                CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
                SPEC_PATTERN: specToRun,
                ...extraEnvVars,
              },
            }
          )

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            testAssertionsPromise,
          ])

          if (isDisabling) {
            assert.strictEqual(exitCode, 0)
          } else {
            assert.strictEqual(exitCode, 1)
          }
        }

        it('can disable tests', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runDisableTest(true)
        })

        it('fails if disable is not enabled', async () => {
          receiver.setSettings({ test_management: { enabled: false } })

          await runDisableTest(false)
        })

        it('does not disable tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runDisableTest(false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
        })
      })

      context('quarantine', () => {
        beforeEach(() => {
          receiver.setTestManagementTests({
            cypress: {
              suites: {
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

        const getTestAssertions = (isQuarantining) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const failedTest = events.find(event => event.type === 'test').content
              const testSession = events.find(event => event.type === 'test_session_end').content

              if (isQuarantining) {
                assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
                // Session status should be 'pass' because Cypress sees the quarantined test as passed
                assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
              } else {
                assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
                assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
              }

              assert.strictEqual(failedTest.resource, 'cypress/e2e/quarantine.js.quarantine is quarantined')

              if (isQuarantining) {
                // Quarantined tests run normally but their failures are suppressed by Cypress.on('fail')
                // in support.js. The test actually fails (reports 'fail' to Datadog) but Cypress sees
                // it as passed, so the exit code is 0.
                assert.strictEqual(failedTest.meta[TEST_STATUS], 'fail')
                assert.strictEqual(failedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              } else {
                assert.strictEqual(failedTest.meta[TEST_STATUS], 'fail')
                assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in failedTest.meta))
              }
            }, 25000)

        const runQuarantineTest = async (isQuarantining, extraEnvVars = {}) => {
          const testAssertionsPromise = getTestAssertions(isQuarantining)

          const envVars = getCiVisEvpProxyConfig(receiver.port)

          const specToRun = 'cypress/e2e/quarantine.js'

          childProcess = exec(
            version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
            {
              cwd,
              env: {
                ...envVars,
                CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
                SPEC_PATTERN: specToRun,
                ...extraEnvVars,
              },
            }
          )

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            testAssertionsPromise,
          ])

          if (isQuarantining) {
            assert.strictEqual(exitCode, 0)
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
      })

      it('does not crash if the request to get test management tests fails', async () => {
        receiver.setSettings({
          test_management: { enabled: true },
          flaky_test_retries_enabled: false,
        })
        receiver.setTestManagementTestsResponseCode(500)

        // Request module waits before retrying; browser runs are slow — need longer gather timeout
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

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/attempt-to-fix.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
              DD_TRACE_DEBUG: '1',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
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

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
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
          }, 25000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/attempt-to-fix.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
              CYPRESS_SHOULD_ALWAYS_PASS: '1',
              CYPRESS_TEST_ISOLATION: 'false',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('retries attempt to fix tests in the correct order (right after original test)', async () => {
        let testOutput = ''
        receiver.setSettings({
          test_management: {
            enabled: true,
            attempt_to_fix_retries: 3,
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

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // 1 test with attempt to fix (1 original + 3 retries) + 2 tests without = 6 tests total
            assert.equal(tests.length, 6)

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
            // 4. "second test" (retry 2)
            // 5. "second test" (retry 3)
            // 6. "third test" (original, no retries)

            assertObjectContains(testExecutionOrder, [
              { name: 'attempt to fix order first test', isRetry: false, isAttemptToFix: false },
              { name: 'attempt to fix order second test', isRetry: false, isAttemptToFix: true },
              { name: 'attempt to fix order second test', isRetry: true, isAttemptToFix: true },
              { name: 'attempt to fix order second test', isRetry: true, isAttemptToFix: true },
              { name: 'attempt to fix order second test', isRetry: true, isAttemptToFix: true },
              { name: 'attempt to fix order third test', isRetry: false, isAttemptToFix: false },
            ])

            const testSession = events.find(event => event.type === 'test_session_end').content
            assertObjectContains(testSession.meta, {
              [TEST_MANAGEMENT_ENABLED]: 'true',
            })
          }, 25000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/attempt-to-fix-order.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
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
          once(childProcess, 'exit'),
          once(childProcess.stdout, 'end'),
          once(childProcess.stderr, 'end'),
          receiverPromise,
        ])

        assert.match(testOutput, /Retrying "attempt to fix order second test" because it is an attempt to fix/)
      })
    })
  })
})
