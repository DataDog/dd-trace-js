'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const semver = require('semver')
const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  assertObjectContains,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_SOURCE_FILE,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_SUITE,
  TEST_CODE_OWNERS,
  TEST_RETRY_REASON,
  TEST_NAME,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_RETRY_REASON_TYPES,
  TEST_HAS_DYNAMIC_NAME,
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

    this.timeout(80_000)
    let cwd, receiver, childProcess, webAppPort, webAppServer

    // cypress-fail-fast is required as an incompatible plugin.
    // typescript is required to compile .cy.ts spec files in the pre-compiled JS tests.
    useSandbox([`cypress@${version}`, 'cypress-fail-fast@7.1.0', 'typescript'], true)

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

    context('flaky test retries', () => {
      it('retries flaky tests', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
            assert.strictEqual(testSuites.length, 1)
            assert.strictEqual(testSuites[0].meta[TEST_STATUS], 'fail')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 10)

            assertObjectContains(tests.map(test => test.resource), [
              'cypress/e2e/flaky-test-retries.js.flaky test retry eventually passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry eventually passes',
              // passes at the second retry
              'cypress/e2e/flaky-test-retries.js.flaky test retry eventually passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry never passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry never passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry never passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry never passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry never passes',
              // never passes
              'cypress/e2e/flaky-test-retries.js.flaky test retry never passes',
              // passes on the first try
              'cypress/e2e/flaky-test-retries.js.flaky test retry always passes',
            ])

            const eventuallyPassingTest = tests.filter(
              test => test.resource === 'cypress/e2e/flaky-test-retries.js.flaky test retry eventually passes'
            )
            assert.strictEqual(eventuallyPassingTest.length, 3)
            assert.strictEqual(eventuallyPassingTest.filter(test => test.meta[TEST_STATUS] === 'fail').length, 2)
            assert.strictEqual(eventuallyPassingTest.filter(test => test.meta[TEST_STATUS] === 'pass').length, 1)
            assert.strictEqual(eventuallyPassingTest.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 2)
            assert.strictEqual(eventuallyPassingTest.filter(test =>
              test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            ).length, 2)

            const neverPassingTest = tests.filter(
              test => test.resource === 'cypress/e2e/flaky-test-retries.js.flaky test retry never passes'
            )
            assert.strictEqual(neverPassingTest.length, 6)
            assert.strictEqual(neverPassingTest.filter(test => test.meta[TEST_STATUS] === 'fail').length, 6)
            assert.strictEqual(neverPassingTest.filter(test => test.meta[TEST_STATUS] === 'pass').length, 0)
            assert.strictEqual(neverPassingTest.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 5)
            assert.strictEqual(neverPassingTest.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            ).length, 5)

            // Verify execution order: retries happen right after the original test
            const testExecutionOrder = tests.map(test => ({
              name: test.meta[TEST_NAME],
              isRetry: test.meta[TEST_IS_RETRY] === 'true',
            }))

            // Verify order for "flaky test retry eventually passes" (first 3)
            for (let i = 0; i < 3; i++) {
              assert.equal(testExecutionOrder[i].name, 'flaky test retry eventually passes')
              assert.equal(testExecutionOrder[i].isRetry, i > 0)
            }

            // Verify order for "flaky test retry never passes" (next 6)
            for (let i = 3; i < 9; i++) {
              assert.equal(testExecutionOrder[i].name, 'flaky test retry never passes')
              assert.equal(testExecutionOrder[i].isRetry, i > 3)
            }

            // Verify "flaky test retry always passes" comes last
            assert.equal(testExecutionOrder[9].name, 'flaky test retry always passes')
            assert.equal(testExecutionOrder[9].isRetry, false)
          }, 30000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/flaky-test-retries.js'

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

        // TODO: remove this once we have figured out flakiness
        childProcess.stdout?.pipe(process.stdout)
        childProcess.stderr?.pipe(process.stderr)

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('is disabled if DD_CIVISIBILITY_FLAKY_RETRY_ENABLED is false', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
            assert.strictEqual(testSuites.length, 1)
            assert.strictEqual(testSuites[0].meta[TEST_STATUS], 'fail')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 3)

            assertObjectContains(tests.map(test => test.resource), [
              'cypress/e2e/flaky-test-retries.js.flaky test retry eventually passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry never passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry always passes',
            ])
            assert.ok(!tests.some(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr))
          }, 25000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/flaky-test-retries.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false',
              SPEC_PATTERN: specToRun,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('retries DD_CIVISIBILITY_FLAKY_RETRY_COUNT times', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
            assert.strictEqual(testSuites.length, 1)
            assert.strictEqual(testSuites[0].meta[TEST_STATUS], 'fail')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 5)

            assertObjectContains(tests.map(test => test.resource), [
              'cypress/e2e/flaky-test-retries.js.flaky test retry eventually passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry eventually passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry never passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry never passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry always passes',
            ])

            assert.strictEqual(
              tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr).length,
              2
            )
          }, 25000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/flaky-test-retries.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
              SPEC_PATTERN: specToRun,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('sets TEST_HAS_FAILED_ALL_RETRIES when all ATR attempts fail', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          flaky_test_retries_count: 1,
          early_flake_detection: {
            enabled: false,
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const neverPassingTests = tests.filter(
              test => test.resource === 'cypress/e2e/flaky-test-retries.js.flaky test retry never passes'
            )
            assert.strictEqual(neverPassingTests.length, 2, 'initial + 1 ATR retry')
            const failedNeverPassing = neverPassingTests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedNeverPassing.length, 2)
            const lastFailed = failedNeverPassing[failedNeverPassing.length - 1]
            assert.strictEqual(lastFailed.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
            assert.strictEqual(lastFailed.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
          }, 25000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/flaky-test-retries.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
              SPEC_PATTERN: specToRun,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      over12It('does not retry flaky tests when testIsolation is false', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            // Should only have 3 tests, no retries
            assert.equal(tests.length, 3)

            // No retries should occur when testIsolation is false
            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)
            assert.equal(tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr).length, 0)
          }, 30000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/flaky-test-retries.js'

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
    })

    it('correctly calculates test code owners when working directory is not repository root', async () => {
      let command

      if (type === 'commonJS') {
        const commandSuffix = version === '6.7.0'
          ? '--config-file cypress-config.json --spec "cypress/e2e/*.cy.js"'
          : ''
        command = `../../node_modules/.bin/cypress run ${commandSuffix}`
      } else {
        command = `node --loader=${hookFile} ../../cypress-esm-config.mjs`
      }

      const envVars = getCiVisAgentlessConfig(receiver.port)

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const test = events.find(event => event.type === 'test').content
          const testSuite = events.find(event => event.type === 'test_suite_end').content
          // The test is in a subproject
          assert.notStrictEqual(test.meta[TEST_SOURCE_FILE], test.meta[TEST_SUITE])
          assert.strictEqual(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
          assert.strictEqual(testSuite.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
        }, 25000)

      childProcess = exec(
        command,
        {
          cwd: `${cwd}/ci-visibility/subproject`,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    it('tags new tests with dynamic names and logs a warning', async () => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: { '5s': 1 },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      receiver.setKnownTests({
        cypress: {
          'cypress/e2e/dynamic-name-test.cy.js': [],
        },
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
        },
        25000
      )

      const specToRun = 'cypress/e2e/dynamic-name-test.cy.js'

      childProcess = exec(
        version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: specToRun,
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
})
