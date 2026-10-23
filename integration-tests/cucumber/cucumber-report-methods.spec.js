'use strict'

const assert = require('node:assert/strict')

const { once } = require('node:events')
const { exec } = require('child_process')
const path = require('path')
const { inspect } = require('node:util')

const { assertObjectContains } = require('../helpers')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_STATUS,
  TEST_SKIPPED_BY_ITR,
  TEST_COMMAND,
  TEST_MODULE,
  TEST_TOOLCHAIN,
  TEST_CODE_COVERAGE_ENABLED,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_ITR_TESTS_SKIPPED,
  TEST_ITR_SKIPPING_TYPE,
  TEST_ITR_SKIPPING_COUNT,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_ITR_FORCED_RUN,
  TEST_ITR_UNSKIPPABLE,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_NAME,
  CUCUMBER_IS_PARALLEL,
  TEST_SUITE,
  TEST_SESSION_NAME,
  DI_ERROR_DEBUG_INFO_CAPTURED,
  DI_DEBUG_ERROR_PREFIX,
  DI_DEBUG_ERROR_FILE_SUFFIX,
  DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX,
  DI_DEBUG_ERROR_LINE_SUFFIX,
  TEST_RETRY_REASON,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_RETRY_REASON_TYPES,
  TEST_SKIP_REASON,
  TEST_SESSION_EMPTY_REASON,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS,
  TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { NODE_MAJOR } = require('../../version')

function assertItrSkippingEnabledTags (events, expected) {
  const testSuite = events.find(event => event.type === 'test_suite_end').content
  assert.strictEqual(testSuite.meta[TEST_ITR_SKIPPING_ENABLED], expected)
  const test = events.find(event => event.type === 'test').content
  assert.strictEqual(test.meta[TEST_ITR_SKIPPING_ENABLED], expected)
}

const version = process.env.CUCUMBER_VERSION || 'latest'
const isLatestCucumberSupported = NODE_MAJOR === 22 || NODE_MAJOR === 24 || NODE_MAJOR >= 26

const onlyLatestIt = version === 'latest' ? it : it.skip

const runTestsCommand = './node_modules/.bin/cucumber-js ci-visibility/features/*.feature'
const runTestsWithCoverageCommand = './node_modules/nyc/bin/nyc.js -r=text-summary ' +
  'node ./node_modules/.bin/cucumber-js ci-visibility/features/*.feature'
const parallelModeCommand = './node_modules/.bin/cucumber-js ci-visibility/features/*.feature --parallel 2'
const featuresPath = 'ci-visibility/features/'
const fileExtension = 'js'

describe(`cucumber@${version} commonJS`, () => {
  if (!isLatestCucumberSupported && version === 'latest') return

  let cwd, receiver, childProcess, testOutput

  useSandbox([`@cucumber/cucumber@${version}`, 'assert', 'nyc', 'sinon'], true)

  before(function () {
    cwd = sandboxCwd()
  })

  beforeEach(async function () {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    testOutput = ''
    childProcess.kill()
    await receiver.stop()
  })

  const reportMethods = ['agentless', 'evp proxy']

  reportMethods.forEach((reportMethod) => {
    context(`reporting via ${reportMethod}`, () => {
      let envVars, isAgentless, logsEndpoint

      beforeEach(() => {
        isAgentless = reportMethod === 'agentless'
        envVars = isAgentless ? getCiVisAgentlessConfig(receiver.port) : getCiVisEvpProxyConfig(receiver.port)
        logsEndpoint = isAgentless ? '/api/v2/logs' : '/debugger/v1/input'
      })

      context('error tags', () => {
        it(
          'tags session and children with _dd.ci.library_configuration_error.settings when settings fails 4xx',
          async () => {
            receiver.setSettingsResponseCode(404)
            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
                const testModule = events.find(event => event.type === 'test_module_end')
                assert.ok(testModule, 'should have test module event')
                assert.strictEqual(testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
                const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
                assert.ok(testSuiteEvent, 'should have test suite event')
                assert.strictEqual(testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
                const testEvent = events.find(event => event.type === 'test')
                assert.ok(testEvent, 'should have test event')
                assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
              })
            childProcess = exec(runTestsCommand, { cwd, env: envVars })
            await Promise.all([eventsPromise, once(childProcess, 'exit')])
          })

        it(
          'tags session and children with _dd.ci.library_configuration_error.skippable_tests when request fails 4xx',
          async () => {
            receiver.setSkippableSuitesResponseCode(404)
            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
                const testModule = events.find(event => event.type === 'test_module_end')
                assert.ok(testModule, 'should have test module event')
                assert.strictEqual(testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
                const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
                assert.ok(testSuiteEvent, 'should have test suite event')
                assert.strictEqual(
                  testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true'
                )
                const testEvent = events.find(event => event.type === 'test')
                assert.ok(testEvent, 'should have test event')
                assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
              })
            childProcess = exec(runTestsCommand, { cwd, env: envVars })
            await Promise.all([eventsPromise, once(childProcess, 'exit')])
          })

        it(
          'tags session and children with _dd.ci.library_configuration_error.known_tests when request fails 4xx',
          async () => {
            receiver.setSettings({ known_tests_enabled: true })
            receiver.setKnownTestsResponseCode(404)
            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
                const testModule = events.find(event => event.type === 'test_module_end')
                assert.ok(testModule, 'should have test module event')
                assert.strictEqual(testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
                const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
                assert.ok(testSuiteEvent, 'should have test suite event')
                assert.strictEqual(testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
                const testEvent = events.find(event => event.type === 'test')
                assert.ok(testEvent, 'should have test event')
                assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
              })
            childProcess = exec(runTestsCommand, { cwd, env: envVars })
            await Promise.all([eventsPromise, once(childProcess, 'exit')])
          })

        it(
          'tags session and children with _dd.ci.library_configuration_error.test_management_tests when request fails',
          async () => {
            receiver.setSettings({ test_management: { enabled: true } })
            receiver.setTestManagementTestsResponseCode(404)
            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true')
                const testModule = events.find(event => event.type === 'test_module_end')
                assert.ok(testModule, 'should have test module event')
                assert.strictEqual(
                  testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true'
                )
                const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
                assert.ok(testSuiteEvent, 'should have test suite event')
                assert.strictEqual(
                  testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true'
                )
                const testEvent = events.find(event => event.type === 'test')
                assert.ok(testEvent, 'should have test event')
                assert.strictEqual(
                  testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true'
                )
              })
            childProcess = exec(runTestsCommand, { cwd, env: envVars })
            await Promise.all([eventsPromise, once(childProcess, 'exit')])
          })
      })

      const runModes = ['serial', 'parallel']

      runModes.forEach((runMode) => {
        it(`(${runMode}) can run and report tests`, (done) => {
          const runCommand = runMode === 'parallel' ? parallelModeCommand : runTestsCommand

          const receiverPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)
              metadataDicts.forEach(metadata => {
                assert.strictEqual(metadata.test_levels[TEST_SESSION_NAME], 'my-test-session')
                assert.ok(metadata.test_levels[TEST_COMMAND])
              })

              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSessionEvent = events.find(event => event.type === 'test_session_end')
              const testModuleEvent = events.find(event => event.type === 'test_module_end')
              const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
              const testEvents = events.filter(event => event.type === 'test')

              const stepEvents = events.filter(event => event.type === 'span')

              const { content: testSessionEventContent } = testSessionEvent
              const { content: testModuleEventContent } = testModuleEvent

              if (runMode === 'parallel') {
                assert.strictEqual(testSessionEventContent.meta[CUCUMBER_IS_PARALLEL], 'true')
              }

              assert.ok(testSessionEventContent.test_session_id)
              assert.ok(testSessionEventContent.meta[TEST_TOOLCHAIN])
              assert.strictEqual(testSessionEventContent.resource.startsWith('test_session.'), true)
              assert.strictEqual(testSessionEventContent.meta[TEST_STATUS], 'fail')

              assert.ok(testModuleEventContent.test_session_id)
              assert.ok(testModuleEventContent.test_module_id)
              assert.ok(testModuleEventContent.meta[TEST_MODULE])
              assert.strictEqual(testModuleEventContent.resource.startsWith('test_module.'), true)
              assert.strictEqual(testModuleEventContent.meta[TEST_STATUS], 'fail')
              assert.strictEqual(
                testModuleEventContent.test_session_id.toString(10),
                testSessionEventContent.test_session_id.toString(10)
              )

              assertObjectContains(testSuiteEvents.map(suite => suite.content.resource), [
                `test_suite.${featuresPath}farewell.feature`,
                `test_suite.${featuresPath}greetings.feature`,
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
                assert.ok(meta[TEST_MODULE])
                assert.ok(testSuiteId)
                assert.strictEqual(testModuleId.toString(10), testModuleEventContent.test_module_id.toString(10))
                assert.strictEqual(testSessionId.toString(10), testSessionEventContent.test_session_id.toString(10))
                assert.strictEqual(meta[TEST_SOURCE_FILE].startsWith(featuresPath), true)
                assert.strictEqual(metrics[TEST_SOURCE_START], 1)
                assert.ok(metrics[DD_HOST_CPU_COUNT])
              })

              assert.deepStrictEqual(testEvents.map(test => test.content.resource).sort(), [
                `${featuresPath}farewell.feature.Say farewell`,
                `${featuresPath}farewell.feature.Say whatever`,
                `${featuresPath}greetings.feature.Say greetings`,
                `${featuresPath}greetings.feature.Say skip`,
                `${featuresPath}greetings.feature.Say yeah`,
                `${featuresPath}greetings.feature.Say yo`,
              ])
              assert.deepStrictEqual(testEvents.map(test => test.content.meta[TEST_STATUS]).sort(), [
                'fail',
                'pass',
                'pass',
                'pass',
                'pass',
                'skip',
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
                assert.ok(meta[TEST_MODULE])
                assert.ok(testSuiteId)
                assert.strictEqual(testModuleId.toString(10), testModuleEventContent.test_module_id.toString(10))
                assert.strictEqual(testSessionId.toString(10), testSessionEventContent.test_session_id.toString(10))
                assert.strictEqual(meta[TEST_SOURCE_FILE].startsWith('ci-visibility/features'), true)
                assert.strictEqual(meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'false')
                // Can read DD_TAGS
                assert.strictEqual(meta['test.customtag'], 'customvalue')
                assert.strictEqual(meta['test.customtag2'], 'customvalue2')
                if (runMode === 'parallel') {
                  assert.strictEqual(meta[CUCUMBER_IS_PARALLEL], 'true')
                }
                assert.ok(metrics[DD_HOST_CPU_COUNT])
                if (!meta[TEST_NAME].includes('Say skip')) {
                  assert.strictEqual(meta['custom_tag.before'], 'hello before')
                  assert.strictEqual(meta['custom_tag.after'], 'hello after')
                }
              })

              stepEvents.forEach(stepEvent => {
                assert.strictEqual(stepEvent.content.name, 'cucumber.step')
                assert.ok(
                  Object.hasOwn(stepEvent.content.meta, 'cucumber.step'),
                  `Available keys: ${inspect(Object.keys(stepEvent.content.meta))}`
                )
                if (stepEvent.content.meta['cucumber.step'] === 'the greeter says greetings') {
                  assert.strictEqual(stepEvent.content.meta['custom_tag.when'], 'hello when')
                }
              })
            }, 5000)

          childProcess = exec(
            runCommand,
            {
              cwd,
              env: {
                ...envVars,
                DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2',
                DD_TEST_SESSION_NAME: 'my-test-session',
                DD_SERVICE: undefined,
              },
            }
          )

          childProcess.on('exit', () => {
            receiverPromise.then(() => done()).catch(done)
          })
        })
      })

      {
        const delayedWorkerTest = reportMethod === 'agentless' && version !== '7.0.0' ? it : it.skip
        delayedWorkerTest('keeps module tags when worker traces arrive before parallel suite start', async () => {
          childProcess = exec(
            parallelModeCommand,
            {
              cwd,
              env: {
                ...envVars,
                DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2',
                DD_TEST_DELAY_CUCUMBER_WORKER_MESSAGES_MS: '100',
                DD_TEST_SESSION_NAME: 'my-test-session',
                NODE_OPTIONS: '-r ./ci-visibility/cucumber-worker-message-delay.js -r dd-trace/ci/init',
                DD_SERVICE: undefined,
              },
            }
          )

          const receiverPromise = receiver.gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testModuleEvent = events.find(event => event.type === 'test_module_end')
              const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
              const testEvents = events.filter(event => event.type === 'test')

              assert.ok(testModuleEvent, 'should have test module event')
              assert.ok(testSuiteEvent, 'should have test suite event')
              assert.deepStrictEqual(testEvents.map(test => test.content.resource).sort(), [
                `${featuresPath}farewell.feature.Say farewell`,
                `${featuresPath}farewell.feature.Say whatever`,
                `${featuresPath}greetings.feature.Say greetings`,
                `${featuresPath}greetings.feature.Say skip`,
                `${featuresPath}greetings.feature.Say yeah`,
                `${featuresPath}greetings.feature.Say yo`,
              ])
              testEvents.forEach(({ content: { meta, test_suite_id: testSuiteId } }) => {
                assert.strictEqual(meta[TEST_MODULE], 'cucumber')
                assert.ok(testSuiteId)
                assert.strictEqual(meta[CUCUMBER_IS_PARALLEL], 'true')
              })
            },
            { hardTimeout: 10000 }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            receiverPromise,
          ])
        })
      }

      context('intelligent test runner', () => {
        it('can report git metadata', (done) => {
          const searchCommitsRequestPromise = receiver.payloadReceived(
            ({ url }) => url.endsWith('/api/v2/git/repository/search_commits')
          )
          const packfileRequestPromise = receiver
            .payloadReceived(({ url }) => url.endsWith('/api/v2/git/repository/packfile'))
          const eventsRequestPromise = receiver.payloadReceived(({ url }) => url.endsWith('/api/v2/citestcycle'))

          Promise.all([
            searchCommitsRequestPromise,
            packfileRequestPromise,
            eventsRequestPromise,
          ]).then(([searchCommitRequest, packfileRequest, eventsRequest]) => {
            if (isAgentless) {
              assert.strictEqual(searchCommitRequest.headers['dd-api-key'], '1')
              assert.strictEqual(packfileRequest.headers['dd-api-key'], '1')
            } else {
              assert.ok(!('dd-api-key' in searchCommitRequest.headers))
              assert.ok(!('dd-api-key' in packfileRequest.headers))
            }

            const eventTypes = eventsRequest.payload.events.map(event => event.type)
            assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
            const numSuites = eventTypes.reduce(
              (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
            )
            assert.strictEqual(numSuites, 2)

            done()
          }).catch(done)

          childProcess = exec(
            runTestsCommand,
            {
              cwd,
              env: envVars,
            }
          )
        })

        it('can report code coverage', (done) => {
          const libraryConfigRequestPromise = receiver.payloadReceived(
            ({ url }) => url.endsWith('/api/v2/libraries/tests/services/setting')
          )
          const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url.endsWith('/api/v2/citestcov'))
          const eventsRequestPromise = receiver.payloadReceived(({ url }) => url.endsWith('/api/v2/citestcycle'))

          Promise.all([
            libraryConfigRequestPromise,
            codeCovRequestPromise,
            eventsRequestPromise,
          ]).then(([libraryConfigRequest, codeCovRequest, eventsRequest]) => {
            const [coveragePayload] = codeCovRequest.payload
            if (isAgentless) {
              assert.strictEqual(libraryConfigRequest.headers['dd-api-key'], '1')
              assert.strictEqual(codeCovRequest.headers['dd-api-key'], '1')
            } else {
              assert.ok(!('dd-api-key' in libraryConfigRequest.headers))
              assert.ok(!('dd-api-key' in codeCovRequest.headers))
            }

            assertObjectContains(coveragePayload, {
              name: 'coverage1',
              filename: 'coverage1.msgpack',
              type: 'application/msgpack',
              content: {
                version: 2,
              },
            })
            const allCoverageFiles = codeCovRequest.payload
              .flatMap(coverage => coverage.content.coverages)
              .flatMap(file => file.files)
              .map(file => file.filename)

            assertObjectContains(allCoverageFiles, [
              `${featuresPath}support/steps.${fileExtension}`,
              `${featuresPath}farewell.feature`,
              `${featuresPath}greetings.feature`,
            ])
            // steps is twice because there are two suites using it
            assert.strictEqual(
              allCoverageFiles.filter(file => file === `${featuresPath}support/steps.${fileExtension}`).length,
              2,
              'Steps should be covered twice'
            )
            assert.ok(coveragePayload.content.coverages[0].test_session_id)
            assert.ok(coveragePayload.content.coverages[0].test_suite_id)

            const testSession = eventsRequest
              .payload
              .events
              .find(event => event.type === 'test_session_end')
              .content
            assert.ok(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])

            const eventTypes = eventsRequest.payload.events.map(event => event.type)
            assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
            const numSuites = eventTypes.reduce(
              (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
            )
            assert.strictEqual(numSuites, 2)
          }).catch(done)

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: envVars,
            }
          )
          childProcess.stdout?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.stderr?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.on('exit', () => {
            // check that reported coverage is still the same
            assert.match(testOutput, /Lines {8}: 100%/)
            done()
          })
        })

        it('does not report code coverage if disabled by the API', (done) => {
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
          })

          receiver.assertPayloadReceived(() => {
            const error = new Error('it should not report code coverage')
            done(error)
          }, ({ url }) => url.endsWith('/api/v2/citestcov')).catch(() => {})

          receiver.assertPayloadReceived(({ payload }) => {
            const eventTypes = payload.events.map(event => event.type)
            assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
            const testSession = payload.events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
            assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
            assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
            assert.ok(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])
            const testModule = payload.events.find(event => event.type === 'test_module_end').content
            assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
            assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
            assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
            assertItrSkippingEnabledTags(payload.events, 'false')
          }, ({ url }) => url.endsWith('/api/v2/citestcycle')).then(() => done()).catch(done)

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: envVars,
            }
          )
        })

        it('can skip suites received by the intelligent test runner API and still reports code coverage',
          (done) => {
            receiver.setSuitesToSkip([{
              type: 'suite',
              attributes: {
                suite: `${featuresPath}farewell.feature`,
              },
            }])

            const skippableRequestPromise = receiver
              .payloadReceived(({ url }) => url.endsWith('/api/v2/ci/tests/skippable'))
            const coverageRequestPromise = receiver.payloadReceived(({ url }) => url.endsWith('/api/v2/citestcov'))
            const eventsRequestPromise = receiver.payloadReceived(({ url }) => url.endsWith('/api/v2/citestcycle'))

            Promise.all([
              skippableRequestPromise,
              coverageRequestPromise,
              eventsRequestPromise,
            ]).then(([skippableRequest, coverageRequest, eventsRequest]) => {
              const [coveragePayload] = coverageRequest.payload
              if (isAgentless) {
                assert.strictEqual(skippableRequest.headers['dd-api-key'], '1')
                assert.strictEqual(coverageRequest.headers['dd-api-key'], '1')
                assert.strictEqual(eventsRequest.headers['dd-api-key'], '1')
              } else {
                assert.ok(!('dd-api-key' in skippableRequest.headers))
                assert.ok(!('dd-api-key' in coverageRequest.headers))
                assert.ok(!('dd-api-key' in eventsRequest.headers))
              }
              assertObjectContains(coveragePayload, {
                name: 'coverage1',
                filename: 'coverage1.msgpack',
                type: 'application/msgpack',
              })

              const eventTypes = eventsRequest.payload.events.map(event => event.type)

              const skippedSuite = eventsRequest.payload.events.find(event =>
                event.content.resource === `test_suite.${featuresPath}farewell.feature`
              ).content
              assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
              assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')

              assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
              const numSuites = eventTypes.reduce(
                (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
              )
              assert.strictEqual(numSuites, 2)
              const testSession = eventsRequest
                .payload.events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
              assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
              assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
              assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
              assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)

              const testModule = eventsRequest
                .payload.events.find(event => event.type === 'test_module_end').content
              assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'true')
              assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
              assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
              assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
              assert.strictEqual(testModule.metrics[TEST_ITR_SKIPPING_COUNT], 1)
              assertItrSkippingEnabledTags(eventsRequest.payload.events, 'true')
              done()
            }).catch(done)

            childProcess = exec(
              runTestsWithCoverageCommand,
              {
                cwd,
                env: envVars,
              }
            )
          })

        it('prints a message when every suite is skipped', async () => {
          receiver.setSettings({
            itr_enabled: true,
            code_coverage: false,
            tests_skipping: true,
          })
          receiver.setSuitesToSkip([
            {
              type: 'suite',
              attributes: {
                suite: `${featuresPath}farewell.feature`,
              },
            },
          ])

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              const testModule = events.find(event => event.type === 'test_module_end').content
              assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
              for (const event of [testSession, testModule]) {
                assert.strictEqual(event.meta[TEST_STATUS], 'skip')
                assert.strictEqual(event.meta[TEST_SKIP_REASON], 'All tests were skipped')
                assert.strictEqual(event.meta[TEST_SESSION_EMPTY_REASON], 'all_tests_skipped')
              }
            })

          childProcess = exec(
            './node_modules/.bin/cucumber-js ci-visibility/features/farewell.feature',
            { cwd, env: envVars }
          )
          childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
          childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

          const [, [exitCode]] = await Promise.all([
            eventsPromise,
            once(childProcess, 'close'),
          ])

          assert.strictEqual(exitCode, 0, testOutput)
          assert.strictEqual(
            testOutput.split(TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE).length - 1,
            1,
            testOutput
          )
        })

        it('does not skip tests if git metadata upload fails', (done) => {
          receiver.setSuitesToSkip([{
            type: 'suite',
            attributes: {
              suite: `${featuresPath}farewell.feature`,
            },
          }])

          receiver.setGitUploadStatus(404)

          receiver.assertPayloadReceived(() => {
            const error = new Error('should not request skippable')
            done(error)
          }, ({ url }) => url.endsWith('/api/v2/ci/tests/skippable'))

          receiver.assertPayloadReceived(({ payload }) => {
            const eventTypes = payload.events.map(event => event.type)
            // because they are not skipped
            assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
            const numSuites = eventTypes.reduce(
              (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
            )
            assert.strictEqual(numSuites, 2)
            const testSession = payload.events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
            assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
            const testModule = payload.events.find(event => event.type === 'test_module_end').content
            assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
            assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
            assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
            assertItrSkippingEnabledTags(payload.events, 'true')
          }, ({ url }) => url.endsWith('/api/v2/citestcycle')).then(() => done()).catch(done)

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: envVars,
            }
          )
        })

        it('does not skip tests if test skipping is disabled by the API', (done) => {
          receiver.setSettings({
            itr_enabled: true,
            code_coverage: true,
            tests_skipping: false,
          })

          receiver.setSuitesToSkip([{
            type: 'suite',
            attributes: {
              suite: `${featuresPath}farewell.feature`,
            },
          }])

          receiver.assertPayloadReceived(() => {
            const error = new Error('should not request skippable')
            done(error)
          }, ({ url }) => url.endsWith('/api/v2/ci/tests/skippable'))

          receiver.assertPayloadReceived(({ payload }) => {
            const eventTypes = payload.events.map(event => event.type)
            // because they are not skipped
            assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
            const numSuites = eventTypes.reduce(
              (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
            )
            assert.strictEqual(numSuites, 2)
          }, ({ url }) => url.endsWith('/api/v2/citestcycle')).then(() => done()).catch(done)

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: getCiVisAgentlessConfig(receiver.port),
            }
          )
        })

        it('does not skip suites if suite is marked as unskippable', (done) => {
          receiver.setSettings({
            itr_enabled: true,
            code_coverage: true,
            tests_skipping: true,
          })

          receiver.setSuitesToSkip([
            {
              type: 'suite',
              attributes: {
                suite: `${featuresPath}farewell.feature`,
              },
            },
            {
              type: 'suite',
              attributes: {
                suite: `${featuresPath}greetings.feature`,
              },
            },
          ])

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const suites = events.filter(event => event.type === 'test_suite_end')

              assert.strictEqual(suites.length, 2)

              const testSession = events.find(event => event.type === 'test_session_end').content
              const testModule = events.find(event => event.type === 'test_session_end').content

              assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
              assert.strictEqual(testSession.meta[TEST_ITR_FORCED_RUN], 'true')
              assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')
              assert.strictEqual(testModule.meta[TEST_ITR_FORCED_RUN], 'true')

              const skippedSuite = suites.find(
                event => event.content.resource === 'test_suite.ci-visibility/features/farewell.feature'
              ).content
              const forcedToRunSuite = suites.find(
                event => event.content.resource === 'test_suite.ci-visibility/features/greetings.feature'
              ).content

              assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
              assert.ok(!(TEST_ITR_UNSKIPPABLE in skippedSuite.meta))
              assert.ok(!(TEST_ITR_FORCED_RUN in skippedSuite.meta))

              assert.strictEqual(forcedToRunSuite.meta[TEST_STATUS], 'fail')
              assert.strictEqual(forcedToRunSuite.meta[TEST_ITR_UNSKIPPABLE], 'true')
              assert.strictEqual(forcedToRunSuite.meta[TEST_ITR_FORCED_RUN], 'true')
            }, 25000)

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: envVars,
            }
          )

          childProcess.on('exit', () => {
            eventsPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        it('only sets forced to run if suite was going to be skipped by ITR', (done) => {
          receiver.setSettings({
            itr_enabled: true,
            code_coverage: true,
            tests_skipping: true,
          })

          receiver.setSuitesToSkip([
            {
              type: 'suite',
              attributes: {
                suite: `${featuresPath}farewell.feature`,
              },
            },
          ])

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const suites = events.filter(event => event.type === 'test_suite_end')

              assert.strictEqual(suites.length, 2)

              const testSession = events.find(event => event.type === 'test_session_end').content
              const testModule = events.find(event => event.type === 'test_session_end').content

              assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
              assert.ok(!(TEST_ITR_FORCED_RUN in testSession.meta))
              assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')
              assert.ok(!(TEST_ITR_FORCED_RUN in testModule.meta))

              const skippedSuite = suites.find(
                event => event.content.resource === 'test_suite.ci-visibility/features/farewell.feature'
              )
              const failedSuite = suites.find(
                event => event.content.resource === 'test_suite.ci-visibility/features/greetings.feature'
              )

              assert.strictEqual(skippedSuite.content.meta[TEST_STATUS], 'skip')
              assert.ok(!(TEST_ITR_UNSKIPPABLE in skippedSuite.content.meta))
              assert.ok(!(TEST_ITR_FORCED_RUN in skippedSuite.content.meta))

              assert.strictEqual(failedSuite.content.meta[TEST_STATUS], 'fail')
              assert.strictEqual(failedSuite.content.meta[TEST_ITR_UNSKIPPABLE], 'true')
              assert.ok(!(TEST_ITR_FORCED_RUN in failedSuite.content.meta))
            }, 25000)

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: envVars,
            }
          )

          childProcess.on('exit', () => {
            eventsPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        it('sets _dd.ci.itr.tests_skipped to false if the received suite is not skipped', (done) => {
          receiver.setSuitesToSkip([{
            type: 'suite',
            attributes: {
              suite: `${featuresPath}not-existing.feature`,
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
              assertItrSkippingEnabledTags(events, 'true')
            }, 25000)

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: envVars,
            }
          )
          childProcess.on('exit', () => {
            eventsPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        {
          const evpCompatibilityContext = isAgentless ? context.skip : context
          evpCompatibilityContext('if the agent is not event platform proxy compatible', () => {
            it('does not do any intelligent test runner request', (done) => {
              receiver.setInfoResponse({ endpoints: [] })

              receiver.assertPayloadReceived(() => {
                const error = new Error('should not request search_commits')
                done(error)
              }, ({ url }) => url === '/evp_proxy/v2/api/v2/git/repository/search_commits')
              receiver.assertPayloadReceived(() => {
                const error = new Error('should not request search_commits')
                done(error)
              }, ({ url }) => url === '/api/v2/git/repository/search_commits')
              receiver.assertPayloadReceived(() => {
                const error = new Error('should not request setting')
                done(error)
              }, ({ url }) => url === '/api/v2/libraries/tests/services/setting')
              receiver.assertPayloadReceived(() => {
                const error = new Error('should not request setting')
                done(error)
              }, ({ url }) => url === '/evp_proxy/v2/api/v2/libraries/tests/services/setting')

              receiver.assertPayloadReceived(({ payload }) => {
                const testSpans = payload.flatMap(trace => trace)
                const resourceNames = testSpans.map(span => span.resource)

                assertObjectContains(resourceNames,
                  [
                    `${featuresPath}farewell.feature.Say farewell`,
                    `${featuresPath}greetings.feature.Say greetings`,
                    `${featuresPath}greetings.feature.Say yeah`,
                    `${featuresPath}greetings.feature.Say yo`,
                    `${featuresPath}greetings.feature.Say skip`,
                  ]
                )
              }, ({ url }) => url === '/v0.4/traces').then(() => done()).catch(done)

              childProcess = exec(
                runTestsWithCoverageCommand,
                {
                  cwd,
                  env: getCiVisEvpProxyConfig(receiver.port),
                }
              )
            })
          })
        }

        it('reports itr_correlation_id in test suites', (done) => {
          const itrCorrelationId = '4321'
          receiver.setItrCorrelationId(itrCorrelationId)
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
              testSuites.forEach(testSuite => {
                assert.strictEqual(testSuite.itr_correlation_id, itrCorrelationId)
              })
            }, 25000)

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: envVars,
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
            itr_enabled: true,
            code_coverage: true,
            tests_skipping: false,
          })

          const codeCoveragesPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
              const coveredFiles = payloads
                .flatMap(({ payload }) => payload)
                .flatMap(({ content: { coverages } }) => coverages)
                .flatMap(({ files }) => files)
                .map(({ filename }) => filename)

              assertObjectContains(coveredFiles, [
                'ci-visibility/subproject/features/support/steps.js',
                'ci-visibility/subproject/features/greetings.feature',
              ])
            })

          childProcess = exec(
            '../../node_modules/nyc/bin/nyc.js node ../../node_modules/.bin/cucumber-js features/*.feature',
            {
              cwd: `${cwd}/ci-visibility/subproject`,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
              },
            }
          )

          childProcess.on('exit', () => {
            codeCoveragesPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        onlyLatestIt('can skip suites in parallel mode', async () => {
          receiver.setSuitesToSkip([{
            type: 'suite',
            attributes: {
              suite: `${featuresPath}farewell.feature`,
            },
          }])

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[CUCUMBER_IS_PARALLEL], 'true')
              assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
              assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
              assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
              assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)

              const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
              assert.strictEqual(suites.length, 2)

              const skippedSuite = suites.find(s =>
                s.resource === `test_suite.${featuresPath}farewell.feature`
              )
              assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
              assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')

              // greetings.feature ran (not skipped)
              const runningSuite = suites.find(s =>
                s.resource === `test_suite.${featuresPath}greetings.feature`
              )
              assert.ok(runningSuite)
              assert.ok(!(TEST_SKIPPED_BY_ITR in runningSuite.meta))

              // Only tests from the non-skipped suite ran
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              assert.ok(tests.length > 0, `Expected ${tests.length} > 0`)
              tests.forEach(test => {
                assert.ok(!test.meta[TEST_SUITE].includes('farewell'), `Got: ${inspect(test.meta[TEST_SUITE])}`)
              })
              assertItrSkippingEnabledTags(events, 'true')
            })

          childProcess = exec(
            parallelModeCommand,
            {
              cwd,
              env: getCiVisAgentlessConfig(receiver.port),
            }
          )
          await Promise.all([
            eventsPromise,
            once(childProcess, 'exit'),
          ])
        })
      })

      context('early flake detection', () => {
        it('retries new tests', (done) => {
          const NUM_RETRIES_EFD = 3
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD,
              },
            },
            known_tests_enabled: true,
          })
          // cucumber.ci-visibility/features/farewell.feature.Say whatever will be considered new
          receiver.setKnownTests(
            {
              cucumber: {
                'ci-visibility/features/farewell.feature': ['Say farewell'],
                'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip'],
              },
            }
          )
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const newTests = tests.filter(test =>
                test.resource === 'ci-visibility/features/farewell.feature.Say whatever'
              )
              newTests.forEach(test => {
                assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
              })
              const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
              // all but one has been retried
              assert.strictEqual(newTests.length - 1, retriedTests.length)
              assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
              retriedTests.forEach(test => {
                assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
              })
              // Test name does not change
              newTests.forEach(test => {
                assert.strictEqual(test.meta[TEST_NAME], 'Say whatever')
              })
            })
          childProcess = exec(
            runTestsCommand,
            {
              cwd,
              env: envVars,
            }
          )
          childProcess.on('exit', () => {
            eventsPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        it('disables manual Cucumber retries for new tests retried by EFD', async () => {
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
            cucumber: {},
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events
                .filter(event => event.type === 'test')
                .map(event => event.content)
                .filter(test =>
                  test.meta[TEST_SUITE] === 'ci-visibility/features-flaky/flaky.feature' &&
                  test.meta[TEST_NAME] === 'Say flaky'
                )
                .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

              assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]), ['fail', 'pass', 'fail'])
              assert.ok(!(TEST_IS_RETRY in tests[0].meta))
              assert.ok(!(TEST_RETRY_REASON in tests[0].meta))
              for (const retryTest of tests.slice(1)) {
                assert.strictEqual(retryTest.meta[TEST_IS_RETRY], 'true')
                assert.strictEqual(retryTest.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
              }
            })

          childProcess = exec(
            './node_modules/.bin/cucumber-js ci-visibility/features-flaky/flaky.feature --retry 1',
            {
              cwd,
              env: envVars,
            }
          )

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
          ])
          assert.strictEqual(exitCode, 0)
        })

        it('preserves manual Cucumber retries when the EFD retry budget is zero', async () => {
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': 0,
                '10s': 0,
                '30s': 0,
                '5m': 0,
              },
              faulty_session_threshold: 100,
            },
            flaky_test_retries_enabled: false,
            known_tests_enabled: true,
          })
          receiver.setKnownTests({
            cucumber: {},
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events
                .filter(event => event.type === 'test')
                .map(event => event.content)
                .filter(test =>
                  test.meta[TEST_SUITE] === 'ci-visibility/features-flaky/flaky.feature' &&
                  test.meta[TEST_NAME] === 'Say flaky'
                )
                .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

              const expectedStatuses = version === 'latest' ? ['fail', 'pass'] : ['pass']
              assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]), expectedStatuses)
              assert.ok(!(TEST_IS_RETRY in tests[0].meta))
              assert.ok(!(TEST_RETRY_REASON in tests[0].meta))
              if (version === 'latest') {
                assert.strictEqual(tests[1].meta[TEST_IS_RETRY], 'true')
                assert.strictEqual(tests[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
              }
            })

          childProcess = exec(
            './node_modules/.bin/cucumber-js ci-visibility/features-flaky/flaky.feature --retry 1',
            {
              cwd,
              env: envVars,
            }
          )

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
          ])
          assert.strictEqual(exitCode, 0)
        })

        it('aborts EFD retries when the matching slow_test_retries bucket is 0', (done) => {
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
            cucumber: {
              'ci-visibility/features/farewell.feature': ['Say farewell'],
              'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip'],
            },
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const slowTests = tests.filter(test =>
                test.resource === 'ci-visibility/features/farewell.feature.Say whatever'
              )

              assert.strictEqual(slowTests.length, 1)
              assert.strictEqual(slowTests[0].meta[TEST_IS_NEW], 'true')
              assert.strictEqual(slowTests[0].meta[TEST_EARLY_FLAKE_ABORT_REASON], 'slow')
              assert.ok(!(TEST_IS_RETRY in slowTests[0].meta))
            }, 20_000)

          childProcess = exec(runTestsCommand, {
            cwd,
            env: {
              ...envVars,
              SHOULD_ADD_SLOW_DURATION_TEST: '1',
            },
          })
          childProcess.on('exit', () => {
            eventsPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', (done) => {
          const NUM_RETRIES_EFD = 3
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD,
              },
            },
            known_tests_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const newTests = tests.filter(test =>
                test.meta[TEST_IS_NEW] === 'true'
              )
              // new tests are detected but not retried
              assert.strictEqual(newTests.length, 1)
              const retriedTests = tests.filter(test =>
                test.meta[TEST_IS_RETRY] === 'true'
              )
              assert.strictEqual(retriedTests.length, 0)
            })
          // cucumber.ci-visibility/features/farewell.feature.Say whatever will be considered new
          receiver.setKnownTests({
            cucumber: {
              'ci-visibility/features/farewell.feature': ['Say farewell'],
              'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip'],
            },
          })

          childProcess = exec(
            runTestsCommand,
            {
              cwd,
              env: { ...envVars, DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false' },
            }
          )
          childProcess.on('exit', () => {
            eventsPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        it('retries flaky tests and sets exit code to 0 as long as one attempt passes', (done) => {
          const NUM_RETRIES_EFD = 3
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD,
              },
            },
            known_tests_enabled: true,
          })
          // Tests in "cucumber.ci-visibility/features-flaky/flaky.feature" will be considered new
          receiver.setKnownTests({
            cucumber: {},
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)

              tests.forEach(test => {
                assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
              })
              // All test suites pass, even though there are failed tests
              testSuites.forEach(testSuite => {
                assert.strictEqual(testSuite.meta[TEST_STATUS], 'pass')
              })

              const failedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
              const passedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'pass')

              // (1 original run + 3 retries) / 2
              assert.strictEqual(failedAttempts.length, 2)
              assert.strictEqual(passedAttempts.length, 2)
            })

          childProcess = exec(
            './node_modules/.bin/cucumber-js ci-visibility/features-flaky/*.feature',
            {
              cwd,
              env: envVars,
            }
          )
          childProcess.on('exit', (exitCode) => {
            assert.strictEqual(exitCode, 0)
            eventsPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        it('does not retry tests that are skipped', (done) => {
          const NUM_RETRIES_EFD = 3
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD,
              },
            },
            known_tests_enabled: true,
          })
          // "cucumber.ci-visibility/features/farewell.feature.Say whatever" will be considered new
          // "cucumber.ci-visibility/features/greetings.feature.Say skip" will be considered new
          receiver.setKnownTests({
            cucumber: {
              'ci-visibility/features/farewell.feature': ['Say farewell'],
              'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo'],
            },
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const skippedNewTest = tests.filter(test =>
                test.resource === 'ci-visibility/features/greetings.feature.Say skip'
              )
              // not retried
              assert.strictEqual(skippedNewTest.length, 1)
            })

          childProcess = exec(
            runTestsCommand,
            {
              cwd,
              env: envVars,
            }
          )
          childProcess.on('exit', () => {
            eventsPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        it('does not run EFD if the known tests request fails', (done) => {
          const NUM_RETRIES_EFD = 3
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
            cucumber: {},
          })
          // Request module waits before retrying — need longer gather timeout
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSessionEnd = events.find(event => event.type === 'test_session_end')
              assert.ok(testSessionEnd, 'expected test_session_end event in payloads')
              const testSession = testSessionEnd.content
              assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              assert.strictEqual(tests.length, 6)
              const newTests = tests.filter(test =>
                test.meta[TEST_IS_NEW] === 'true'
              )
              assert.strictEqual(newTests.length, 0)
            }, 60000)

          childProcess = exec(
            runTestsCommand,
            { cwd, env: envVars }
          )

          childProcess.on('exit', () => {
            eventsPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        it('bails out of EFD if the percentage of new tests is too high', (done) => {
          const NUM_RETRIES_EFD = 3
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
          // tests in cucumber.ci-visibility/features/farewell.feature will be considered new
          receiver.setKnownTests(
            {
              cucumber: {
                'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip'],
              },
            }
          )
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
              assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
              assert.strictEqual(newTests.length, 0)

              const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
              assert.strictEqual(retriedTests.length, 0)
            })

          childProcess = exec(
            runTestsCommand,
            {
              cwd,
              env: envVars,
            }
          )

          childProcess.on('exit', () => {
            eventsPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        it('disables early flake detection if known tests should not be requested', (done) => {
          const NUM_RETRIES_EFD = 3
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD,
              },
            },
            known_tests_enabled: false,
          })
          // cucumber.ci-visibility/features/farewell.feature.Say whatever will be considered new
          receiver.setKnownTests(
            {
              cucumber: {
                'ci-visibility/features/farewell.feature': ['Say farewell'],
                'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip'],
              },
            }
          )
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              // no new tests detected
              const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
              assert.strictEqual(newTests.length, 0)
              // no retries
              const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
              assert.strictEqual(retriedTests.length, 0)
            })

          childProcess = exec(
            runTestsCommand,
            {
              cwd,
              env: envVars,
            }
          )

          childProcess.on('exit', () => {
            eventsPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        // EFD in parallel mode only supported from cucumber>=11
        context('parallel mode', () => {
          onlyLatestIt('retries new tests', (done) => {
            const NUM_RETRIES_EFD = 3
            receiver.setSettings({
              early_flake_detection: {
                enabled: true,
                slow_test_retries: {
                  '5s': NUM_RETRIES_EFD,
                },
              },
              known_tests_enabled: true,
            })
            // cucumber.ci-visibility/features/farewell.feature.Say whatever will be considered new
            receiver.setKnownTests(
              {
                cucumber: {
                  'ci-visibility/features/farewell.feature': ['Say farewell'],
                  'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip'],
                },
              }
            )
            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)

                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
                assert.strictEqual(testSession.meta[CUCUMBER_IS_PARALLEL], 'true')

                const tests = events.filter(event => event.type === 'test').map(event => event.content)

                const newTests = tests.filter(test =>
                  test.resource === 'ci-visibility/features/farewell.feature.Say whatever'
                )
                newTests.forEach(test => {
                  assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
                  // Test name does not change
                  assert.strictEqual(test.meta[TEST_NAME], 'Say whatever')
                  assert.strictEqual(test.meta[CUCUMBER_IS_PARALLEL], 'true')
                })
                const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
                // all but one has been retried
                assert.strictEqual(newTests.length - 1, retriedTests.length)
                assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
              })

            childProcess = exec(
              parallelModeCommand,
              {
                cwd,
                env: envVars,
              }
            )

            childProcess.on('exit', () => {
              eventsPromise.then(() => {
                done()
              }).catch(done)
            })
          })

          onlyLatestIt('retries flaky tests and sets exit code to 0 as long as one attempt passes', (done) => {
            const NUM_RETRIES_EFD = 3
            receiver.setSettings({
              early_flake_detection: {
                enabled: true,
                slow_test_retries: {
                  '5s': NUM_RETRIES_EFD,
                },
              },
              known_tests_enabled: true,
            })
            // Tests in "cucumber.ci-visibility/features-flaky/flaky.feature" will be considered new
            receiver.setKnownTests({
              cucumber: {},
            })

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)

                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
                assert.strictEqual(testSession.meta[CUCUMBER_IS_PARALLEL], 'true')
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const testSuites = events
                  .filter(event => event.type === 'test_suite_end').map(event => event.content)

                tests.forEach(test => {
                  assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
                  assert.strictEqual(test.meta[CUCUMBER_IS_PARALLEL], 'true')
                })

                // All test suites pass, even though there are failed tests
                testSuites.forEach(testSuite => {
                  assert.strictEqual(testSuite.meta[TEST_STATUS], 'pass')
                })

                const failedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
                const passedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'pass')

                // (1 original run + 3 retries) / 2
                assert.strictEqual(failedAttempts.length, 2)
                assert.strictEqual(passedAttempts.length, 2)
              })

            childProcess = exec(
              './node_modules/.bin/cucumber-js ci-visibility/features-flaky/*.feature --parallel 2',
              {
                cwd,
                env: envVars,
              }
            )

            childProcess.on('exit', (exitCode) => {
              assert.strictEqual(exitCode, 0)
              eventsPromise.then(() => {
                done()
              }).catch(done)
            })
          })

          onlyLatestIt('uses the worker EFD retry count for suite status', async () => {
            const NUM_RETRIES_EFD = 3
            receiver.setSettings({
              early_flake_detection: {
                enabled: true,
                slow_test_retries: {
                  '5s': NUM_RETRIES_EFD,
                  '10s': 0,
                },
              },
              known_tests_enabled: true,
            })
            receiver.setKnownTests({
              cucumber: {},
            })

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const testSession = events.find(event => event.type === 'test_session_end').content
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const testSuites = events
                  .filter(event => event.type === 'test_suite_end').map(event => event.content)

                assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
                assert.strictEqual(testSession.meta[CUCUMBER_IS_PARALLEL], 'true')
                testSuites.forEach(testSuite => {
                  assert.strictEqual(testSuite.meta[TEST_STATUS], 'pass')
                })

                const failedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
                const passedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'pass')

                assert.strictEqual(failedAttempts.length, 2)
                assert.strictEqual(passedAttempts.length, 2)
              })

            childProcess = exec(
              './node_modules/.bin/cucumber-js ci-visibility/features-flaky/*.feature --parallel 2',
              {
                cwd,
                env: {
                  ...envVars,
                  NODE_OPTIONS: '-r ./ci-visibility/cucumber-parallel-coordinator-slow-clock.js -r dd-trace/ci/init',
                },
              }
            )

            const [exitCode] = await once(childProcess, 'exit')
            assert.strictEqual(exitCode, 0)
            await eventsPromise
          })

          onlyLatestIt('preserves an all-zero EFD framework retry budget without a worker count', async () => {
            const testSuitePath = 'ci-visibility/features/farewell.feature'
            receiver.setSettings({
              early_flake_detection: {
                enabled: true,
                slow_test_retries: {
                  '10s': 0,
                },
              },
              known_tests_enabled: true,
            })
            receiver.setKnownTests({
              cucumber: {},
            })

            childProcess = exec(
              `./node_modules/.bin/cucumber-js ${testSuitePath} --parallel 2 ` +
                `--require-module "${path.join(cwd, 'ci-visibility/cucumber-worker-message-delay.js')}"`,
              {
                cwd,
                env: {
                  ...envVars,
                  DD_TEST_DROP_CUCUMBER_EFD_RETRY_COUNT_MESSAGES: '1',
                },
              }
            )

            await receiver.gatherPayloadsUntilChildExit(
              childProcess,
              ({ url }) => url.endsWith('/api/v2/citestcycle'),
              (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events
                  .filter(event => event.type === 'test')
                  .map(event => event.content)
                  .filter(test => test.meta[TEST_SUITE] === testSuitePath)
                const testSuites = events
                  .filter(event => event.type === 'test_suite_end')
                  .map(event => event.content)
                  .filter(testSuite => testSuite.meta[TEST_SUITE] === testSuitePath)

                assert.strictEqual(tests.length, 2)
                assert.strictEqual(tests.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 0)
                assert.strictEqual(testSuites.length, 1)
              },
              { hardTimeout: 60_000 }
            )
            assert.strictEqual(childProcess.exitCode, 0)
          })

          onlyLatestIt('bails out of EFD if the percentage of new tests is too high', (done) => {
            const NUM_RETRIES_EFD = 3
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
            // tests in cucumber.ci-visibility/features/farewell.feature will be considered new
            receiver.setKnownTests(
              {
                cucumber: {
                  'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip'],
                },
              }
            )

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)

                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
                assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')
                assert.strictEqual(testSession.meta[CUCUMBER_IS_PARALLEL], 'true')

                const tests = events.filter(event => event.type === 'test').map(event => event.content)

                const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
                assert.strictEqual(newTests.length, 0)

                const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
                assert.strictEqual(retriedTests.length, 0)
              })

            childProcess = exec(
              parallelModeCommand,
              {
                cwd,
                env: envVars,
              }
            )

            childProcess.on('exit', () => {
              eventsPromise.then(() => {
                done()
              }).catch(done)
            })
          })

          onlyLatestIt('does not retry tests that are skipped', (done) => {
            const NUM_RETRIES_EFD = 3
            receiver.setSettings({
              early_flake_detection: {
                enabled: true,
                slow_test_retries: {
                  '5s': NUM_RETRIES_EFD,
                },
              },
              known_tests_enabled: true,
            })
            // "cucumber.ci-visibility/features/farewell.feature.Say whatever" will be considered new
            // "cucumber.ci-visibility/features/greetings.feature.Say skip" will be considered new
            receiver.setKnownTests({
              cucumber: {
                'ci-visibility/features/farewell.feature': ['Say farewell'],
                'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo'],
              },
            })

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)

                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
                assert.strictEqual(testSession.meta[CUCUMBER_IS_PARALLEL], 'true')
                const tests = events.filter(event => event.type === 'test').map(event => event.content)

                const skippedNewTest = tests.filter(test =>
                  test.resource === 'ci-visibility/features/greetings.feature.Say skip'
                )
                // not retried
                assert.strictEqual(skippedNewTest.length, 1)
              })

            childProcess = exec(
              parallelModeCommand,
              {
                cwd,
                env: envVars,
              }
            )
            childProcess.on('exit', () => {
              eventsPromise.then(() => {
                done()
              }).catch(done)
            })
          })

          onlyLatestIt('does not detect new tests if the response is invalid', async () => {
            const NUM_RETRIES_EFD = 3
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
            receiver.setKnownTests(
              {
                'not-cucumber': {
                  'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip'],
                },
              }
            )

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)

                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
                assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')
                assert.strictEqual(testSession.meta[CUCUMBER_IS_PARALLEL], 'true')

                const tests = events.filter(event => event.type === 'test').map(event => event.content)

                const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
                assert.strictEqual(newTests.length, 0)

                const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
                assert.strictEqual(retriedTests.length, 0)
              })

            childProcess = exec(
              parallelModeCommand,
              {
                cwd,
                env: envVars,
              }
            )

            await Promise.all([
              once(childProcess, 'exit'),
              eventsPromise,
            ])
          })
        })
      })

      // flaky test retries only supported from >=8.0.0
      context('flaky test retries', () => {
        onlyLatestIt('can retry failed tests', (done) => {
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            flaky_test_retries_enabled: true,
            early_flake_detection: {
              enabled: false,
            },
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              // 2 failures and 1 passed attempt
              assert.strictEqual(tests.length, 3)

              const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
              assert.strictEqual(failedTests.length, 2)
              const passedTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
              assert.strictEqual(passedTests.length, 1)

              // All but the first one are retries
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
              assert.strictEqual(retriedTests.length, 2)
              assert.strictEqual(retriedTests.filter(
                test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
              ).length, 2)
            })

          childProcess = exec(
            './node_modules/.bin/cucumber-js ci-visibility/features-retry/*.feature',
            {
              cwd,
              env: envVars,
            }
          )

          childProcess.on('exit', () => {
            eventsPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        onlyLatestIt('is disabled if DD_CIVISIBILITY_FLAKY_RETRY_ENABLED is false', (done) => {
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            flaky_test_retries_enabled: true,
            early_flake_detection: {
              enabled: false,
            },
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              assert.strictEqual(tests.length, 1)

              const retriedTests = tests.filter(
                test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
              )
              assert.strictEqual(retriedTests.length, 0)
            })

          childProcess = exec(
            './node_modules/.bin/cucumber-js ci-visibility/features-retry/*.feature',
            {
              cwd,
              env: {
                ...envVars,
                DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false',
              },
            }
          )

          childProcess.on('exit', () => {
            eventsPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        onlyLatestIt('retries DD_CIVISIBILITY_FLAKY_RETRY_COUNT times', (done) => {
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            flaky_test_retries_enabled: true,
            early_flake_detection: {
              enabled: false,
            },
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              // 2 failures
              assert.strictEqual(tests.length, 2)

              const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
              assert.strictEqual(failedTests.length, 2)
              const passedTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
              assert.strictEqual(passedTests.length, 0)

              // All but the first one are retries
              const retriedTests = tests.filter(
                test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
              )
              assert.strictEqual(retriedTests.length, 1)
            })

          childProcess = exec(
            './node_modules/.bin/cucumber-js ci-visibility/features-retry/*.feature',
            {
              cwd,
              env: {
                ...envVars,
                DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
              },
            }
          )

          childProcess.on('exit', () => {
            eventsPromise.then(() => {
              done()
            }).catch(done)
          })
        })

        onlyLatestIt('sets TEST_HAS_FAILED_ALL_RETRIES when all ATR attempts fail', async () => {
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

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              assert.strictEqual(tests.length, 2, 'initial + 1 ATR retry')
              const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
              assert.strictEqual(failedTests.length, 2)
              const lastFailed = failedTests[failedTests.length - 1]
              assert.strictEqual(lastFailed.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
              assert.strictEqual(lastFailed.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
            })

          childProcess = exec(
            './node_modules/.bin/cucumber-js ci-visibility/features-retry/*.feature',
            {
              cwd,
              env: {
                ...envVars,
                DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
              },
            }
          )

          await Promise.all([once(childProcess, 'exit'), eventsPromise])
        })
      })
      // Dynamic instrumentation only supported from >=8.0.0
      context('dynamic instrumentation', () => {
        onlyLatestIt('does not activate if DD_TEST_FAILED_TEST_REPLAY_ENABLED is set to false', (done) => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTests = tests.filter(
                test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
              )

              assert.strictEqual(retriedTests.length, 1)
              const [retriedTest] = retriedTests

              const hasDebugTags = Object.keys(retriedTest.meta)
                .some(property =>
                  property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                )

              assert.strictEqual(hasDebugTags, false)
            })
          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === logsEndpoint, (payloads) => {
              if (payloads.length > 0) {
                throw new Error('Unexpected logs')
              }
            }, 5000)

          childProcess = exec(
            './node_modules/.bin/cucumber-js ci-visibility/features-di/test-hit-breakpoint.feature --retry 1',
            {
              cwd,
              env: {
                ...envVars,
                DD_TEST_FAILED_TEST_REPLAY_ENABLED: 'false',
              },
            }
          )

          childProcess.on('exit', () => {
            Promise.all([eventsPromise, logsPromise]).then(() => {
              done()
            }).catch(done)
          })
        })

        onlyLatestIt('does not activate dynamic instrumentation if remote settings are disabled', (done) => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: false,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTests = tests.filter(
                test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
              )

              assert.strictEqual(retriedTests.length, 1)
              const [retriedTest] = retriedTests
              const hasDebugTags = Object.keys(retriedTest.meta)
                .some(property =>
                  property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                )

              assert.strictEqual(hasDebugTags, false)
            })
          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === logsEndpoint, (payloads) => {
              if (payloads.length > 0) {
                throw new Error('Unexpected logs')
              }
            }, 5000)

          childProcess = exec(
            './node_modules/.bin/cucumber-js ci-visibility/features-di/test-hit-breakpoint.feature --retry 1',
            {
              cwd,
              env: envVars,
            }
          )

          childProcess.on('exit', () => {
            Promise.all([eventsPromise, logsPromise]).then(() => {
              done()
            }).catch(done)
          })
        })

        onlyLatestIt('runs retries with dynamic instrumentation', (done) => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: true,
          })

          let snapshotIdByTest, snapshotIdByLog
          let spanIdByTest, spanIdByLog, traceIdByTest, traceIdByLog

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const retriedTests = tests.filter(
                test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
              )

              assert.strictEqual(retriedTests.length, 1)
              const [retriedTest] = retriedTests

              assert.strictEqual(retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED], 'true')

              assert.strictEqual(retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
                .endsWith('ci-visibility/features-di/support/sum.js'), true)
              assert.strictEqual(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 6)

              const snapshotIdKey = `${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX}`
              assert.ok(retriedTest.meta[snapshotIdKey])

              snapshotIdByTest = retriedTest.meta[snapshotIdKey]
              spanIdByTest = retriedTest.span_id.toString()
              traceIdByTest = retriedTest.trace_id.toString()
            })

          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === logsEndpoint, (payloads) => {
              const [{ logMessage: [diLog] }] = payloads
              assertObjectContains(diLog, {
                ddsource: 'dd_debugger',
                level: 'error',
              })
              assert.ok(diLog.ddtags.includes('git.repository_url:'), `Got: ${inspect(diLog.ddtags)}`)
              assert.ok(diLog.ddtags.includes('git.commit.sha:'), `Got: ${inspect(diLog.ddtags)}`)
              assert.strictEqual(diLog.debugger.snapshot.language, 'javascript')
              assertObjectContains(diLog.debugger.snapshot.captures.lines['6'].locals, {
                a: {
                  type: 'number',
                  value: '11',
                },
                b: {
                  type: 'number',
                  value: '3',
                },
                localVariable: {
                  type: 'number',
                  value: '2',
                },
              })
              spanIdByLog = diLog.dd.span_id
              traceIdByLog = diLog.dd.trace_id
              snapshotIdByLog = diLog.debugger.snapshot.id
            })

          childProcess = exec(
            './node_modules/.bin/cucumber-js ci-visibility/features-di/test-hit-breakpoint.feature --retry 1',
            {
              cwd,
              env: {
                ...envVars,
                DD_TRACE_DEBUG: '1',
                DD_TRACE_LOG_LEVEL: 'warn',
              },
            }
          )

          // TODO: remove once we figure out flakiness
          childProcess.stdout?.pipe(process.stdout)
          childProcess.stderr?.pipe(process.stderr)

          childProcess.on('exit', () => {
            Promise.all([eventsPromise, logsPromise]).then(() => {
              assert.strictEqual(snapshotIdByTest, snapshotIdByLog)
              assert.strictEqual(spanIdByTest, spanIdByLog)
              assert.strictEqual(traceIdByTest, traceIdByLog)
              done()
            }).catch(done)
          })
        })

        onlyLatestIt('runs every retried attempt with active dynamic instrumentation', async () => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: true,
          })

          const snapshotIdsByTest = new Set()
          const spanIdsByTest = new Set()
          const traceIdsByTest = new Set()
          const snapshotIdsByLog = new Set()
          const spanIdsByLog = new Set()
          const traceIdsByLog = new Set()

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTestsWithDebugInfo = tests.filter(
                test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr &&
                  test.meta[DI_ERROR_DEBUG_INFO_CAPTURED] === 'true'
              )

              assert.strictEqual(retriedTestsWithDebugInfo.length, 2)
              for (const retriedTest of retriedTestsWithDebugInfo) {
                assert.strictEqual(retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
                  .endsWith('ci-visibility/features-di/support/sum.js'), true)
                assert.strictEqual(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 6)

                const snapshotIdKey = `${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX}`
                assert.ok(retriedTest.meta[snapshotIdKey])
                snapshotIdsByTest.add(retriedTest.meta[snapshotIdKey])
                spanIdsByTest.add(retriedTest.span_id.toString())
                traceIdsByTest.add(retriedTest.trace_id.toString())
              }
            })

          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === logsEndpoint, (payloads) => {
              const diLogs = payloads.flatMap(({ logMessage }) => logMessage)
              assert.strictEqual(diLogs.length, 2)
              for (const diLog of diLogs) {
                assertObjectContains(diLog, {
                  ddsource: 'dd_debugger',
                  level: 'error',
                })
                assert.strictEqual(diLog.debugger.snapshot.language, 'javascript')
                assertObjectContains(diLog.debugger.snapshot.captures.lines['6'].locals, {
                  a: {
                    type: 'number',
                    value: '11',
                  },
                  b: {
                    type: 'number',
                    value: '3',
                  },
                  localVariable: {
                    type: 'number',
                    value: '2',
                  },
                })
                spanIdsByLog.add(diLog.dd.span_id)
                traceIdsByLog.add(diLog.dd.trace_id)
                snapshotIdsByLog.add(diLog.debugger.snapshot.id)
              }
            })

          childProcess = exec(
            './node_modules/.bin/cucumber-js ci-visibility/features-di/test-hit-breakpoint-multiple-retries.feature ' +
              '--retry 3',
            {
              cwd,
              env: envVars,
            }
          )

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
            logsPromise,
          ])
          assert.strictEqual(exitCode, 0)
          assert.deepStrictEqual(snapshotIdsByTest, snapshotIdsByLog)
          assert.deepStrictEqual(spanIdsByTest, spanIdsByLog)
          assert.deepStrictEqual(traceIdsByTest, traceIdsByLog)
        })

        onlyLatestIt('does not hang when tests use fake timers and Failed Test Replay is enabled', async () => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              assert.strictEqual(tests.length, 2)
              const retriedTests = tests.filter(
                t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
              )
              assert.strictEqual(retriedTests.length, 1)
            })

          const featurePath = 'ci-visibility/features-di-fake-timers/test-hit-breakpoint.feature'
          childProcess = exec(
            `./node_modules/.bin/cucumber-js ${featurePath} --retry 1`,
            {
              cwd,
              env: envVars,
            }
          )

          const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
          assert.strictEqual(exitCode, 1)
        })

        onlyLatestIt('does not crash if the retry does not hit the breakpoint', (done) => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTests = tests.filter(
                test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
              )

              assert.strictEqual(retriedTests.length, 1)
              const [retriedTest] = retriedTests

              const hasDebugTags = Object.keys(retriedTest.meta)
                .some(property =>
                  property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                )

              assert.strictEqual(hasDebugTags, false)
            })
          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
              if (payloads.length > 0) {
                throw new Error('Unexpected logs')
              }
            }, 5000)

          childProcess = exec(
            './node_modules/.bin/cucumber-js ci-visibility/features-di/test-not-hit-breakpoint.feature --retry 1',
            {
              cwd,
              env: envVars,
            }
          )

          childProcess.on('exit', (exitCode) => {
            Promise.all([eventsPromise, logsPromise]).then(() => {
              assert.strictEqual(exitCode, 0)
              done()
            }).catch(done)
          })
        })
      })
    })
  })
})
