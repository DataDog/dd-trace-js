'use strict'

const http = require('http')
const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')

const getPort = require('get-port')
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
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')
const { NODE_MAJOR } = require('../../version')

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

moduleTypes.forEach(({
  type,
  testCommand
}) => {
  // cypress only supports esm on versions >= 10.0.0
  if (type === 'esm' && version === '6.7.0') {
    return
  }
  if (version === '6.7.0' && NODE_MAJOR > 16) {
    return
  }
  describe(`cypress@${version} ${type}`, function () {
    this.retries(2)
    this.timeout(60000)
    let sandbox, cwd, receiver, childProcess, webAppPort, secondWebAppServer

    if (type === 'commonJS') {
      testCommand = testCommand(version)
    }

    before(async () => {
      // cypress-fail-fast is required as an incompatible plugin
      sandbox = await createSandbox([`cypress@${version}`, 'cypress-fail-fast@7.1.0'], true)
      cwd = sandbox.folder
      webAppPort = await getPort()
      webAppServer.listen(webAppPort)
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

    afterEach(async () => {
      childProcess.kill()
      await receiver.stop()
    })

    if (version === '6.7.0') {
      // to be removed when we drop support for cypress@6.7.0
      it('logs a warning if using a deprecated version of cypress', (done) => {
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

        childProcess.on('exit', () => {
          assert.include(
            stdout,
            'WARNING: dd-trace support for Cypress<10.2.0 is deprecated' +
            ' and will not be supported in future versions of dd-trace.'
          )
          done()
        })
      })
    }

    it('does not crash if badly init', (done) => {
      const {
        NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
        DD_CIVISIBILITY_AGENTLESS_URL,
        ...restEnvVars
      } = getCiVisAgentlessConfig(receiver.port)

      receiver.assertPayloadReceived(() => {
        const error = new Error('it should not report test events')
        done(error)
      }, ({ url }) => url.endsWith('/api/v2/citestcycle')).catch(() => {})

      let testOutput

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

      // TODO: remove once we find the source of flakiness
      childProcess.stdout.pipe(process.stdout)
      childProcess.stderr.pipe(process.stderr)

      childProcess.on('exit', () => {
        assert.notInclude(testOutput, 'TypeError')
        // TODO: remove try/catch once we find the source of flakiness
        try {
          assert.include(testOutput, '1 of 1 failed')
        } catch (e) {
          // eslint-disable-next-line no-console
          console.log('---- Actual test output -----')
          // eslint-disable-next-line no-console
          console.log(testOutput)
          throw e
        }
        done()
      })
    })

    it('catches errors in hooks', (done) => {
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
      childProcess.on('exit', () => {
        receiverPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('can run and report tests', (done) => {
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

      childProcess.on('exit', () => {
        receiverPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('can report code coverage if it is available', (done) => {
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

      childProcess.on('exit', () => {
        receiverPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    context('intelligent test runner', () => {
      it('can report git metadata', (done) => {
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
        childProcess.on('exit', () => {
          Promise.all([
            searchCommitsRequestPromise,
            packfileRequestPromise
          ]).then(([searchCommitRequest, packfileRequest]) => {
            assert.propertyVal(searchCommitRequest.headers, 'dd-api-key', '1')
            assert.propertyVal(packfileRequest.headers, 'dd-api-key', '1')
            done()
          }).catch(done)
        })
      })

      it('does not report code coverage if disabled by the API', (done) => {
        receiver.setSettings({
          code_coverage: false,
          tests_skipping: false
        })

        receiver.assertPayloadReceived(() => {
          const error = new Error('it should not report code coverage')
          done(error)
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

        childProcess.on('exit', () => {
          receiverPromise.then(() => {
            done()
          }).catch(done)
        })
      })

      it('can skip tests received by the intelligent test runner API and still reports code coverage', (done) => {
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
        childProcess.on('exit', () => {
          Promise.all([eventsPromise, skippableRequestPromise, coverageRequestPromise]).then(() => {
            done()
          }).catch(done)
        })
      })

      it('does not skip tests if test skipping is disabled by the API', (done) => {
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
          const error = new Error('should not request skippable')
          done(error)
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

        childProcess.on('exit', () => {
          receiverPromise.then(() => {
            done()
          }).catch(done)
        })
      })

      it('does not skip tests if suite is marked as unskippable', (done) => {
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

        childProcess.on('exit', () => {
          receiverPromise.then(() => {
            done()
          }).catch(done)
        })
      })

      it('only sets forced to run if test was going to be skipped by ITR', (done) => {
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

        childProcess.on('exit', () => {
          receiverPromise.then(() => {
            done()
          }).catch(done)
        })
      })

      it('sets _dd.ci.itr.tests_skipped to false if the received test is not skipped', (done) => {
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
        childProcess.on('exit', () => {
          Promise.all([eventsPromise, skippableRequestPromise]).then(() => {
            done()
          }).catch(done)
        })
      })

      it('reports itr_correlation_id in tests', (done) => {
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
        childProcess.on('exit', () => {
          eventsPromise.then(() => {
            done()
          }).catch(done)
        })
      })

      it('reports code coverage relative to the repository root, not working directory', (done) => {
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

        childProcess.on('exit', () => {
          eventsPromise.then(() => {
            done()
          }).catch(done)
        })
      })
    })

    it('still reports correct format if there is a plugin incompatibility', (done) => {
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

      childProcess.on('exit', () => {
        receiverPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('works if after:run is explicitly used', (done) => {
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

      childProcess.on('exit', () => {
        receiverPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('works if after:spec is explicitly used', (done) => {
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

      childProcess.on('exit', () => {
        receiverPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    context('early flake detection', () => {
      it('retries new tests', (done) => {
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

        childProcess.on('exit', () => {
          receiverPromise.then(() => {
            done()
          }).catch(done)
        })
      })

      it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', (done) => {
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

        childProcess.on('exit', () => {
          receiverPromise.then(() => {
            done()
          }).catch(done)
        })
      })

      it('does not retry tests that are skipped', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: true
        })

        receiver.setKnownTests({})
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

        childProcess.on('exit', () => {
          receiverPromise.then(() => {
            done()
          }).catch(done)
        })
      })

      it('does not run EFD if the known tests request fails', (done) => {
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
        receiver.setKnownTests({})

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

        childProcess.on('exit', () => {
          receiverPromise.then(() => {
            done()
          }).catch(done)
        })
      })

      it('disables early flake detection if known tests should not be requested', (done) => {
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

        childProcess.on('exit', () => {
          receiverPromise.then(() => {
            done()
          }).catch(done)
        })
      })
    })

    context('flaky test retries', () => {
      it('retries flaky tests', (done) => {
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
              SPEC_PATTERN: specToRun
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', () => {
          receiverPromise.then(() => {
            done()
          }).catch(done)
        })
      })

      it('is disabled if DD_CIVISIBILITY_FLAKY_RETRY_ENABLED is false', (done) => {
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

        childProcess.on('exit', () => {
          receiverPromise.then(() => done()).catch(done)
        })
      })

      it('retries DD_CIVISIBILITY_FLAKY_RETRY_COUNT times', (done) => {
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

        childProcess.on('exit', () => {
          receiverPromise.then(() => {
            done()
          }).catch(done)
        })
      })
    })

    it('correctly calculates test code owners when working directory is not repository root', (done) => {
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

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    context('known tests without early flake detection', () => {
      it('detects new tests without retrying them', (done) => {
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

        childProcess.on('exit', () => {
          receiverPromise.then(() => {
            done()
          }).catch(done)
        })
      })
    })

    // cy.origin is not available in old versions of Cypress
    if (version === 'latest') {
      it('does not crash for multi origin tests', async () => {
        const {
          NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        const secondWebAppPort = await getPort()

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

        secondWebAppServer.listen(secondWebAppPort)

        const specToRun = 'cypress/e2e/multi-origin.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              CYPRESS_BASE_URL_SECOND: `http://localhost:${secondWebAppPort}`,
              SPEC_PATTERN: specToRun
            },
            stdio: 'pipe'
          }
        )

        await receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            assert.equal(events.length, 4)

            const test = events.find(event => event.type === 'test').content
            assert.equal(test.resource, 'cypress/e2e/multi-origin.js.tests multiple origins')
            assert.equal(test.meta[TEST_STATUS], 'pass')
          })
      })
    }

    it('sets _dd.test.is_user_provided_service to true if DD_SERVICE is used', (done) => {
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

      childProcess.on('exit', () => {
        receiverPromise.then(() => {
          done()
        }).catch(done)
      })
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
                    assert.notProperty(test.meta, TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED)
                  } else if (shouldAlwaysPass) {
                    assert.propertyVal(test.meta, TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'true')
                    assert.notProperty(test.meta, TEST_HAS_FAILED_ALL_RETRIES)
                  } else {
                    assert.propertyVal(test.meta, TEST_HAS_FAILED_ALL_RETRIES, 'true')
                    assert.notProperty(test.meta, TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED)
                  }
                }
              }
            })

        const runAttemptToFixTest = (done, {
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

          childProcess.on('exit', (exitCode) => {
            testAssertionsPromise.then(() => {
              if (shouldAlwaysPass) {
                assert.equal(exitCode, 0)
              } else {
                // TODO: we need to figure out how to trick cypress into returning exit code 0
                // even if there are failed tests
                assert.equal(exitCode, 1)
              }
              done()
            }).catch(done)
          })
        }

        it('can attempt to fix and mark last attempt as failed if every attempt fails', (done) => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

          runAttemptToFixTest(done, { isAttemptToFix: true })
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

        /**
         * TODO:
         * The spec says that quarantined tests that are not attempted to fix should be run and their result ignored.
         * Cypress will skip the test instead.
         *
         * When a test is quarantined and attempted to fix, the spec is to run the test and ignore its result.
         * Cypress will run the test, but it won't ignore its result.
         */
        it('can mark tests as quarantined and tests are not skipped', (done) => {
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

          runAttemptToFixTest(done, { isAttemptToFix: true, isQuarantined: true })
        })

        /**
         * TODO:
         * When a test is disabled and attempted to fix, the spec is to run the test and ignore its result.
         * Cypress will run the test, but it won't ignore its result.
         */
        it('can mark tests as disabled and tests are not skipped', (done) => {
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

          runAttemptToFixTest(done, { isAttemptToFix: true, isDisabled: true })
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

        const runDisableTest = (done, isDisabling, extraEnvVars) => {
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

          childProcess.on('exit', (exitCode) => {
            testAssertionsPromise.then(() => {
              if (isDisabling) {
                assert.equal(exitCode, 0)
              } else {
                assert.equal(exitCode, 1)
              }
              done()
            }).catch(done)
          })
        }

        it('can disable tests', (done) => {
          receiver.setSettings({ test_management: { enabled: true } })

          runDisableTest(done, true)
        })

        it('fails if disable is not enabled', (done) => {
          receiver.setSettings({ test_management: { enabled: false } })

          runDisableTest(done, false)
        })

        it('does not disable tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
          receiver.setSettings({ test_management: { enabled: true } })

          runDisableTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
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

        const runQuarantineTest = (done, isQuarantining, extraEnvVars) => {
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

          childProcess.on('exit', (exitCode) => {
            testAssertionsPromise.then(() => {
              if (isQuarantining) {
                assert.equal(exitCode, 0)
              } else {
                assert.equal(exitCode, 1)
              }
              done()
            }).catch(done)
          })
        }

        it('can quarantine tests', (done) => {
          receiver.setSettings({ test_management: { enabled: true } })

          runQuarantineTest(done, true)
        })

        it('fails if quarantine is not enabled', (done) => {
          receiver.setSettings({ test_management: { enabled: false } })

          runQuarantineTest(done, false)
        })

        it('does not enable quarantine tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
          receiver.setSettings({ test_management: { enabled: true } })

          runQuarantineTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
        })
      })
    })

    context('libraries capabilities', () => {
      it('adds capabilities to tests', (done) => {
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
              assert.equal(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX], '2')
              // capabilities logic does not overwrite test session name
              assert.equal(metadata.test[TEST_SESSION_NAME], 'my-test-session-name')
            })
          }, 25000)

        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              DD_TEST_SESSION_NAME: 'my-test-session-name'
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', () => {
          receiverPromise.then(() => {
            done()
          }).catch(done)
        })
      })
    })

    context('impacted tests', () => {
      const NUM_RETRIES = 3
      let baseCommitSha = null
      let commitHeadSha = null
      let eventPath = null
      let testConfig = null

      function promiseExec (command) {
        return new Promise((resolve) => {
          const child = exec(command, { cwd })
          let data = ''
          child.stdout.on('data', chunk => { data += chunk })
          child.stdout.on('end', () => resolve(data.trim()))
        })
      }

      beforeEach(() => {
        const eventContent = {
          pull_request: {
            base: {
              sha: baseCommitSha,
              ref: 'master'
            },
            head: {
              sha: commitHeadSha,
              ref: 'master'
            }
          }
        }
        eventPath = path.join(cwd, 'event.json')
        fs.writeFileSync(eventPath, JSON.stringify(eventContent, null, 2))

        testConfig = {
          GITHUB_ACTIONS: true,
          GITHUB_BASE_REF: 'master',
          GITHUB_HEAD_REF: 'feature-branch',
          GITHUB_EVENT_PATH: eventPath
        }
      })

      // Add git setup before running impacted tests
      before(async function () {
        // Create initial test file on main
        const testDir = path.join(cwd, 'cypress/e2e')
        await exec(`mkdir -p ${testDir}`, { cwd })
        const testContent = `
/* eslint-disable */
describe('impacted test', () => {
  it('is impacted test', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
`
        fs.writeFileSync(path.join(testDir, 'impacted-test.js'), testContent)

        await promiseExec('git add cypress/e2e/impacted-test.js')
        await promiseExec('git commit -m "add impacted-test.js"')
        // Get base commit SHA from main after creating the file
        baseCommitSha = await promiseExec('git rev-parse HEAD')

        await promiseExec('git checkout -b feature-branch')
        const modifiedTestContent = `
/* eslint-disable */
describe('impacted test', () => {
  it('is impacted test', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello Worldd')
  })
})
`
        fs.writeFileSync(path.join(testDir, 'impacted-test.js'), modifiedTestContent)
        await promiseExec('git add cypress/e2e/impacted-test.js')
        await promiseExec('git commit -m "modify impacted-test.js"')
        commitHeadSha = await promiseExec('git rev-parse HEAD')
      })

      // Clean up git branches and temp files after impacted tests
      after(async () => {
        await promiseExec('git checkout main')
        await promiseExec('git branch -D feature-branch')
        if (fs.existsSync(eventPath)) {
          fs.unlinkSync(eventPath)
        }
      })

      const getTestAssertions = ({ isImpacting, isEfd }) =>
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
              assert.equal(impactedTests.length, NUM_RETRIES + 1) // Retries + original test
            } else {
              assert.equal(impactedTests.length, 1)
            }

            if (isImpacting) {
              impactedTests.forEach(test => {
                assert.propertyVal(test.meta, TEST_IS_MODIFIED, 'true')
              })
            } else {
              impactedTests.forEach(test => {
                assert.notPropertyVal(test.meta, TEST_IS_MODIFIED)
              })
            }

            if (isEfd) {
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
              assert.equal(retriedTests.length, NUM_RETRIES)
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
              assert.equal(retriedTestNew, 0)
              assert.equal(retriedTestsWithReason, NUM_RETRIES)
            }
          })

      const runImpactedTest = (
        done,
        { isImpacting, isEfd = false },
        extraEnvVars = {}
      ) => {
        const testAssertionsPromise = getTestAssertions({ isImpacting, isEfd })

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
              ...testConfig,
              ...extraEnvVars
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', () => {
          testAssertionsPromise.then(done).catch(done)
        })
      }

      it('can impacted tests', (done) => {
        receiver.setSettings({ impacted_tests_enabled: true })

        runImpactedTest(done, { isImpacting: true })
      })

      it('does not impact tests if disabled', (done) => {
        receiver.setSettings({ impacted_tests_enabled: false })

        runImpactedTest(done, { isImpacting: false })
      })

      it('does not impact tests DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED is set to false', (done) => {
        receiver.setSettings({ impacted_tests_enabled: false })

        runImpactedTest(done,
          { isImpacting: false },
          { DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: '0' }
        )
      })

      it('can not impact tests with git diff with no base sha', (done) => {
        receiver.setSettings({ impacted_tests_enabled: true })
        const eventContent = {
          pull_request: {
            base: {
              sha: '',
              ref: 'master'
            },
            head: {
              sha: commitHeadSha,
              ref: 'master'
            }
          }
        }
        eventPath = path.join(cwd, 'event.json')
        fs.writeFileSync(eventPath, JSON.stringify(eventContent, null, 2))

        runImpactedTest(done, { isImpacting: false })
      })

      it('can not impact tests with git diff with no head sha', (done) => {
        receiver.setSettings({ impacted_tests_enabled: true })
        const eventContent = {
          pull_request: {
            base: {
              sha: baseCommitSha,
              ref: 'master'
            },
            head: {
              sha: '',
              ref: 'master'
            }
          }
        }
        eventPath = path.join(cwd, 'event.json')
        fs.writeFileSync(eventPath, JSON.stringify(eventContent, null, 2))

        runImpactedTest(done, { isImpacting: false })
      })

      it('can impact tests in and activate EFD if modified (no known tests)', (done) => {
        receiver.setSettings({
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES
            }
          },
          known_tests_enabled: true
        })
        runImpactedTest(done,
          { isImpacting: true, isEfd: true }
        )
      })

      it('can impact tests in and activate EFD if modified (with known tests)', (done) => {
        receiver.setSettings({
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES
            }
          },
          known_tests_enabled: true
        })
        receiver.setKnownTests({
          cypress: {
            'cypress/e2e/impacted-test.js': [
              'impacted test is impacted test'
            ]
          }
        })
        runImpactedTest(done,
          { isImpacting: true, isEfd: true }
        )
      })
    })
  })
})
