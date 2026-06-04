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
const {
  TEST_STATUS,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_RETRY_REASON,
  TEST_NAME,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_RETRY_REASON_TYPES,
  TEST_FINAL_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')

const requestedVersion = process.env.CYPRESS_VERSION
const oldestVersion = DD_MAJOR >= 6 ? '12.0.0' : '6.7.0'
const version = requestedVersion === 'oldest' ? oldestVersion : requestedVersion
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
    let cwd, receiver, childProcess, webAppBaseUrl, webAppServer

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
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      await stopCiVisTestEnv({ childProcess, receiver })
      childProcess = undefined
    })

    after(async () => {
      await stopWebAppServer(webAppServer)
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
            },
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
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
            }, { hardTimeout: 25000 })

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      // Cypress <12 can still emit native retries for Datadog-managed cloned tests.
      over12It('disables manual Cypress retries for new tests retried by EFD', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 2,
            },
            faulty_session_threshold: 100,
          },
          flaky_test_retries_enabled: false,
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          cypress: {},
        })

        const specToRun = 'cypress/e2e/fails-first-then-passes.cy.js'
        const testName = 'efd with manual cypress retries fails first then passes'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...getCiVisEvpProxyConfig(receiver.port),
              CYPRESS_BASE_URL: webAppBaseUrl,
              CYPRESS_RETRIES: '1',
              SPEC_PATTERN: specToRun,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiver.gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events
                .filter(event => event.type === 'test')
                .map(event => event.content)
                .filter(test => test.meta[TEST_NAME] === testName)
                .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

              const diagnosticTests = tests.map(test => ({
                status: test.meta[TEST_STATUS],
                isRetry: test.meta[TEST_IS_RETRY],
                retryReason: test.meta[TEST_RETRY_REASON],
              }))
              assert.deepStrictEqual(diagnosticTests, [
                { status: 'fail', isRetry: undefined, retryReason: undefined },
                { status: 'fail', isRetry: 'true', retryReason: TEST_RETRY_REASON_TYPES.efd },
                { status: 'pass', isRetry: 'true', retryReason: TEST_RETRY_REASON_TYPES.efd },
              ])
            },
            { hardTimeout: 60_000 }
          ),
        ])
      })

      it('uses the retry count from the matching slow_test_retries bucket', async () => {
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

        receiver.setKnownTests({
          cypress: {},
        })

        const envVars = getCiVisEvpProxyConfig(receiver.port)
        const specToRun = 'cypress/e2e/efd-duration.cy.js'

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

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const instantTests = tests.filter(test => test.resource ===
              'cypress/e2e/efd-duration.cy.js.efd duration retries instant test'
              )
              assert.strictEqual(instantTests.length, 3)
              assert.strictEqual(
                instantTests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd).length,
                2
              )

              const slowTests = tests.filter(test => test.resource ===
              'cypress/e2e/efd-duration.cy.js.efd duration retries slightly slow test'
              )
              assert.strictEqual(slowTests.length, 1)
              assert.strictEqual(slowTests[0].meta[TEST_IS_NEW], 'true')
              assert.strictEqual(slowTests[0].meta[TEST_EARLY_FLAKE_ABORT_REASON], 'slow')
              assert.strictEqual(slowTests[0].meta[TEST_STATUS], 'pass')
              assert.strictEqual(slowTests[0].meta[TEST_FINAL_STATUS], 'pass')
              assert.ok(!(TEST_IS_RETRY in slowTests[0].meta))
            }, { hardTimeout: 30_000 })

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

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
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
            }, { hardTimeout: 25000 })

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

        const specToRun = 'cypress/e2e/skipped-test.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              SPEC_PATTERN: 'cypress/e2e/skipped-test.js',
            },
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              assert.strictEqual(tests.length, 1)

              const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
              assert.strictEqual(newTests.length, 0)

              assert.strictEqual(tests[0].resource, 'cypress/e2e/skipped-test.js.skipped skipped')
              assert.strictEqual(tests[0].meta[TEST_STATUS], 'skip')

              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
            }, { hardTimeout: 25000 })

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
        const specToRun = 'cypress/e2e/spec.cy.js'

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

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSessionEnd = events.find(event => event.type === 'test_session_end')
              assert.ok(testSessionEnd, 'expected test_session_end event in payloads')
              const testSession = testSessionEnd.content
              assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              assert.strictEqual(tests.length, 2)

              const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
              assert.strictEqual(newTests.length, 0)
            }, { hardTimeout: 60000 })

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('bails out of EFD if the percentage of new test files is too high', async () => {
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
          cypress: {},
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
            },
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              assert.strictEqual(tests.length, 2)

              const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
              assert.strictEqual(newTests.length, 0)

              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
              assert.strictEqual(retriedTests.length, 0)

              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
              assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')
            }, { hardTimeout: 60000 })

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

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
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
            }, { hardTimeout: 25000 })

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

        const specToRun = 'cypress/e2e/spec.cy.js'

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

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
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
            }, { hardTimeout: 25000 })

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
              CYPRESS_TEST_ISOLATION: 'false',
            },
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
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
            }, { hardTimeout: 25000 })

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      over12It('preserves manual Cypress retries for new tests when testIsolation is false', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 100,
          },
          flaky_test_retries_enabled: false,
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          cypress: {},
        })

        const specToRun = 'cypress/e2e/fails-first-then-passes.cy.js'
        const testName = 'efd with manual cypress retries fails first then passes'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...getCiVisEvpProxyConfig(receiver.port),
              CYPRESS_BASE_URL: webAppBaseUrl,
              CYPRESS_EXPECTED_ATTEMPT: '1',
              CYPRESS_RETRIES: '1',
              CYPRESS_TEST_ISOLATION: 'false',
              SPEC_PATTERN: specToRun,
            },
          }
        )

        const receiverPromise = receiver.gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events
              .filter(event => event.type === 'test')
              .map(event => event.content)
              .filter(test => test.meta[TEST_NAME] === testName)
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            const diagnosticTests = tests.map(test => ({
              status: test.meta[TEST_STATUS],
              isNew: test.meta[TEST_IS_NEW],
              isRetry: test.meta[TEST_IS_RETRY],
              retryReason: test.meta[TEST_RETRY_REASON],
            }))
            assert.deepStrictEqual(diagnosticTests, [
              { status: 'fail', isNew: 'true', isRetry: undefined, retryReason: undefined },
              { status: 'pass', isNew: undefined, isRetry: 'true', retryReason: TEST_RETRY_REASON_TYPES.ext },
            ])
          },
          { hardTimeout: 60_000 }
        )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
        assert.strictEqual(exitCode, 0)
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
            },
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
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
            }, { hardTimeout: 25000 })

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
