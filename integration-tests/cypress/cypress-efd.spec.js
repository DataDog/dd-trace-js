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
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_RETRY_REASON,
  TEST_NAME,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_RETRY_REASON_TYPES,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')

const RECEIVER_STOP_TIMEOUT = 20000
const version = process.env.CYPRESS_VERSION
const hookFile = 'dd-trace/loader-hook.mjs'
const NUM_RETRIES_EFD = 3
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
    let cwd, receiver, childProcess, webAppPort, webAppServer

    // cypress-fail-fast is required as an incompatible plugin.
    // typescript is required to compile .cy.ts spec files in the pre-compiled JS tests.
    // typescript@5 is pinned because typescript@6 emits "use strict" on line 1 for
    // non-module files, shifting compiled line numbers and breaking source map resolution.
    // TODO: Update tests files accordingly and test with different TS versions
    useSandbox([`cypress@${version}`, 'cypress-fail-fast@7.1.0', 'typescript@5'], true)

    before(async function () {
      // Note: Cypress binary is already installed during useSandbox() via the postinstall script
      // when the cypress npm package is installed, so no explicit install is needed here
      cwd = sandboxCwd()
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

    context('early flake detection', () => {
      it('retries new tests', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
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

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 5)

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, NUM_RETRIES_EFD + 1)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)

            retriedTests.forEach((retriedTest) => {
              assert.strictEqual(retriedTest.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
            })

            newTests.forEach(newTest => {
              assert.strictEqual(newTest.resource, 'cypress/e2e/spec.cy.js.context passes')
            })

            const knownTest = tests.filter(test => !test.meta[TEST_IS_NEW])
            assert.strictEqual(knownTest.length, 1)
            assert.strictEqual(knownTest[0].resource, 'cypress/e2e/spec.cy.js.other context fails')

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
          }, 25000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/spec.cy.js'

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

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
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

      it('does not retry tests that are skipped', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          cypress: {},
        })

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)

            assert.strictEqual(tests[0].resource, 'cypress/e2e/skipped-test.js.skipped skipped')
            assert.strictEqual(tests[0].meta[TEST_STATUS], 'skip')

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
          }, 25000)

        const specToRun = 'cypress/e2e/skipped-test.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/skipped-test.js',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('does not run EFD if the known tests request fails', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTestsResponseCode(500)
        receiver.setKnownTests({
          cypress: {},
        })

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        // Request module waits before retrying; browser runs are slow — need longer gather timeout
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSessionEnd = events.find(event => event.type === 'test_session_end')
            assert.ok(testSessionEnd, 'expected test_session_end event in payloads')
            const testSession = testSessionEnd.content
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 2)

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)
          }, 60000)

        const specToRun = 'cypress/e2e/spec.cy.js'

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

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('disables early flake detection if known tests should not be requested', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: false,
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

            // new tests are not detected
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)

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

      it('disables early flake detection if known tests response is invalid', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: false,
        })

        receiver.setKnownTests({
          'not-cypress': {
            'cypress/e2e/spec.cy.js': [
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

            // new tests are not detected
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)

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
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      over12It('does not retry new tests when testIsolation is false', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
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

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            // Should only have 2 tests, no retries
            assert.equal(tests.length, 2)

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.equal(newTests.length, 1)

            // No retries should occur when testIsolation is false
            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)

            newTests.forEach(newTest => {
              assert.equal(newTest.resource, 'cypress/e2e/spec.cy.js.context passes')
            })

            const testSession = events.find(event => event.type === 'test_session_end').content
            assertObjectContains(testSession.meta, {
              [TEST_EARLY_FLAKE_ENABLED]: 'true',
            })
          }, 25000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/spec.cy.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
              CYPRESS_TEST_ISOLATION: 'false',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('retries new tests in the correct order (right after original test)', async () => {
        let testOutput = ''

        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          cypress: {
            'cypress/e2e/spec.cy.js': [
              'context passes', // This test is known, so only "other context fails" will be retried
            ],
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // 1 known test + 1 new test with retries: 1 + (1 + 3) = 5 tests
            assert.equal(tests.length, 5)

            // Extract test execution order: [testName, isRetry]
            const testExecutionOrder = tests.map(test => ({
              name: test.meta[TEST_NAME],
              isRetry: test.meta[TEST_IS_RETRY] === 'true',
              isNew: test.meta[TEST_IS_NEW] === 'true',
            }))

            // Expected order:
            // 1. "context passes" (original, known - not retried)
            // 2. "other context fails" (original, new)
            // 3. "other context fails" (retry 1)
            // 4. "other context fails" (retry 2)
            // 5. "other context fails" (retry 3)

            assertObjectContains(testExecutionOrder, [
              { name: 'context passes', isRetry: false, isNew: false },
              { name: 'other context fails', isRetry: false, isNew: true },
              { name: 'other context fails', isRetry: true, isNew: true },
              { name: 'other context fails', isRetry: true, isNew: true },
              { name: 'other context fails', isRetry: true, isNew: true },
            ])

            // Verify TEST_HAS_FAILED_ALL_RETRIES is set correctly
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, NUM_RETRIES_EFD + 1)

            const testsWithFailedAllRetries = newTests.filter(
              test => test.meta[TEST_HAS_FAILED_ALL_RETRIES] === 'true'
            )
            assert.strictEqual(
              testsWithFailedAllRetries.length,
              1,
              'Exactly one test should have TEST_HAS_FAILED_ALL_RETRIES set'
            )
            assert.strictEqual(newTests[newTests.length - 1].meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
            for (let i = 0; i < newTests.length - 1; i++) {
              assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in newTests[i].meta))
            }

            const testSession = events.find(event => event.type === 'test_session_end').content
            assertObjectContains(testSession.meta, {
              [TEST_EARLY_FLAKE_ENABLED]: 'true',
            })
          }, 25000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/spec.cy.js'

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
        assert.match(testOutput, /Retrying "other context fails" to detect flakes because it is new/)
      })
    })
  })
})
