'use strict'

const assert = require('node:assert/strict')
const { exec, execSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

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
const coverageFixture = require('../ci-visibility/fixtures/istanbul-map-fixture.json')
const {
  TEST_STATUS,
  TEST_COMMAND,
  TEST_MODULE,
  TEST_FRAMEWORK,
  TEST_FRAMEWORK_VERSION,
  TEST_TYPE,
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
  TEST_IS_MODIFIED,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { ERROR_MESSAGE, ERROR_TYPE, COMPONENT } = require('../../packages/dd-trace/src/constants')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')

const RECEIVER_STOP_TIMEOUT = 20000
const version = process.env.CYPRESS_VERSION
const hookFile = 'dd-trace/loader-hook.mjs'
const NUM_RETRIES_EFD = 3

const over12It = (version === 'latest' || semver.gte(version, '12.0.0')) ? it : it.skip

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

    // cypress-fail-fast is required as an incompatible plugin
    useSandbox([`cypress@${version}`, 'cypress-fail-fast@7.1.0'], true)

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

    it('instruments tests with the APM protocol (old agents)', async () => {
      receiver.setInfoResponse({ endpoints: [] })

      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/v0.4/traces', (payloads) => {
          const testSpans = payloads.flatMap(({ payload }) => payload.flatMap(trace => trace))

          const passedTestSpan = testSpans.find(span =>
            span.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
          )
          const failedTestSpan = testSpans.find(span =>
            span.resource === 'cypress/e2e/basic-fail.js.basic fail suite can fail'
          )

          assertObjectContains(passedTestSpan, {
            name: 'cypress.test',
            resource: 'cypress/e2e/basic-pass.js.basic pass suite can pass',
            type: 'test',
            meta: {
              [TEST_STATUS]: 'pass',
              [TEST_NAME]: 'basic pass suite can pass',
              [TEST_SUITE]: 'cypress/e2e/basic-pass.js',
              [TEST_FRAMEWORK]: 'cypress',
              [TEST_TYPE]: 'browser',
              [TEST_CODE_OWNERS]: JSON.stringify(['@datadog-dd-trace-js']),
              customTag: 'customValue',
              addTagsBeforeEach: 'customBeforeEach',
              addTagsAfterEach: 'customAfterEach',
            },
          })
          assert.match(passedTestSpan.meta[TEST_SOURCE_FILE], /cypress\/e2e\/basic-pass\.js/)
          assert.ok(passedTestSpan.meta[TEST_FRAMEWORK_VERSION])
          assert.ok(passedTestSpan.meta[COMPONENT])
          assert.ok(passedTestSpan.metrics[TEST_SOURCE_START])

          assertObjectContains(failedTestSpan, {
            name: 'cypress.test',
            resource: 'cypress/e2e/basic-fail.js.basic fail suite can fail',
            type: 'test',
            meta: {
              [TEST_STATUS]: 'fail',
              [TEST_NAME]: 'basic fail suite can fail',
              [TEST_SUITE]: 'cypress/e2e/basic-fail.js',
              [TEST_FRAMEWORK]: 'cypress',
              [TEST_TYPE]: 'browser',
              [TEST_CODE_OWNERS]: JSON.stringify(['@datadog-dd-trace-js']),
              customTag: 'customValue',
              addTagsBeforeEach: 'customBeforeEach',
              addTagsAfterEach: 'customAfterEach',
            },
          })
          assert.match(failedTestSpan.meta[TEST_SOURCE_FILE], /cypress\/e2e\/basic-fail\.js/)
          assert.ok(failedTestSpan.meta[TEST_FRAMEWORK_VERSION])
          assert.ok(failedTestSpan.meta[COMPONENT])
          assert.ok(failedTestSpan.meta[ERROR_MESSAGE])
          assert.match(failedTestSpan.meta[ERROR_MESSAGE], /expected/)
          assert.ok(failedTestSpan.meta[ERROR_TYPE])
          assert.ok(failedTestSpan.metrics[TEST_SOURCE_START])
          // Tags added after failure should not be present because test failed
          assert.ok(!('addTagsAfterFailure' in failedTestSpan.meta))
        }, 60000)

      const {
        NODE_OPTIONS,
        ...restEnvVars
      } = getCiVisEvpProxyConfig(receiver.port)

      const specToRun = 'cypress/e2e/basic-*.js'

      // For Cypress 6.7.0, we need to override the --spec flag that's hardcoded in testCommand
      const command = version === '6.7.0'
        ? `./node_modules/.bin/cypress run --config-file cypress-config.json --spec "${specToRun}"`
        : testCommand

      childProcess = exec(
        command,
        {
          cwd,
          env: {
            ...restEnvVars,
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
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            },
          }
        )

        childProcess.stdout?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        await Promise.all([
          once(childProcess, 'exit'),
          once(childProcess.stdout, 'end'),
        ])
        assert.match(
          stdout,
          /WARNING: dd-trace support for Cypress<10.2.0 is deprecated and will not be supported in future versions of dd-trace./
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
            SPEC_PATTERN: 'cypress/e2e/spec.cy.js',
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
        once(childProcess.stdout, 'end'),
        once(childProcess.stderr, 'end'),
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      assert.strictEqual(hasReceivedEvents, false)
      // TODO: remove try/catch once we find the source of flakiness
      try {
        assert.doesNotMatch(testOutput, /TypeError/)
        assert.match(testOutput, /1 of 1 failed/)
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
          assert.strictEqual(passedTest.content.meta[TEST_STATUS], 'pass')
          assert.strictEqual(failedTest.content.meta[TEST_STATUS], 'fail')
          assert.match(failedTest.content.meta[ERROR_MESSAGE], /error in after each hook/)
          assert.strictEqual(skippedTest.content.meta[TEST_STATUS], 'skip')
          assert.strictEqual(testHookSuite.content.meta[TEST_STATUS], 'fail')
          assert.match(testHookSuite.content.meta[ERROR_MESSAGE], /error in after each hook/)

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
          assert.strictEqual(passedTestDescribe.content.meta[TEST_STATUS], 'pass')
          assert.strictEqual(failedTestDescribe.content.meta[TEST_STATUS], 'fail')
          assert.match(failedTestDescribe.content.meta[ERROR_MESSAGE], /error in after hook/)
          assert.strictEqual(skippedTestDescribe.content.meta[TEST_STATUS], 'skip')
          assert.strictEqual(describeHookSuite.content.meta[TEST_STATUS], 'fail')
          assert.match(describeHookSuite.content.meta[ERROR_MESSAGE], /error in after hook/)
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
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })

    it('can run and report tests', async () => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

          metadataDicts.forEach(metadata => {
            for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
              assert.strictEqual(metadata[testLevel][TEST_SESSION_NAME], 'my-test-session')
            }
          })
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSessionEvent = events.find(event => event.type === 'test_session_end')
          const testModuleEvent = events.find(event => event.type === 'test_module_end')
          const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
          const testEvents = events.filter(event => event.type === 'test')

          const { content: testSessionEventContent } = testSessionEvent
          const { content: testModuleEventContent } = testModuleEvent

          assert.ok(testSessionEventContent.test_session_id)
          assert.ok(testSessionEventContent.meta[TEST_COMMAND])
          assert.ok(testSessionEventContent.meta[TEST_TOOLCHAIN])
          assert.strictEqual(testSessionEventContent.resource.startsWith('test_session.'), true)
          assert.strictEqual(testSessionEventContent.meta[TEST_STATUS], 'fail')

          assert.ok(testModuleEventContent.test_session_id)
          assert.ok(testModuleEventContent.test_module_id)
          assert.ok(testModuleEventContent.meta[TEST_COMMAND])
          assert.ok(testModuleEventContent.meta[TEST_MODULE])
          assert.strictEqual(testModuleEventContent.resource.startsWith('test_module.'), true)
          assert.strictEqual(testModuleEventContent.meta[TEST_STATUS], 'fail')
          assert.strictEqual(
            testModuleEventContent.test_session_id.toString(10),
            testSessionEventContent.test_session_id.toString(10)
          )
          assert.ok(testModuleEventContent.meta[TEST_FRAMEWORK_VERSION])

          assertObjectContains(testSuiteEvents.map(suite => suite.content.resource), [
            'test_suite.cypress/e2e/other.cy.js',
            'test_suite.cypress/e2e/spec.cy.js',
          ])

          assertObjectContains(testSuiteEvents.map(suite => suite.content.meta[TEST_STATUS]), [
            'pass',
            'fail',
          ])

          testSuiteEvents.forEach(({
            content: {
              meta,
              metrics,
              test_suite_id: testSuiteId,
              test_module_id: testModuleId,
              test_session_id: testSessionId,
            },
          }) => {
            assert.ok(meta[TEST_COMMAND])
            assert.ok(meta[TEST_MODULE])
            assert.ok(testSuiteId)
            assert.strictEqual(testModuleId.toString(10), testModuleEventContent.test_module_id.toString(10))
            assert.strictEqual(testSessionId.toString(10), testSessionEventContent.test_session_id.toString(10))
            assert.strictEqual(meta[TEST_SOURCE_FILE].startsWith('cypress/e2e/'), true)
            assert.strictEqual(metrics[TEST_SOURCE_START], 1)
            assert.ok(metrics[DD_HOST_CPU_COUNT])
          })

          assertObjectContains(testEvents.map(test => test.content.resource), [
            'cypress/e2e/other.cy.js.context passes',
            'cypress/e2e/spec.cy.js.context passes',
            'cypress/e2e/spec.cy.js.other context fails',
          ])

          assertObjectContains(testEvents.map(test => test.content.meta[TEST_STATUS]), [
            'pass',
            'pass',
            'fail',
          ])

          testEvents.forEach(({
            content: {
              meta,
              metrics,
              test_suite_id: testSuiteId,
              test_module_id: testModuleId,
              test_session_id: testSessionId,
            },
          }) => {
            assert.ok(meta[TEST_COMMAND])
            assert.ok(meta[TEST_MODULE])
            assert.ok(testSuiteId)
            assert.strictEqual(testModuleId.toString(10), testModuleEventContent.test_module_id.toString(10))
            assert.strictEqual(testSessionId.toString(10), testSessionEventContent.test_session_id.toString(10))
            assert.strictEqual(meta[TEST_SOURCE_FILE].startsWith('cypress/e2e/'), true)
            // Can read DD_TAGS
            assert.strictEqual(meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'false')
            assert.strictEqual(meta['test.customtag'], 'customvalue')
            assert.strictEqual(meta['test.customtag2'], 'customvalue2')
            assert.ok(metrics[DD_HOST_CPU_COUNT])
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
            DD_SERVICE: undefined,
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
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
          assert.ok(Object.hasOwn(coverage, 'test_session_id'))
          assert.ok(Object.hasOwn(coverage, 'test_suite_id'))
          assert.ok(Object.hasOwn(coverage, 'span_id'))
          assert.ok(Object.hasOwn(coverage, 'files'))
        })

        const fileNames = coverages
          .flatMap(coverageAttachment => coverageAttachment.files)
          .map(file => file.filename)

        assertObjectContains(fileNames, Object.keys(coverageFixture))
      }, 25000)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...restEnvVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/spec.cy.js',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })

    context('intelligent test runner', () => {
      it('can report git metadata', async () => {
        const searchCommitsRequestPromise = receiver.payloadReceived(
          ({ url }) => url.endsWith('/api/v2/git/repository/search_commits'),
          25000
        )
        const packfileRequestPromise = receiver
          .payloadReceived(({ url }) => url.endsWith('/api/v2/git/repository/packfile'), 25000)

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
            assert.ok(!('TEST_ITR_FORCED_RUN' in unskippableFailedTest.content.meta))
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
            assert.ok(!('TEST_ITR_FORCED_RUN' in testSession.meta))
            assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')
            assert.ok(!('TEST_ITR_FORCED_RUN' in testModule.meta))

            const unskippablePassedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/spec.cy.js.context passes'
            )
            const unskippableFailedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/spec.cy.js.other context fails'
            )
            assert.strictEqual(unskippablePassedTest.content.meta[TEST_STATUS], 'pass')
            assert.strictEqual(unskippablePassedTest.content.meta[TEST_ITR_UNSKIPPABLE], 'true')
            // This was not going to be skipped
            assert.ok(!('TEST_ITR_FORCED_RUN' in unskippablePassedTest.content.meta))

            assert.strictEqual(unskippableFailedTest.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(unskippableFailedTest.content.meta[TEST_ITR_UNSKIPPABLE], 'true')
            // This was not going to be skipped
            assert.ok(!('TEST_ITR_FORCED_RUN' in unskippableFailedTest.content.meta))
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
              ...restEnvVars,
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
            ...restEnvVars,
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

    it('works if after:run is explicitly used', async () => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSessionEvent = events.find(event => event.type === 'test_session_end')
          assert.ok(testSessionEvent)
          const testModuleEvent = events.find(event => event.type === 'test_module_end')
          assert.ok(testModuleEvent)
          const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
          assert.strictEqual(testSuiteEvents.length, 4)
          const testEvents = events.filter(event => event.type === 'test')
          assert.strictEqual(testEvents.length, 9)
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
            CYPRESS_ENABLE_AFTER_RUN_CUSTOM: '1',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })

    it('works if after:spec is explicitly used', async () => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSessionEvent = events.find(event => event.type === 'test_session_end')
          assert.ok(testSessionEvent)
          const testModuleEvent = events.find(event => event.type === 'test_module_end')
          assert.ok(testModuleEvent)
          const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
          assert.strictEqual(testSuiteEvents.length, 4)
          const testEvents = events.filter(event => event.type === 'test')
          assert.strictEqual(testEvents.length, 9)
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
            CYPRESS_ENABLE_AFTER_SPEC_CUSTOM: '1',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
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

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

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
            assert.ok(!('TEST_EARLY_FLAKE_ENABLED' in testSession.meta))
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

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

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
              ...restEnvVars,
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

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!('TEST_EARLY_FLAKE_ENABLED' in testSession.meta))

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 2)

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)
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

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

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
            assert.ok(!('TEST_EARLY_FLAKE_ENABLED' in testSession.meta))
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

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

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
            assert.ok(!('TEST_EARLY_FLAKE_ENABLED' in testSession.meta))
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

            const testSession = events.find(event => event.type === 'test_session_end').content
            assertObjectContains(testSession.meta, {
              [TEST_EARLY_FLAKE_ENABLED]: 'true',
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

      it('retries flaky tests in the correct order (right after original test)', async () => {
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
            assert.equal(tests.length, 10)

            // Extract test execution order with names
            const testExecutionOrder = tests.map(test => ({
              name: test.meta[TEST_NAME],
              isRetry: test.meta[TEST_IS_RETRY] === 'true',
            }))

            // Expected order (with native Cypress retries):
            // 1. "flaky test retry eventually passes" (original - fails)
            // 2. "flaky test retry eventually passes" (retry 1 - fails)
            // 3. "flaky test retry eventually passes" (retry 2 - passes)
            // 4. "flaky test retry never passes" (original - fails)
            // 5. "flaky test retry never passes" (retry 1 - fails)
            // 6. "flaky test retry never passes" (retry 2 - fails)
            // 7. "flaky test retry never passes" (retry 3 - fails)
            // 8. "flaky test retry never passes" (retry 4 - fails)
            // 9. "flaky test retry never passes" (retry 5 - fails)
            // 10. "flaky test retry always passes" (original - passes, no retries)

            // Verify order for "flaky test retry eventually passes" (first 3)
            for (let i = 0; i < 3; i++) {
              assert.equal(testExecutionOrder[i].name, 'flaky test retry eventually passes')
              assert.equal(testExecutionOrder[i].isRetry, i > 0) // First is original, rest are retries
            }

            // Verify order for "flaky test retry never passes" (next 6)
            for (let i = 3; i < 9; i++) {
              assert.equal(testExecutionOrder[i].name, 'flaky test retry never passes')
              assert.equal(testExecutionOrder[i].isRetry, i > 3) // First is original, rest are retries
            }

            // Verify "flaky test retry always passes" comes last
            assert.equal(testExecutionOrder[9].name, 'flaky test retry always passes')
            assert.equal(testExecutionOrder[9].isRetry, false) // No retries needed
          }, 30000)

        const {
          NODE_OPTIONS,
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
              SPEC_PATTERN: specToRun,
            },
          }
        )

        await Promise.all([once(childProcess, 'exit'), receiverPromise])
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
          assert.notStrictEqual(test.meta[TEST_SOURCE_FILE], test.meta[TEST_SUITE])
          assert.strictEqual(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
          assert.strictEqual(testSuite.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
        }, 25000)

      childProcess = exec(
        command,
        {
          cwd: `${cwd}/ci-visibility/subproject`,
          env: {
            ...restEnvVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
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

        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

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
            assert.ok(!('TEST_EARLY_FLAKE_ENABLED' in testSession.meta))
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
        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
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
              ...restEnvVars,
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
            DD_SERVICE: 'my-service',
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
                assert.ok(!('TEST_MANAGEMENT_ENABLED' in testSession.meta))
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
                  assert.ok(!('TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX' in test.meta))
                  assert.ok(!('TEST_IS_RETRY' in test.meta))
                  assert.ok(!('TEST_RETRY_REASON' in test.meta))
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
                  assert.ok(!('TEST_IS_RETRY' in test.meta))
                  assert.ok(!('TEST_RETRY_REASON' in test.meta))
                } else {
                  assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                  assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
                }
                if (isLastAttempt) {
                  if (shouldFailSometimes) {
                    assert.ok(!('TEST_HAS_FAILED_ALL_RETRIES' in test.meta))
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                  } else if (shouldAlwaysPass) {
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
                    assert.ok(!('TEST_HAS_FAILED_ALL_RETRIES' in test.meta))
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
                ...(shouldFailSometimes ? { CYPRESS_SHOULD_FAIL_SOMETIMES: '1' } : {}),
              },
            }
          )

          // TODO: remove this once we have figured out flakiness
          childProcess.stdout?.pipe(process.stdout)
          childProcess.stderr?.pipe(process.stderr)

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            testAssertionsPromise,
          ])

          if (shouldAlwaysPass) {
            assert.strictEqual(exitCode, 0)
          } else {
            // TODO: we need to figure out how to trick cypress into returning exit code 0
            // even if there are failed tests
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
                assert.ok(!('TEST_MANAGEMENT_ENABLED' in testSession.meta))
              }

              assert.strictEqual(failedTest.resource, 'cypress/e2e/disable.js.disable is disabled')

              if (isDisabling) {
                assert.strictEqual(failedTest.meta[TEST_STATUS], 'skip')
                assert.strictEqual(failedTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
              } else {
                assert.strictEqual(failedTest.meta[TEST_STATUS], 'fail')
                assert.ok(!('TEST_MANAGEMENT_IS_DISABLED' in failedTest.meta))
              }
            }, 25000)

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
              } else {
                assert.ok(!('TEST_MANAGEMENT_ENABLED' in testSession.meta))
              }

              assert.strictEqual(failedTest.resource, 'cypress/e2e/quarantine.js.quarantine is quarantined')

              if (isQuarantining) {
                // TODO: run instead of skipping, but ignore its result
                assert.strictEqual(failedTest.meta[TEST_STATUS], 'skip')
                assert.strictEqual(failedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              } else {
                assert.strictEqual(failedTest.meta[TEST_STATUS], 'fail')
                assert.ok(!('TEST_MANAGEMENT_IS_QUARANTINED' in failedTest.meta))
              }
            }, 25000)

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

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!('TEST_MANAGEMENT_ENABLED' in testSession.meta))
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            // it is not retried
            assert.strictEqual(tests.length, 1)
          }, 25000)

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

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/attempt-to-fix-order.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
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

    context('libraries capabilities', () => {
      it('adds capabilities to tests', async () => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            assert.ok(metadataDicts.length > 0)
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
              assert.strictEqual(metadata.test[TEST_SESSION_NAME], 'my-test-session-name')
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
    })

    context('impacted tests', () => {
      beforeEach(() => {
        receiver.setKnownTests({
          cypress: {
            'cypress/e2e/impacted-test.js': ['impacted test is impacted test'],
          },
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

        // Modify impacted-test-order.js to make it "impacted"
        const currentContent = fs.readFileSync(path.join(cwd, 'cypress/e2e/impacted-test-order.js'), 'utf-8')
        fs.writeFileSync(
          path.join(cwd, 'cypress/e2e/impacted-test-order.js'),
          currentContent + '\n// modified'
        )
        execSync('git add cypress/e2e/impacted-test-order.js', { cwd, stdio: 'ignore' })
        execSync('git commit -m "modify impacted-test-order.js"', { cwd, stdio: 'ignore' })
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
              assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
            } else {
              assert.ok(!('TEST_EARLY_FLAKE_ENABLED' in testSession.meta))
            }

            const resourceNames = tests.map(span => span.resource)

            assertObjectContains(resourceNames,
              [
                'cypress/e2e/impacted-test.js.impacted test is impacted test',
              ]
            )

            const impactedTests = tests.filter(test =>
              test.meta[TEST_SOURCE_FILE] === 'cypress/e2e/impacted-test.js' &&
              test.meta[TEST_NAME] === 'impacted test is impacted test')

            if (isEfd) {
              assert.strictEqual(impactedTests.length, NUM_RETRIES_EFD + 1) // Retries + original test
            } else {
              assert.strictEqual(impactedTests.length, 1)
            }

            for (const impactedTest of impactedTests) {
              if (isModified) {
                assert.strictEqual(impactedTest.meta[TEST_IS_MODIFIED], 'true')
              } else {
                assert.ok(!('TEST_IS_MODIFIED' in impactedTest.meta))
              }
              if (isNew) {
                assert.strictEqual(impactedTest.meta[TEST_IS_NEW], 'true')
              } else {
                assert.ok(!('TEST_IS_NEW' in impactedTest.meta))
              }
            }

            if (isEfd) {
              const retriedTests = tests.filter(
                test => test.meta[TEST_IS_RETRY] === 'true' &&
                test.meta[TEST_NAME] === 'impacted test is impacted test'
              )
              assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
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
              assert.strictEqual(retriedTestNew, isNew ? NUM_RETRIES_EFD : 0)
              assert.strictEqual(retriedTestsWithReason, NUM_RETRIES_EFD)
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
              ...extraEnvVars,
            },
          }
        )

        // TODO: remove this once we have figured out flakiness
        childProcess.stdout?.pipe(process.stdout)
        childProcess.stderr?.pipe(process.stderr)

        await Promise.all([
          once(childProcess, 'exit'),
          testAssertionsPromise,
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
            cypress: {},
          })
          receiver.setSettings({
            impacted_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD,
              },
            },
            known_tests_enabled: true,
          })
          await runImpactedTest(
            { isModified: true, isEfd: true, isNew: true }
          )
        })
      })

      over12It('does not retry impacted tests when testIsolation is false', async () => {
        receiver.setSettings({
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            assertObjectContains(testSession.meta, {
              [TEST_EARLY_FLAKE_ENABLED]: 'true',
            })

            const impactedTests = tests.filter(test =>
              test.meta[TEST_SOURCE_FILE] === 'cypress/e2e/impacted-test.js' &&
              test.meta[TEST_NAME] === 'impacted test is impacted test')

            // Should only have 1 test, no retries when testIsolation is false
            assert.equal(impactedTests.length, 1)

            for (const impactedTest of impactedTests) {
              assertObjectContains(impactedTest.meta, {
                [TEST_IS_MODIFIED]: 'true',
              })
            }

            // No retries should occur when testIsolation is false
            const retriedTests = tests.filter(
              test => test.meta[TEST_IS_RETRY] === 'true' &&
              test.meta[TEST_NAME] === 'impacted test is impacted test'
            )
            assert.equal(retriedTests.length, 0)
          }, 25000)

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
              CYPRESS_TEST_ISOLATION: 'false',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('retries impacted tests in the correct order (right after original test)', async () => {
        let testOutput = ''
        receiver.setSettings({
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 2,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          cypress: {
            'cypress/e2e/impacted-test-order.js': [
              'impacted test order first test',
              'impacted test order second test',
            ],
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // All tests in the file are new and modified, so they should all be retried
            // 2 tests * (1 original + 2 retries) = 6 tests total
            assert.equal(tests.length, 6)

            // Extract test execution order with full details
            const testExecutionOrder = tests.map(test => ({
              name: test.meta[TEST_NAME],
              isRetry: test.meta[TEST_IS_RETRY] === 'true',
              isModified: test.meta[TEST_IS_MODIFIED] === 'true',
            }))

            // All should be marked as modified
            testExecutionOrder.forEach(test => {
              assert.equal(test.isModified, true)
            })

            // Expected order:
            // 1. "first test" (original)
            // 2. "first test" (retry 1)
            // 3. "first test" (retry 2)
            // 4. "second test" (original)
            // 5. "second test" (retry 1)
            // 6. "second test" (retry 2)

            assertObjectContains(testExecutionOrder, [
              { name: 'impacted test order first test', isRetry: false },
              { name: 'impacted test order first test', isRetry: true },
              { name: 'impacted test order first test', isRetry: true },
              { name: 'impacted test order second test', isRetry: false },
              { name: 'impacted test order second test', isRetry: true },
              { name: 'impacted test order second test', isRetry: true },
            ])

            const testSession = events.find(event => event.type === 'test_session_end').content
            assertObjectContains(testSession.meta, {
              [TEST_EARLY_FLAKE_ENABLED]: 'true',
            })
          }, 25000)

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/impacted-test-order.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
              GITHUB_BASE_REF: '',
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

        assert.match(testOutput, /Retrying "impacted test order first test" to detect flakes because it is modified/)
        assert.match(testOutput, /Retrying "impacted test order second test" to detect flakes because it is modified/)
      })
    })
  })
})
