'use strict'

const { promisify } = require('util')
const { once } = require('node:events')
const http = require('http')
const { exec, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const execPromise = promisify(exec)

const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const webAppServer = require('../ci-visibility/web-app-server')
const coverageFixture = require('../ci-visibility/fixtures/coverage.json')
const {
  TEST_STATUS,
  TEST_COMMAND,
  TEST_MODULE,
  TEST_FRAMEWORK_VERSION,
  TEST_TOOLCHAIN,
  TEST_CODE_COVERAGE_ENABLED,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_ITR_TESTS_SKIPPED,
  TEST_SKIPPED_BY_ITR,
  TEST_ITR_SKIPPING_COUNT,
  TEST_ITR_SKIPPING_TYPE,
  TEST_ITR_UNSKIPPABLE,
  TEST_ITR_FORCED_RUN,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_SUITE,
  TEST_CODE_OWNERS,
  TEST_SESSION_NAME,
  TEST_LEVEL_EVENT_TYPES,
  TEST_RETRY_REASON,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_NAME,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_HAS_FAILED_ALL_RETRIES,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  DD_CAPABILITIES_EARLY_FLAKE_DETECTION,
  DD_CAPABILITIES_AUTO_TEST_RETRIES,
  DD_CAPABILITIES_IMPACTED_TESTS,
  DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE,
  DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE,
  DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX,
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')

const RECEIVER_STOP_TIMEOUT = 20000
const version = process.env.CYPRESS_VERSION
const hookFile = 'dd-trace/loader-hook.mjs'
const NUM_RETRIES_EFD = 3

const moduleTypes = [
  {
    type: 'commonJS',
    testCommand: function commandWithSuffic (version) {
      const commandSuffix = version === '6.7.0' ? '--config-file cypress-config.json --spec "cypress/e2e/*.cy.js"' : ''
      return `./node_modules/.bin/cypress run ${commandSuffix}`
    }
  },
  {
    type: 'esm',
    testCommand: `node --loader=${hookFile} ./cypress-esm-config.mjs`
  }
].filter(moduleType => !process.env.CYPRESS_MODULE_TYPE || process.env.CYPRESS_MODULE_TYPE === moduleType.type)

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

moduleTypes.forEach(({
  type,
  testCommand
}) => {
  describe(`cypress@${version} ${type}`, function () {
    if (!shouldTestsRun(type)) {
      // eslint-disable-next-line no-console
      console.log(`Skipping tests for cypress@${version} ${type} for dd-trace@${DD_MAJOR} node@${NODE_MAJOR}`)
      return
    }

    this.retries(2)
    this.timeout(80000)
    let sandbox, cwd, receiver, childProcess, webAppPort, secondWebAppServer

    if (type === 'commonJS') {
      testCommand = testCommand(version)
    }

    before(async () => {
      // cypress-fail-fast is required as an incompatible plugin
      sandbox = await createSandbox([`cypress@${version}`, 'cypress-fail-fast@7.1.0'], true)
      cwd = sandbox.folder

      const { NODE_OPTIONS, ...restOfEnv } = process.env
      // Install cypress' browser before running the tests
      await execPromise('npx cypress install', { cwd, env: restOfEnv, stdio: 'inherit' })

      await /** @type {Promise<void>} */ (new Promise(resolve => webAppServer.listen(0, 'localhost', () => {
        webAppPort = webAppServer.address().port
        resolve()
      })))
    })

    after(async () => {
      await sandbox.remove()
      await new Promise(resolve => webAppServer.close(resolve))
      if (secondWebAppServer) {
        await new Promise(resolve => secondWebAppServer.close(resolve))
      }
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    // Cypress child processes can sometimes hang or take longer to
    // terminate. This can cause `FakeCiVisIntake#stop` to be delayed
    // because there are pending connections.
    afterEach(async () => {
      childProcess.kill()

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
    })

    if (version === '6.7.0') {
      // to be removed when we drop support for cypress@6.7.0
      it('logs a warning if using a deprecated version of cypress', async () => {
        let stdout = ''
        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          `${testCommand} --spec cypress/e2e/spec.cy.js`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`
            },
            stdio: 'pipe'
          }
        )

        childProcess.stdout.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        await Promise.all([
          once(childProcess, 'exit'),
          once(childProcess.stdout, 'end')
        ])
        assert.include(
          stdout,
          'WARNING: dd-trace support for Cypress<10.2.0 is deprecated' +
          ' and will not be supported in future versions of dd-trace.'
        )
      })
    }

    it('does not crash if badly init', async () => {
      const {
        NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
        DD_CIVISIBILITY_AGENTLESS_URL,
        ...restEnvVars
      } = getCiVisAgentlessConfig(receiver.port)

      let hasReceivedEvents = false

      const eventsPromise = receiver.assertPayloadReceived(() => {
        hasReceivedEvents = true
      }, ({ url }) => url.endsWith('/api/v2/citestcycle')).catch(() => {})

      let testOutput = ''

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...restEnvVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            DD_SITE: '= invalid = url',
            SPEC_PATTERN: 'cypress/e2e/spec.cy.js'
          },
          stdio: 'pipe'
        }
      )
      childProcess.stdout.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      await Promise.all([
        once(childProcess.stdout, 'end'),
        once(childProcess.stderr, 'end'),
        once(childProcess, 'exit'),
        eventsPromise
      ])

      assert.strictEqual(hasReceivedEvents, false)
      // TODO: remove try/catch once we find the source of flakiness
      try {
        assert.notInclude(testOutput, 'TypeError')
        assert.include(testOutput, '1 of 1 failed')
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log('---- Actual test output -----')
        // eslint-disable-next-line no-console
        console.log(testOutput)
        // eslint-disable-next-line no-console
        console.log('---- finish actual test output -----')
        throw e
      }
    })

    it('catches errors in hooks', async () => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          // test level hooks
          const testHookSuite = events.find(
            event => event.content.resource === 'test_suite.cypress/e2e/hook-test-error.cy.js'
          )
          const passedTest = events.find(
            event => event.content.resource === 'cypress/e2e/hook-test-error.cy.js.hook-test-error tests passes'
          )
          const failedTest = events.find(
            event => event.content.resource ===
            'cypress/e2e/hook-test-error.cy.js.hook-test-error tests will fail because afterEach fails'
          )
          const skippedTest = events.find(
            event => event.content.resource ===
            'cypress/e2e/hook-test-error.cy.js.hook-test-error tests does not run because earlier afterEach fails'
          )
          assert.equal(passedTest.content.meta[TEST_STATUS], 'pass')
          assert.equal(failedTest.content.meta[TEST_STATUS], 'fail')
          assert.include(failedTest.content.meta[ERROR_MESSAGE], 'error in after each hook')
          assert.equal(skippedTest.content.meta[TEST_STATUS], 'skip')
          assert.equal(testHookSuite.content.meta[TEST_STATUS], 'fail')
          assert.include(testHookSuite.content.meta[ERROR_MESSAGE], 'error in after each hook')

          // describe level hooks
          const describeHookSuite = events.find(
            event => event.content.resource === 'test_suite.cypress/e2e/hook-describe-error.cy.js'
          )
          const passedTestDescribe = events.find(
            event => event.content.resource === 'cypress/e2e/hook-describe-error.cy.js.after passes'
          )
          const failedTestDescribe = events.find(
            event => event.content.resource === 'cypress/e2e/hook-describe-error.cy.js.after will be marked as failed'
          )
          const skippedTestDescribe = events.find(
            event => event.content.resource === 'cypress/e2e/hook-describe-error.cy.js.before will be skipped'
          )
          assert.equal(passedTestDescribe.content.meta[TEST_STATUS], 'pass')
          assert.equal(failedTestDescribe.content.meta[TEST_STATUS], 'fail')
          assert.include(failedTestDescribe.content.meta[ERROR_MESSAGE], 'error in after hook')
          assert.equal(skippedTestDescribe.content.meta[TEST_STATUS], 'skip')
          assert.equal(describeHookSuite.content.meta[TEST_STATUS], 'fail')
          assert.include(describeHookSuite.content.meta[ERROR_MESSAGE], 'error in after hook')
        }, 25000)

      const {
        NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
        ...restEnvVars
      } = getCiVisEvpProxyConfig(receiver.port)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...restEnvVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`
          },
          stdio: 'pipe'
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise
      ])
    })

    it('can run and report tests', async () => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

          metadataDicts.forEach(metadata => {
            for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
              assert.equal(metadata[testLevel][TEST_SESSION_NAME], 'my-test-session')
            }
          })
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSessionEvent = events.find(event => event.type === 'test_session_end')
          const testModuleEvent = events.find(event => event.type === 'test_module_end')
          const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
          const testEvents = events.filter(event => event.type === 'test')

          const { content: testSessionEventContent } = testSessionEvent
          const { content: testModuleEventContent } = testModuleEvent

          assert.exists(testSessionEventContent.test_session_id)
          assert.exists(testSessionEventContent.meta[TEST_COMMAND])
          assert.exists(testSessionEventContent.meta[TEST_TOOLCHAIN])
          assert.equal(testSessionEventContent.resource.startsWith('test_session.'), true)
          assert.equal(testSessionEventContent.meta[TEST_STATUS], 'fail')

          assert.exists(testModuleEventContent.test_session_id)
          assert.exists(testModuleEventContent.test_module_id)
          assert.exists(testModuleEventContent.meta[TEST_COMMAND])
          assert.exists(testModuleEventContent.meta[TEST_MODULE])
          assert.equal(testModuleEventContent.resource.startsWith('test_module.'), true)
          assert.equal(testModuleEventContent.meta[TEST_STATUS], 'fail')
          assert.equal(
            testModuleEventContent.test_session_id.toString(10),
            testSessionEventContent.test_session_id.toString(10)
          )
          assert.exists(testModuleEventContent.meta[TEST_FRAMEWORK_VERSION])

          assert.includeMembers(testSuiteEvents.map(suite => suite.content.resource), [
            'test_suite.cypress/e2e/other.cy.js',
            'test_suite.cypress/e2e/spec.cy.js'
          ])

          assert.includeMembers(testSuiteEvents.map(suite => suite.content.meta[TEST_STATUS]), [
            'pass',
            'fail'
          ])

          testSuiteEvents.forEach(({
            content: {
              meta,
              metrics,
              test_suite_id: testSuiteId,
              test_module_id: testModuleId,
              test_session_id: testSessionId
            }
          }) => {
            assert.exists(meta[TEST_COMMAND])
            assert.exists(meta[TEST_MODULE])
            assert.exists(testSuiteId)
            assert.equal(testModuleId.toString(10), testModuleEventContent.test_module_id.toString(10))
            assert.equal(testSessionId.toString(10), testSessionEventContent.test_session_id.toString(10))
            assert.isTrue(meta[TEST_SOURCE_FILE].startsWith('cypress/e2e/'))
            assert.equal(metrics[TEST_SOURCE_START], 1)
            assert.exists(metrics[DD_HOST_CPU_COUNT])
          })

          assert.includeMembers(testEvents.map(test => test.content.resource), [
            'cypress/e2e/other.cy.js.context passes',
            'cypress/e2e/spec.cy.js.context passes',
            'cypress/e2e/spec.cy.js.other context fails'
          ])

          assert.includeMembers(testEvents.map(test => test.content.meta[TEST_STATUS]), [
            'pass',
            'pass',
            'fail'
          ])

          testEvents.forEach(({
            content: {
              meta,
              metrics,
              test_suite_id: testSuiteId,
              test_module_id: testModuleId,
              test_session_id: testSessionId
            }
          }) => {
            assert.exists(meta[TEST_COMMAND])
            assert.exists(meta[TEST_MODULE])
            assert.exists(testSuiteId)
            assert.equal(testModuleId.toString(10), testModuleEventContent.test_module_id.toString(10))
            assert.equal(testSessionId.toString(10), testSessionEventContent.test_session_id.toString(10))
            assert.equal(meta[TEST_SOURCE_FILE].startsWith('cypress/e2e/'), true)
            // Can read DD_TAGS
            assert.propertyVal(meta, DD_TEST_IS_USER_PROVIDED_SERVICE, 'false')
            assert.propertyVal(meta, 'test.customtag', 'customvalue')
            assert.propertyVal(meta, 'test.customtag2', 'customvalue2')
            assert.exists(metrics[DD_HOST_CPU_COUNT])
          })
        }, 25000)

      const {
        NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
        ...restEnvVars
      } = getCiVisEvpProxyConfig(receiver.port)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...restEnvVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2',
            DD_TEST_SESSION_NAME: 'my-test-session',
            DD_SERVICE: undefined
          },
          stdio: 'pipe'
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise
      ])
    })

    it('can report code coverage if it is available', async () => {
      const {
        NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
        ...restEnvVars
      } = getCiVisAgentlessConfig(receiver.port)

      const receiverPromise = receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcov', payloads => {
        const [{ payload: coveragePayloads }] = payloads

        const coverages = coveragePayloads.map(coverage => coverage.content)
          .flatMap(content => content.coverages)

        coverages.forEach(coverage => {
          assert.property(coverage, 'test_session_id')
          assert.property(coverage, 'test_suite_id')
          assert.property(coverage, 'span_id')
          assert.property(coverage, 'files')
        })

        const fileNames = coverages
          .flatMap(coverageAttachment => coverageAttachment.files)
          .map(file => file.filename)

        assert.includeMembers(fileNames, Object.keys(coverageFixture))
      }, 20000)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...restEnvVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/spec.cy.js'
          },
          stdio: 'pipe'
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise
      ])
    })

    context('intelligent test runner', () => {
      it('can report git metadata', async () => {
        const searchCommitsRequestPromise = receiver.payloadReceived(
          ({ url }) => url.endsWith('/api/v2/git/repository/search_commits')
        )
        const packfileRequestPromise = receiver
          .payloadReceived(({ url }) => url.endsWith('/api/v2/git/repository/packfile'))

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/spec.cy.js'
            },
            stdio: 'pipe'
          }
        )

        const [, searchCommitRequest, packfileRequest] = await Promise.all([
          once(childProcess, 'exit'),
          searchCommitsRequestPromise,
          packfileRequestPromise
        ])
        assert.propertyVal(searchCommitRequest.headers, 'dd-api-key', '1')
        assert.propertyVal(packfileRequest.headers, 'dd-api-key', '1')
      })

      it('does not report code coverage if disabled by the API', async () => {
        let hasReportedCodeCoverage = false
        receiver.setSettings({
          code_coverage: false,
          tests_skipping: false
        })

        receiver.assertPayloadReceived(() => {
          hasReportedCodeCoverage = true
        }, ({ url }) => url.endsWith('/api/v2/citestcov')).catch(() => {})

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const eventTypes = events.map(event => event.type)
            assert.includeMembers(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
          }, 25000)

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/spec.cy.js'
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise
        ])
        assert.isFalse(hasReportedCodeCoverage)
      })

      it('can skip tests received by the intelligent test runner API and still reports code coverage', async () => {
        receiver.setSuitesToSkip([{
          type: 'test',
          attributes: {
            name: 'context passes',
            suite: 'cypress/e2e/other.cy.js'
          }
        }])
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const eventTypes = events.map(event => event.type)

            const skippedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/other.cy.js.context passes'
            ).content
            assert.propertyVal(skippedTest.meta, TEST_STATUS, 'skip')
            assert.propertyVal(skippedTest.meta, TEST_SKIPPED_BY_ITR, 'true')

            assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'true')
            assert.propertyVal(testSession.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
            assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
            assert.propertyVal(testSession.metrics, TEST_ITR_SKIPPING_COUNT, 1)
            assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_TYPE, 'test')
            const testModule = events.find(event => event.type === 'test_module_end').content
            assert.propertyVal(testModule.meta, TEST_ITR_TESTS_SKIPPED, 'true')
            assert.propertyVal(testModule.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
            assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
            assert.propertyVal(testModule.metrics, TEST_ITR_SKIPPING_COUNT, 1)
            assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_TYPE, 'test')
          }, 25000)

        const coverageRequestPromise = receiver
          .payloadReceived(({ url }) => url.endsWith('/api/v2/citestcov'))
          .then(coverageRequest => {
            assert.propertyVal(coverageRequest.headers, 'dd-api-key', '1')
          })

        const skippableRequestPromise = receiver
          .payloadReceived(({ url }) => url.endsWith('/api/v2/ci/tests/skippable'))
          .then(skippableRequest => {
            assert.propertyVal(skippableRequest.headers, 'dd-api-key', '1')
          })

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/{other,spec}.cy.js'
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
          skippableRequestPromise,
          coverageRequestPromise
        ])
      })

      it('does not skip tests if test skipping is disabled by the API', async () => {
        let hasRequestedSkippable = false
        receiver.setSettings({
          code_coverage: true,
          tests_skipping: false
        })

        receiver.setSuitesToSkip([{
          type: 'test',
          attributes: {
            name: 'context passes',
            suite: 'cypress/e2e/other.cy.js'
          }
        }])

        receiver.assertPayloadReceived(() => {
          hasRequestedSkippable = true
        }, ({ url }) => url.endsWith('/api/v2/ci/tests/skippable')).catch(() => {})

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const notSkippedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/other.cy.js.context passes'
            )
            assert.exists(notSkippedTest)
            assert.equal(notSkippedTest.content.meta[TEST_STATUS], 'pass')
          }, 25000)

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/other.cy.js'
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise
        ])
        assert.isFalse(hasRequestedSkippable)
      })

      it('does not skip tests if suite is marked as unskippable', async () => {
        receiver.setSettings({
          code_coverage: true,
          tests_skipping: true
        })

        receiver.setSuitesToSkip([
          {
            type: 'test',
            attributes: {
              name: 'context passes',
              suite: 'cypress/e2e/other.cy.js'
            }
          },
          {
            type: 'test',
            attributes: {
              name: 'context passes',
              suite: 'cypress/e2e/spec.cy.js'
            }
          }
        ])
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            const testModule = events.find(event => event.type === 'test_session_end').content

            assert.propertyVal(testSession.meta, TEST_ITR_UNSKIPPABLE, 'true')
            assert.propertyVal(testSession.meta, TEST_ITR_FORCED_RUN, 'true')
            assert.propertyVal(testModule.meta, TEST_ITR_UNSKIPPABLE, 'true')
            assert.propertyVal(testModule.meta, TEST_ITR_FORCED_RUN, 'true')

            const unskippablePassedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/spec.cy.js.context passes'
            )
            const unskippableFailedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/spec.cy.js.other context fails'
            )
            assert.propertyVal(unskippablePassedTest.content.meta, TEST_STATUS, 'pass')
            assert.propertyVal(unskippablePassedTest.content.meta, TEST_ITR_UNSKIPPABLE, 'true')
            assert.propertyVal(unskippablePassedTest.content.meta, TEST_ITR_FORCED_RUN, 'true')

            assert.propertyVal(unskippableFailedTest.content.meta, TEST_STATUS, 'fail')
            assert.propertyVal(unskippableFailedTest.content.meta, TEST_ITR_UNSKIPPABLE, 'true')
            // This was not going to be skipped
            assert.notProperty(unskippableFailedTest.content.meta, TEST_ITR_FORCED_RUN)
          }, 25000)

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/{other,spec}.cy.js'
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise
        ])
      })

      it('only sets forced to run if test was going to be skipped by ITR', async () => {
        receiver.setSettings({
          code_coverage: true,
          tests_skipping: true
        })

        receiver.setSuitesToSkip([
          {
            type: 'test',
            attributes: {
              name: 'context passes',
              suite: 'cypress/e2e/other.cy.js'
            }
          }
        ])

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            const testModule = events.find(event => event.type === 'test_session_end').content

            assert.propertyVal(testSession.meta, TEST_ITR_UNSKIPPABLE, 'true')
            assert.notProperty(testSession.meta, TEST_ITR_FORCED_RUN)
            assert.propertyVal(testModule.meta, TEST_ITR_UNSKIPPABLE, 'true')
            assert.notProperty(testModule.meta, TEST_ITR_FORCED_RUN)

            const unskippablePassedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/spec.cy.js.context passes'
            )
            const unskippableFailedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/spec.cy.js.other context fails'
            )
            assert.propertyVal(unskippablePassedTest.content.meta, TEST_STATUS, 'pass')
            assert.propertyVal(unskippablePassedTest.content.meta, TEST_ITR_UNSKIPPABLE, 'true')
            // This was not going to be skipped
            assert.notProperty(unskippablePassedTest.content.meta, TEST_ITR_FORCED_RUN)

            assert.propertyVal(unskippableFailedTest.content.meta, TEST_STATUS, 'fail')
            assert.propertyVal(unskippableFailedTest.content.meta, TEST_ITR_UNSKIPPABLE, 'true')
            // This was not going to be skipped
            assert.notProperty(unskippableFailedTest.content.meta, TEST_ITR_FORCED_RUN)
          }, 25000)

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/{other,spec}.cy.js'
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise
        ])
      })

      it('sets _dd.ci.itr.tests_skipped to false if the received test is not skipped', async () => {
        receiver.setSuitesToSkip([{
          type: 'test',
          attributes: {
            name: 'fake name',
            suite: 'i/dont/exist.spec.js'
          }
        }])
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'false')
            assert.propertyVal(testSession.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
            assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
            assert.propertyVal(testSession.metrics, TEST_ITR_SKIPPING_COUNT, 0)
            const testModule = events.find(event => event.type === 'test_module_end').content
            assert.propertyVal(testModule.meta, TEST_ITR_TESTS_SKIPPED, 'false')
            assert.propertyVal(testModule.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
            assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
            assert.propertyVal(testModule.metrics, TEST_ITR_SKIPPING_COUNT, 0)
          }, 25000)

        const skippableRequestPromise = receiver
          .payloadReceived(({ url }) => url.endsWith('/api/v2/ci/tests/skippable'))
          .then(skippableRequest => {
            assert.propertyVal(skippableRequest.headers, 'dd-api-key', '1')
          })

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/spec.cy.js'
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
          skippableRequestPromise
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
              assert.equal(test.itr_correlation_id, itrCorrelationId)
            })
          }, 25000)

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisAgentlessConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/spec.cy.js'
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise
        ])
      })

      it('reports code coverage relative to the repository root, not working directory', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: true,
          tests_skipping: false
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

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisAgentlessConfig(receiver.port)

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
            const coveredFiles = payloads
              .flatMap(({ payload }) => payload)
              .flatMap(({ content: { coverages } }) => coverages)
              .flatMap(({ files }) => files)
              .map(({ filename }) => filename)

            assert.includeMembers(coveredFiles, [
              'ci-visibility/subproject/src/utils.tsx',
              'ci-visibility/subproject/src/App.tsx',
              'ci-visibility/subproject/src/index.tsx',
              'ci-visibility/subproject/cypress/e2e/spec.cy.js'
            ])
          }, 10000)

        childProcess = exec(
          command,
          {
            cwd: `${cwd}/ci-visibility/subproject`,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`
            },
            stdio: 'inherit'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise
        ])
      })
    })

    it('still reports correct format if there is a plugin incompatibility', async () => {
      const {
        NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
        ...restEnvVars
      } = getCiVisEvpProxyConfig(receiver.port)

      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          const testModuleEvent = events.find(event => event.type === 'test_module_end')

          testEvents.forEach(testEvent => {
            assert.exists(testEvent.content.test_suite_id)
            assert.exists(testEvent.content.test_module_id)
            assert.exists(testEvent.content.test_session_id)
            assert.notEqual(testEvent.content.test_suite_id, testModuleEvent.content.test_module_id)
          })
        })

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...restEnvVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            CYPRESS_ENABLE_INCOMPATIBLE_PLUGIN: '1',
            SPEC_PATTERN: 'cypress/e2e/spec.cy.js'
          },
          stdio: 'pipe'
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise
      ])
    })

    it('works if after:run is explicitly used', async () => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSessionEvent = events.find(event => event.type === 'test_session_end')
          assert.exists(testSessionEvent)
          const testModuleEvent = events.find(event => event.type === 'test_module_end')
          assert.exists(testModuleEvent)
          const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
          assert.equal(testSuiteEvents.length, 4)
          const testEvents = events.filter(event => event.type === 'test')
          assert.equal(testEvents.length, 9)
        }, 30000)

      const {
        NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
        ...restEnvVars
      } = getCiVisEvpProxyConfig(receiver.port)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...restEnvVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            CYPRESS_ENABLE_AFTER_RUN_CUSTOM: '1'
          },
          stdio: 'pipe'
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise
      ])
    })

    it('works if after:spec is explicitly used', async () => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSessionEvent = events.find(event => event.type === 'test_session_end')
          assert.exists(testSessionEvent)
          const testModuleEvent = events.find(event => event.type === 'test_module_end')
          assert.exists(testModuleEvent)
          const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
          assert.equal(testSuiteEvents.length, 4)
          const testEvents = events.filter(event => event.type === 'test')
          assert.equal(testEvents.length, 9)
        }, 30000)

      const {
        NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
        ...restEnvVars
      } = getCiVisEvpProxyConfig(receiver.port)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...restEnvVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            CYPRESS_ENABLE_AFTER_SPEC_CUSTOM: '1'
          },
          stdio: 'pipe'
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise
      ])
    })

    context('early flake detection', () => {
      it('retries new tests', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: true
        })

        receiver.setKnownTests({
          cypress: {
            'cypress/e2e/spec.cy.js': [
              // 'context passes', // This test will be considered new
              'other context fails'
            ]
          }
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.equal(tests.length, 5)

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.equal(newTests.length, NUM_RETRIES_EFD + 1)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, NUM_RETRIES_EFD)

            retriedTests.forEach((retriedTest) => {
              assert.equal(retriedTest.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
            })

            newTests.forEach(newTest => {
              assert.equal(newTest.resource, 'cypress/e2e/spec.cy.js.context passes')
            })

            const knownTest = tests.filter(test => !test.meta[TEST_IS_NEW])
            assert.equal(knownTest.length, 1)
            assert.equal(knownTest[0].resource, 'cypress/e2e/spec.cy.js.other context fails')

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')
          })

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/spec.cy.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise
        ])
      })

      it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: true
        })

        receiver.setKnownTests({
          cypress: {
            'cypress/e2e/spec.cy.js': [
              // 'context passes', // This test will be considered new
              'other context fails'
            ]
          }
        })

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.equal(tests.length, 2)

            // new tests are detected but not retried
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.equal(newTests.length, 1)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)
          })

        const specToRun = 'cypress/e2e/spec.cy.js'
        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
              DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false'
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise
        ])
      })

      it('does not retry tests that are skipped', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: true
        })

        receiver.setKnownTests({
          cypress: {}
        })

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.equal(tests.length, 1)

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.equal(newTests.length, 0)

            assert.equal(tests[0].resource, 'cypress/e2e/skipped-test.js.skipped skipped')
            assert.propertyVal(tests[0].meta, TEST_STATUS, 'skip')

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')
          })

        const specToRun = 'cypress/e2e/skipped-test.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/skipped-test.js'
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise
        ])
      })

      it('does not run EFD if the known tests request fails', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: true
        })

        receiver.setKnownTestsResponseCode(500)
        receiver.setKnownTests({
          cypress: {}
        })

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.equal(tests.length, 2)

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.equal(newTests.length, 0)
          })

        const specToRun = 'cypress/e2e/spec.cy.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise
        ])
      })

      it('disables early flake detection if known tests should not be requested', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: false
        })

        receiver.setKnownTests({
          cypress: {
            'cypress/e2e/spec.cy.js': [
              // 'context passes', // This test will be considered new
              'other context fails'
            ]
          }
        })

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.equal(tests.length, 2)

            // new tests are not detected
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.equal(newTests.length, 0)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)
          }, 25000)

        const specToRun = 'cypress/e2e/spec.cy.js'
        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
              DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false'
            },
            stdio: 'pipe'
          }
        )

        // TODO: remove this once we have figured out flakiness
        childProcess.stdout.pipe(process.stdout)
        childProcess.stderr.pipe(process.stderr)

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise
        ])
      })

      it('disables early flake detection if known tests response is invalid', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: false
        })

        receiver.setKnownTests({
          'not-cypress': {
            'cypress/e2e/spec.cy.js': [
              'other context fails'
            ]
          }
        })

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.equal(tests.length, 2)

            // new tests are not detected
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.equal(newTests.length, 0)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)
          }, 25000)

        const specToRun = 'cypress/e2e/spec.cy.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
            },
            stdio: 'pipe'
          }
        )

        // TODO: remove this once we have figured out flakiness
        childProcess.stdout.pipe(process.stdout)
        childProcess.stderr.pipe(process.stderr)

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })
    })

    context('flaky test retries', () => {
      it('retries flaky tests', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false
          }
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
            assert.equal(testSuites.length, 1)
            assert.equal(testSuites[0].meta[TEST_STATUS], 'fail')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.equal(tests.length, 10)

            assert.includeMembers(tests.map(test => test.resource), [
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
              'cypress/e2e/flaky-test-retries.js.flaky test retry always passes'
            ])

            const eventuallyPassingTest = tests.filter(
              test => test.resource === 'cypress/e2e/flaky-test-retries.js.flaky test retry eventually passes'
            )
            assert.equal(eventuallyPassingTest.length, 3)
            assert.equal(eventuallyPassingTest.filter(test => test.meta[TEST_STATUS] === 'fail').length, 2)
            assert.equal(eventuallyPassingTest.filter(test => test.meta[TEST_STATUS] === 'pass').length, 1)
            assert.equal(eventuallyPassingTest.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 2)
            assert.equal(eventuallyPassingTest.filter(test =>
              test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            ).length, 2)

            const neverPassingTest = tests.filter(
              test => test.resource === 'cypress/e2e/flaky-test-retries.js.flaky test retry never passes'
            )
            assert.equal(neverPassingTest.length, 6)
            assert.equal(neverPassingTest.filter(test => test.meta[TEST_STATUS] === 'fail').length, 6)
            assert.equal(neverPassingTest.filter(test => test.meta[TEST_STATUS] === 'pass').length, 0)
            assert.equal(neverPassingTest.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 5)
            assert.equal(neverPassingTest.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            ).length, 5)
          }, 30000)

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/flaky-test-retries.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise
        ])
      })

      it('is disabled if DD_CIVISIBILITY_FLAKY_RETRY_ENABLED is false', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false
          }
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
            assert.equal(testSuites.length, 1)
            assert.equal(testSuites[0].meta[TEST_STATUS], 'fail')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.equal(tests.length, 3)

            assert.includeMembers(tests.map(test => test.resource), [
              'cypress/e2e/flaky-test-retries.js.flaky test retry eventually passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry never passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry always passes'
            ])
            assert.equal(tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr).length, 0)
          })

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/flaky-test-retries.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false',
              SPEC_PATTERN: specToRun
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise
        ])
      })

      it('retries DD_CIVISIBILITY_FLAKY_RETRY_COUNT times', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false
          }
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
            assert.equal(testSuites.length, 1)
            assert.equal(testSuites[0].meta[TEST_STATUS], 'fail')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.equal(tests.length, 5)

            assert.includeMembers(tests.map(test => test.resource), [
              'cypress/e2e/flaky-test-retries.js.flaky test retry eventually passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry eventually passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry never passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry never passes',
              'cypress/e2e/flaky-test-retries.js.flaky test retry always passes'
            ])

            assert.equal(tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr).length, 2)
          })

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/flaky-test-retries.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: 1,
              SPEC_PATTERN: specToRun
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise
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

      const {
        NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
        ...restEnvVars
      } = getCiVisAgentlessConfig(receiver.port)

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const test = events.find(event => event.type === 'test').content
          const testSuite = events.find(event => event.type === 'test_suite_end').content
          // The test is in a subproject
          assert.notEqual(test.meta[TEST_SOURCE_FILE], test.meta[TEST_SUITE])
          assert.equal(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
          assert.equal(testSuite.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
        }, 25000)

      childProcess = exec(
        command,
        {
          cwd: `${cwd}/ci-visibility/subproject`,
          env: {
            ...restEnvVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`
          },
          stdio: 'inherit'
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise
      ])
    })

    context('known tests without early flake detection', () => {
      it('detects new tests without retrying them', async () => {
        receiver.setSettings({
          known_tests_enabled: true
        })

        receiver.setKnownTests({
          cypress: {
            'cypress/e2e/spec.cy.js': [
              // 'context passes', // This test will be considered new
              'other context fails'
            ]
          }
        })

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.equal(tests.length, 2)

            // new tests are detected but not retried
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.equal(newTests.length, 1)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)
          })

        const specToRun = 'cypress/e2e/spec.cy.js'
        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
              DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false'
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise
        ])
      })
    })

    // cy.origin is not available in old versions of Cypress
    if (version === 'latest') {
      it('does not crash for multi origin tests', async () => {
        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            assert.equal(events.length, 4)

            const test = events.find(event => event.type === 'test').content
            assert.equal(test.resource, 'cypress/e2e/multi-origin.js.tests multiple origins')
            assert.equal(test.meta[TEST_STATUS], 'pass')
          })

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
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              CYPRESS_BASE_URL_SECOND: `http://localhost:${secondWebAppPort}`,
              SPEC_PATTERN: specToRun,
              DD_TRACE_DEBUG: true
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          once(childProcess.stdout, 'end'),
          once(childProcess.stderr, 'end'),
          receiverPromise
        ])
      })
    }

    it('sets _dd.test.is_user_provided_service to true if DD_SERVICE is used', async () => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')

          testEvents.forEach(({ content: { meta } }) => {
            assert.propertyVal(meta, DD_TEST_IS_USER_PROVIDED_SERVICE, 'true')
          })
        }, 25000)

      const {
        NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
        ...restEnvVars
      } = getCiVisEvpProxyConfig(receiver.port)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...restEnvVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            DD_SERVICE: 'my-service'
          },
          stdio: 'pipe'
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise
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
                        attempt_to_fix: true
                      }
                    }
                  }
                }
              }
            }
          })
        })

        const getTestAssertions = ({
          isAttemptToFix,
          shouldAlwaysPass,
          shouldFailSometimes,
          isQuarantined,
          isDisabled
        }) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const testSession = events.find(event => event.type === 'test_session_end').content

              if (isAttemptToFix) {
                assert.propertyVal(testSession.meta, TEST_MANAGEMENT_ENABLED, 'true')
              } else {
                assert.notProperty(testSession.meta, TEST_MANAGEMENT_ENABLED)
              }

              const resourceNames = tests.map(span => span.resource)

              assert.includeMembers(resourceNames,
                [
                  'cypress/e2e/attempt-to-fix.js.attempt to fix is attempt to fix'
                ]
              )

              const attemptToFixTests = tests.filter(
                test => test.meta[TEST_NAME] === 'attempt to fix is attempt to fix'
              )

              if (isAttemptToFix) {
                assert.equal(attemptToFixTests.length, 4)
              } else {
                assert.equal(attemptToFixTests.length, 1)
              }

              for (let i = attemptToFixTests.length - 1; i >= 0; i--) {
                const test = attemptToFixTests[i]
                if (!isAttemptToFix) {
                  assert.notProperty(test.meta, TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX)
                  assert.notProperty(test.meta, TEST_IS_RETRY)
                  assert.notProperty(test.meta, TEST_RETRY_REASON)
                  continue
                }
                if (isQuarantined) {
                  assert.propertyVal(test.meta, TEST_MANAGEMENT_IS_QUARANTINED, 'true')
                  assert.notPropertyVal(test.meta, TEST_STATUS, 'skip')
                }
                if (isDisabled) {
                  assert.propertyVal(test.meta, TEST_MANAGEMENT_IS_DISABLED, 'true')
                  assert.notPropertyVal(test.meta, TEST_STATUS, 'skip')
                }

                const isLastAttempt = i === attemptToFixTests.length - 1
                const isFirstAttempt = i === 0
                assert.propertyVal(test.meta, TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX, 'true')
                if (isFirstAttempt) {
                  assert.notProperty(test.meta, TEST_IS_RETRY)
                  assert.notProperty(test.meta, TEST_RETRY_REASON)
                } else {
                  assert.propertyVal(test.meta, TEST_IS_RETRY, 'true')
                  assert.propertyVal(test.meta, TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atf)
                }
                if (isLastAttempt) {
                  if (shouldFailSometimes) {
                    assert.notProperty(test.meta, TEST_HAS_FAILED_ALL_RETRIES)
                    assert.propertyVal(test.meta, TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
                  } else if (shouldAlwaysPass) {
                    assert.propertyVal(test.meta, TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'true')
                    assert.notProperty(test.meta, TEST_HAS_FAILED_ALL_RETRIES)
                  } else {
                    assert.propertyVal(test.meta, TEST_HAS_FAILED_ALL_RETRIES, 'true')
                    assert.propertyVal(test.meta, TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
                  }
                }
              }
            })

        const runAttemptToFixTest = async ({
          isAttemptToFix,
          shouldAlwaysPass,
          shouldFailSometimes,
          isQuarantined,
          isDisabled,
          extraEnvVars = {}
        } = {}) => {
          const testAssertionsPromise = getTestAssertions({
            isAttemptToFix,
            shouldAlwaysPass,
            shouldFailSometimes,
            isQuarantined,
            isDisabled
          })

          const {
            NODE_OPTIONS,
            ...restEnvVars
          } = getCiVisEvpProxyConfig(receiver.port)

          const specToRun = 'cypress/e2e/attempt-to-fix.js'

          childProcess = exec(
            version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
            {
              cwd,
              env: {
                ...restEnvVars,
                CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
                SPEC_PATTERN: specToRun,
                ...extraEnvVars,
                ...(shouldAlwaysPass ? { CYPRESS_SHOULD_ALWAYS_PASS: '1' } : {}),
                ...(shouldFailSometimes ? { CYPRESS_SHOULD_FAIL_SOMETIMES: '1' } : {})
              },
              stdio: 'pipe'
            }
          )

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            testAssertionsPromise
          ])

          if (shouldAlwaysPass) {
            assert.equal(exitCode, 0)
          } else {
            // TODO: we need to figure out how to trick cypress into returning exit code 0
            // even if there are failed tests
            assert.equal(exitCode, 1)
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

        /**
         * TODO:
         * The spec says that quarantined tests that are not attempted to fix should be run and their result ignored.
         * Cypress will skip the test instead.
         *
         * When a test is quarantined and attempted to fix, the spec is to run the test and ignore its result.
         * Cypress will run the test, but it won't ignore its result.
         */
        it('can mark tests as quarantined and tests are not skipped', async () => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
          receiver.setTestManagementTests({
            cypress: {
              suites: {
                'cypress/e2e/attempt-to-fix.js': {
                  tests: {
                    'attempt to fix is attempt to fix': {
                      properties: {
                        attempt_to_fix: true,
                        quarantined: true
                      }
                    }
                  }
                }
              }
            }
          })

          await runAttemptToFixTest({ isAttemptToFix: true, isQuarantined: true })
        })

        /**
         * TODO:
         * When a test is disabled and attempted to fix, the spec is to run the test and ignore its result.
         * Cypress will run the test, but it won't ignore its result.
         */
        it('can mark tests as disabled and tests are not skipped', async () => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
          receiver.setTestManagementTests({
            cypress: {
              suites: {
                'cypress/e2e/attempt-to-fix.js': {
                  tests: {
                    'attempt to fix is attempt to fix': {
                      properties: {
                        attempt_to_fix: true,
                        disabled: true
                      }
                    }
                  }
                }
              }
            }
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
                        disabled: true
                      }
                    }
                  }
                }
              }
            }
          })
        })

        const getTestAssertions = (isDisabling) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const failedTest = events.find(event => event.type === 'test').content
              const testSession = events.find(event => event.type === 'test_session_end').content

              if (isDisabling) {
                assert.propertyVal(testSession.meta, TEST_MANAGEMENT_ENABLED, 'true')
              } else {
                assert.notProperty(testSession.meta, TEST_MANAGEMENT_ENABLED)
              }

              assert.equal(failedTest.resource, 'cypress/e2e/disable.js.disable is disabled')

              if (isDisabling) {
                assert.propertyVal(failedTest.meta, TEST_STATUS, 'skip')
                assert.propertyVal(failedTest.meta, TEST_MANAGEMENT_IS_DISABLED, 'true')
              } else {
                assert.propertyVal(failedTest.meta, TEST_STATUS, 'fail')
                assert.notProperty(failedTest.meta, TEST_MANAGEMENT_IS_DISABLED)
              }
            })

        const runDisableTest = async (isDisabling, extraEnvVars = {}) => {
          const testAssertionsPromise = getTestAssertions(isDisabling)

          const {
            NODE_OPTIONS,
            ...restEnvVars
          } = getCiVisEvpProxyConfig(receiver.port)

          const specToRun = 'cypress/e2e/disable.js'

          childProcess = exec(
            version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
            {
              cwd,
              env: {
                ...restEnvVars,
                CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
                SPEC_PATTERN: specToRun,
                ...extraEnvVars
              },
              stdio: 'pipe'
            }
          )

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            testAssertionsPromise
          ])

          if (isDisabling) {
            assert.equal(exitCode, 0)
          } else {
            assert.equal(exitCode, 1)
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
                        quarantined: true
                      }
                    }
                  }
                }
              }
            }
          })
        })

        const getTestAssertions = (isQuarantining) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const failedTest = events.find(event => event.type === 'test').content
              const testSession = events.find(event => event.type === 'test_session_end').content

              if (isQuarantining) {
                assert.propertyVal(testSession.meta, TEST_MANAGEMENT_ENABLED, 'true')
              } else {
                assert.notProperty(testSession.meta, TEST_MANAGEMENT_ENABLED)
              }

              assert.equal(failedTest.resource, 'cypress/e2e/quarantine.js.quarantine is quarantined')

              if (isQuarantining) {
                // TODO: run instead of skipping, but ignore its result
                assert.propertyVal(failedTest.meta, TEST_STATUS, 'skip')
                assert.propertyVal(failedTest.meta, TEST_MANAGEMENT_IS_QUARANTINED, 'true')
              } else {
                assert.propertyVal(failedTest.meta, TEST_STATUS, 'fail')
                assert.notProperty(failedTest.meta, TEST_MANAGEMENT_IS_QUARANTINED)
              }
            })

        const runQuarantineTest = async (isQuarantining, extraEnvVars = {}) => {
          const testAssertionsPromise = getTestAssertions(isQuarantining)

          const {
            NODE_OPTIONS,
            ...restEnvVars
          } = getCiVisEvpProxyConfig(receiver.port)

          const specToRun = 'cypress/e2e/quarantine.js'

          childProcess = exec(
            version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
            {
              cwd,
              env: {
                ...restEnvVars,
                CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
                SPEC_PATTERN: specToRun,
                ...extraEnvVars
              },
              stdio: 'pipe'
            }
          )

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            testAssertionsPromise
          ])

          if (isQuarantining) {
            assert.equal(exitCode, 0)
          } else {
            assert.equal(exitCode, 1)
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
          flaky_test_retries_enabled: false
        })
        receiver.setTestManagementTestsResponseCode(500)

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.notProperty(testSession.meta, TEST_MANAGEMENT_ENABLED)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            // it is not retried
            assert.equal(tests.length, 1)
          })

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/attempt-to-fix.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
              DD_TRACE_DEBUG: '1'
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise
        ])
      })
    })

    context('libraries capabilities', () => {
      it('adds capabilities to tests', async () => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            assert.isNotEmpty(metadataDicts)
            metadataDicts.forEach(metadata => {
              assert.equal(metadata.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_EARLY_FLAKE_DETECTION], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_AUTO_TEST_RETRIES], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_IMPACTED_TESTS], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX], '5')
              assert.equal(metadata.test[DD_CAPABILITIES_FAILED_TEST_REPLAY], '1')
              // capabilities logic does not overwrite test session name
              assert.equal(metadata.test[TEST_SESSION_NAME], 'my-test-session-name')
            })
          }, 25000)

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/spec.cy.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              DD_TEST_SESSION_NAME: 'my-test-session-name',
              SPEC_PATTERN: specToRun,
            },
            stdio: 'pipe'
          }
        )

        // TODO: remove this once we have figured out flakiness
        childProcess.stdout.pipe(process.stdout)
        childProcess.stderr.pipe(process.stderr)

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise
        ])
      })
    })

    context('impacted tests', () => {
      beforeEach(() => {
        receiver.setKnownTests({
          cypress: {
            'cypress/e2e/impacted-test.js': ['impacted test is impacted test']
          }
        })
      })

      // Add git setup before running impacted tests
      before(function () {
        execSync('git checkout -b feature-branch', { cwd, stdio: 'ignore' })
        fs.writeFileSync(
          path.join(cwd, 'cypress/e2e/impacted-test.js'),
          `/* eslint-disable */
          describe('impacted test', () => {
            it('is impacted test', () => {
              cy.visit('/')
                .get('.hello-world')
                .should('have.text', 'Hello Worldd')
            })
          })`
        )
        execSync('git add cypress/e2e/impacted-test.js', { cwd, stdio: 'ignore' })
        execSync('git commit -m "modify impacted-test.js"', { cwd, stdio: 'ignore' })
      })

      after(function () {
        execSync('git checkout -', { cwd, stdio: 'ignore' })
        execSync('git branch -D feature-branch', { cwd, stdio: 'ignore' })
      })

      const getTestAssertions = ({ isModified, isEfd, isNew }) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isEfd) {
              assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')
            } else {
              assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)
            }

            const resourceNames = tests.map(span => span.resource)

            assert.includeMembers(resourceNames,
              [
                'cypress/e2e/impacted-test.js.impacted test is impacted test'
              ]
            )

            const impactedTests = tests.filter(test =>
              test.meta[TEST_SOURCE_FILE] === 'cypress/e2e/impacted-test.js' &&
              test.meta[TEST_NAME] === 'impacted test is impacted test')

            if (isEfd) {
              assert.equal(impactedTests.length, NUM_RETRIES_EFD + 1) // Retries + original test
            } else {
              assert.equal(impactedTests.length, 1)
            }

            for (const impactedTest of impactedTests) {
              if (isModified) {
                assert.propertyVal(impactedTest.meta, TEST_IS_MODIFIED, 'true')
              } else {
                assert.notProperty(impactedTest.meta, TEST_IS_MODIFIED)
              }
              if (isNew) {
                assert.propertyVal(impactedTest.meta, TEST_IS_NEW, 'true')
              } else {
                assert.notProperty(impactedTest.meta, TEST_IS_NEW)
              }
            }

            if (isEfd) {
              const retriedTests = tests.filter(
                test => test.meta[TEST_IS_RETRY] === 'true' &&
                test.meta[TEST_NAME] === 'impacted test is impacted test'
              )
              assert.equal(retriedTests.length, NUM_RETRIES_EFD)
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
              assert.equal(retriedTestNew, isNew ? NUM_RETRIES_EFD : 0)
              assert.equal(
                retriedTestsWithReason,
                NUM_RETRIES_EFD
              )
            }
          }, 25000)

      const runImpactedTest = async (
        { isModified, isEfd = false, isNew = false },
        extraEnvVars = {}
      ) => {
        const testAssertionsPromise = getTestAssertions({ isModified, isEfd, isNew })

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/impacted-test.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
              GITHUB_BASE_REF: '',
              ...extraEnvVars
            },
            stdio: 'pipe'
          }
        )

        // TODO: remove this once we have figured out flakiness
        childProcess.stdout.pipe(process.stdout)
        childProcess.stderr.pipe(process.stderr)

        await Promise.all([
          once(childProcess, 'exit'),
          testAssertionsPromise
        ])
      }

      context('test is not new', () => {
        it('should be detected as impacted', async () => {
          receiver.setSettings({ impacted_tests_enabled: true })

          await runImpactedTest({ isModified: true })
        })

        it('should not be detected as impacted if disabled', async () => {
          receiver.setSettings({ impacted_tests_enabled: false })

          await runImpactedTest({ isModified: false })
        })

        it('should not be detected as impacted if DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED is false',
          async () => {
            receiver.setSettings({ impacted_tests_enabled: true })

            await runImpactedTest(
              { isModified: false },
              { DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: '0' }
            )
          })
      })

      context('test is new', () => {
        it('should be retried and marked both as new and modified', async () => {
          receiver.setKnownTests({
            cypress: {}
          })
          receiver.setSettings({
            impacted_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD
              }
            },
            known_tests_enabled: true
          })
          await runImpactedTest(
            { isModified: true, isEfd: true, isNew: true }
          )
        })
      })
    })
  })
})
