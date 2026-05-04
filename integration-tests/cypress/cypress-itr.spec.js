'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  assertObjectContains,
  warmCypressBinary,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_CODE_COVERAGE_ENABLED,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_ITR_TESTS_SKIPPED,
  TEST_SKIPPED_BY_ITR,
  TEST_ITR_SKIPPING_COUNT,
  TEST_ITR_SKIPPING_TYPE,
  TEST_ITR_UNSKIPPABLE,
  TEST_ITR_FORCED_RUN,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')

const RECEIVER_STOP_TIMEOUT = 20000
const requestedVersion = process.env.CYPRESS_VERSION
const oldestVersion = DD_MAJOR >= 6 ? '12.0.0' : '6.7.0'
const version = requestedVersion === 'oldest' ? oldestVersion : requestedVersion
const hookFile = 'dd-trace/loader-hook.mjs'

function shouldTestsRun (type) {
  if (DD_MAJOR === 5) {
    if (NODE_MAJOR <= 16) {
      return version === '6.7.0' && type === 'commonJS'
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      if (NODE_MAJOR <= 18) {
        return version === '10.2.0' || version === '12.0.0' || version === '14.5.4'
      }
      return version === '10.2.0' || version === '12.0.0' || version === '14.5.4' || version === 'latest'
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
    let cwd, receiver, childProcess, webAppPort, webAppServer

    // cypress-fail-fast is required as an incompatible plugin.
    // typescript is required to compile .cy.ts spec files in the pre-compiled JS tests.
    useSandbox([`cypress@${version}`, 'cypress-fail-fast@7.1.0', 'typescript'], true)

    before(async function () {
      cwd = sandboxCwd()
      await warmCypressBinary(cwd)
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

    context('intelligent test runner', () => {
      it('can report git metadata', async () => {
        const searchCommitsRequestPromise = receiver.payloadReceived(
          ({ url }) => url.endsWith('/api/v2/git/repository/search_commits'),
          25000
        )
        const packfileRequestPromise = receiver
          .payloadReceived(({ url }) => url.endsWith('/api/v2/git/repository/packfile'), 25000)

        const envVars = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/spec.cy.js',
            },
          }
        )

        // TODO: remove this once we have figured out flakiness
        childProcess.stdout?.pipe(process.stdout)
        childProcess.stderr?.pipe(process.stderr)

        const [, searchCommitRequest, packfileRequest] = await Promise.all([
          once(childProcess, 'exit'),
          searchCommitsRequestPromise,
          packfileRequestPromise,
        ])
        assert.strictEqual(searchCommitRequest.headers['dd-api-key'], '1')
        assert.strictEqual(packfileRequest.headers['dd-api-key'], '1')
      })

      it('does not report code coverage if disabled by the API', async () => {
        let hasReportedCodeCoverage = false
        receiver.setSettings({
          code_coverage: false,
          tests_skipping: false,
        })

        receiver.assertPayloadReceived(() => {
          hasReportedCodeCoverage = true
        }, ({ url }) => url.endsWith('/api/v2/citestcov')).catch(() => {})

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const eventTypes = events.map(event => event.type)
            assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
          }, 25000)

        const envVars = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/spec.cy.js',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
        assert.strictEqual(hasReportedCodeCoverage, false)
      })

      it('can skip tests received by the intelligent test runner API and still reports code coverage', async () => {
        receiver.setSuitesToSkip([{
          type: 'test',
          attributes: {
            name: 'context passes',
            suite: 'cypress/e2e/other.cy.js',
          },
        }])
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const eventTypes = events.map(event => event.type)

            const skippedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/other.cy.js.context passes'
            ).content
            assert.strictEqual(skippedTest.meta[TEST_STATUS], 'skip')
            assert.strictEqual(skippedTest.meta[TEST_SKIPPED_BY_ITR], 'true')

            assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
            assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
            assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
            assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_TYPE], 'test')
            const testModule = events.find(event => event.type === 'test_module_end').content
            assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'true')
            assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
            assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
            assert.strictEqual(testModule.metrics[TEST_ITR_SKIPPING_COUNT], 1)
            assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_TYPE], 'test')
          }, 25000)

        const coverageRequestPromise = receiver
          .payloadReceived(({ url }) => url.endsWith('/api/v2/citestcov'), 25000)
          .then(coverageRequest => {
            assert.strictEqual(coverageRequest.headers['dd-api-key'], '1')
          })

        const skippableRequestPromise = receiver
          .payloadReceived(({ url }) => url.endsWith('/api/v2/ci/tests/skippable'), 25000)
          .then(skippableRequest => {
            assert.strictEqual(skippableRequest.headers['dd-api-key'], '1')
          })

        const envVars = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/{other,spec}.cy.js',
            },
          }
        )

        // TODO: remove this once we have figured out flakiness
        childProcess.stdout?.pipe(process.stdout)
        childProcess.stderr?.pipe(process.stderr)

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
          skippableRequestPromise,
          coverageRequestPromise,
        ])
      })

      it('does not skip tests if test skipping is disabled by the API', async () => {
        let hasRequestedSkippable = false
        receiver.setSettings({
          code_coverage: true,
          tests_skipping: false,
        })

        receiver.setSuitesToSkip([{
          type: 'test',
          attributes: {
            name: 'context passes',
            suite: 'cypress/e2e/other.cy.js',
          },
        }])

        receiver.assertPayloadReceived(() => {
          hasRequestedSkippable = true
        }, ({ url }) => url.endsWith('/api/v2/ci/tests/skippable'), 25000).catch(() => {})

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const notSkippedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/other.cy.js.context passes'
            )
            assert.ok(notSkippedTest)
            assert.strictEqual(notSkippedTest.content.meta[TEST_STATUS], 'pass')
          }, 25000)

        const envVars = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/other.cy.js',
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
        assert.strictEqual(hasRequestedSkippable, false)
      })

      it('does not skip tests if suite is marked as unskippable', async () => {
        receiver.setSettings({
          code_coverage: true,
          tests_skipping: true,
        })

        receiver.setSuitesToSkip([
          {
            type: 'test',
            attributes: {
              name: 'context passes',
              suite: 'cypress/e2e/other.cy.js',
            },
          },
          {
            type: 'test',
            attributes: {
              name: 'context passes',
              suite: 'cypress/e2e/spec.cy.js',
            },
          },
        ])
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            const testModule = events.find(event => event.type === 'test_session_end').content

            assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_FORCED_RUN], 'true')
            assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')
            assert.strictEqual(testModule.meta[TEST_ITR_FORCED_RUN], 'true')

            const unskippablePassedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/spec.cy.js.context passes'
            )
            const unskippableFailedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/spec.cy.js.other context fails'
            )
            assert.strictEqual(unskippablePassedTest.content.meta[TEST_STATUS], 'pass')
            assert.strictEqual(unskippablePassedTest.content.meta[TEST_ITR_UNSKIPPABLE], 'true')
            assert.strictEqual(unskippablePassedTest.content.meta[TEST_ITR_FORCED_RUN], 'true')

            assert.strictEqual(unskippableFailedTest.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(unskippableFailedTest.content.meta[TEST_ITR_UNSKIPPABLE], 'true')
            // This was not going to be skipped
            assert.ok(!(TEST_ITR_FORCED_RUN in unskippableFailedTest.content.meta))
          }, 25000)

        const envVars = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/{other,spec}.cy.js',
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

      it('only sets forced to run if test was going to be skipped by ITR', async () => {
        receiver.setSettings({
          code_coverage: true,
          tests_skipping: true,
        })

        receiver.setSuitesToSkip([
          {
            type: 'test',
            attributes: {
              name: 'context passes',
              suite: 'cypress/e2e/other.cy.js',
            },
          },
        ])

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            const testModule = events.find(event => event.type === 'test_session_end').content

            assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
            assert.ok(!(TEST_ITR_FORCED_RUN in testSession.meta))
            assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')
            assert.ok(!(TEST_ITR_FORCED_RUN in testModule.meta))

            const unskippablePassedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/spec.cy.js.context passes'
            )
            const unskippableFailedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/spec.cy.js.other context fails'
            )
            assert.strictEqual(unskippablePassedTest.content.meta[TEST_STATUS], 'pass')
            assert.strictEqual(unskippablePassedTest.content.meta[TEST_ITR_UNSKIPPABLE], 'true')
            // This was not going to be skipped
            assert.ok(!(TEST_ITR_FORCED_RUN in unskippablePassedTest.content.meta))

            assert.strictEqual(unskippableFailedTest.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(unskippableFailedTest.content.meta[TEST_ITR_UNSKIPPABLE], 'true')
            // This was not going to be skipped
            assert.ok(!(TEST_ITR_FORCED_RUN in unskippableFailedTest.content.meta))
          }, 25000)

        const envVars = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/{other,spec}.cy.js',
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

      it('sets _dd.ci.itr.tests_skipped to false if the received test is not skipped', async () => {
        receiver.setSuitesToSkip([{
          type: 'test',
          attributes: {
            name: 'fake name',
            suite: 'i/dont/exist.spec.js',
          },
        }])
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
            assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
            assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 0)
            const testModule = events.find(event => event.type === 'test_module_end').content
            assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
            assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
            assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
            assert.strictEqual(testModule.metrics[TEST_ITR_SKIPPING_COUNT], 0)
          }, 30000)

        const skippableRequestPromise = receiver
          .payloadReceived(({ url }) => url.endsWith('/api/v2/ci/tests/skippable'), 30000)
          .then(skippableRequest => {
            assert.strictEqual(skippableRequest.headers['dd-api-key'], '1')
          })

        const envVars = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/spec.cy.js',
            },
          }
        )

        // TODO: remove this once we have figured out flakiness
        childProcess.stdout?.pipe(process.stdout)
        childProcess.stderr?.pipe(process.stderr)

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
          skippableRequestPromise,
        ])
      })

      it('reports itr_correlation_id in tests', async () => {
        const itrCorrelationId = '4321'
        receiver.setItrCorrelationId(itrCorrelationId)
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            tests.forEach(test => {
              assert.strictEqual(test.itr_correlation_id, itrCorrelationId)
            })
          }, 25000)

        const envVars = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/spec.cy.js',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('reports code coverage relative to the repository root, not working directory', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: true,
          tests_skipping: false,
        })
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
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
            const coveredFiles = payloads
              .flatMap(({ payload }) => payload)
              .flatMap(({ content: { coverages } }) => coverages)
              .flatMap(({ files }) => files)
              .map(({ filename }) => filename)

            assertObjectContains(coveredFiles, [
              'ci-visibility/subproject/src/utils.tsx',
              'ci-visibility/subproject/src/App.tsx',
              'ci-visibility/subproject/src/index.tsx',
              'ci-visibility/subproject/cypress/e2e/spec.cy.js',
            ])
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

        // TODO: remove this once we have figured out flakiness
        childProcess.stdout?.pipe(process.stdout)
        childProcess.stderr?.pipe(process.stderr)

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })
    })

    it('still reports correct format if there is a plugin incompatibility', async () => {
      const envVars = getCiVisEvpProxyConfig(receiver.port)

      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          const testModuleEvent = events.find(event => event.type === 'test_module_end')

          testEvents.forEach(testEvent => {
            assert.ok(testEvent.content.test_suite_id)
            assert.ok(testEvent.content.test_module_id)
            assert.ok(testEvent.content.test_session_id)
            assert.notStrictEqual(testEvent.content.test_suite_id, testModuleEvent.content.test_module_id)
          })
        }, 25000)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            CYPRESS_ENABLE_INCOMPATIBLE_PLUGIN: '1',
            SPEC_PATTERN: 'cypress/e2e/spec.cy.js',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })
  })
})
