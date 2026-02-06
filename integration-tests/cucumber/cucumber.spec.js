'use strict'

const assert = require('node:assert/strict')

const { once } = require('node:events')
const { exec, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { assertObjectContains } = require('../helpers')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { ORIGIN_KEY, COMPONENT } = require('../../packages/dd-trace/src/constants')
const {
  TEST_STATUS,
  TEST_TYPE,
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
  TEST_CODE_OWNERS,
  TEST_SESSION_NAME,
  TEST_LEVEL_EVENT_TYPES,
  DI_ERROR_DEBUG_INFO_CAPTURED,
  DI_DEBUG_ERROR_PREFIX,
  DI_DEBUG_ERROR_FILE_SUFFIX,
  DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX,
  DI_DEBUG_ERROR_LINE_SUFFIX,
  TEST_RETRY_REASON,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  DD_CAPABILITIES_EARLY_FLAKE_DETECTION,
  DD_CAPABILITIES_AUTO_TEST_RETRIES,
  DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE,
  DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE,
  DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX,
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_RETRY_REASON_TYPES,
  GIT_COMMIT_SHA,
  GIT_REPOSITORY_URL,
  TEST_IS_MODIFIED,
  DD_CAPABILITIES_IMPACTED_TESTS,
  TEST_FRAMEWORK,
  TEST_FRAMEWORK_VERSION,
  CI_APP_ORIGIN,
  TEST_SKIP_REASON,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { SAMPLING_PRIORITY } = require('../../ext/tags')
const { AUTO_KEEP } = require('../../ext/priority')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { NODE_MAJOR } = require('../../version')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../packages/dd-trace/src/constants')

const version = process.env.CUCUMBER_VERSION || 'latest'

const onlyLatestIt = version === 'latest' ? it : it.skip

const runTestsCommand = './node_modules/.bin/cucumber-js ci-visibility/features/*.feature'
const runTestsWithCoverageCommand = './node_modules/nyc/bin/nyc.js -r=text-summary ' +
  'node ./node_modules/.bin/cucumber-js ci-visibility/features/*.feature'
const parallelModeCommand = './node_modules/.bin/cucumber-js ci-visibility/features/*.feature --parallel 2'
const featuresPath = 'ci-visibility/features/'
const fileExtension = 'js'

// TODO: add esm tests
describe(`cucumber@${version} commonJS`, () => {
  if ((NODE_MAJOR === 18 || NODE_MAJOR === 23) && version === 'latest') return

  let cwd, receiver, childProcess, testOutput

  useSandbox([`@cucumber/cucumber@${version}`, 'assert', 'nyc'], true)

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

  it('sends telemetry with test_session metric when telemetry is enabled', async () => {
    receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

    const telemetryPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/apmtelemetry'), (payloads) => {
        const telemetryMetrics = payloads.flatMap(({ payload }) => payload.payload.series)

        const testSessionMetric = telemetryMetrics.find(
          ({ metric }) => metric === 'test_session'
        )

        assert.ok(testSessionMetric, 'test_session telemetry metric should be sent')
      })

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          DD_TRACE_AGENT_PORT: String(receiver.port),
          DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
        },
      }
    )

    await Promise.all([
      once(childProcess, 'exit'),
      telemetryPromise,
    ])
  })

  context('with APM protocol (old agents)', () => {
    it('can report tests', async function () {
      receiver.setInfoResponse({ endpoints: [] })

      const testInfoByTestName = {
        'pass scenario': {
          status: 'pass',
          steps: [
            { name: 'datadog', stepStatus: 'pass' },
            { name: 'run', stepStatus: 'pass' },
            { name: 'pass', stepStatus: 'pass' },
          ],
        },
        'fail scenario': {
          status: 'fail',
          steps: [
            { name: 'datadog', stepStatus: 'pass' },
            { name: 'run', stepStatus: 'pass' },
            { name: 'fail', stepStatus: 'fail' },
          ],
        },
        'skip scenario': {
          status: 'skip',
          steps: [
            { name: 'datadog', stepStatus: 'pass' },
            { name: 'run', stepStatus: 'pass' },
            { name: 'skip', stepStatus: 'skip' },
          ],
        },
        'skip scenario based on tag': {
          status: 'skip',
          steps: [
            { name: 'datadog', stepStatus: 'skip' },
          ],
        },
        'not implemented scenario': {
          status: 'skip',
          steps: [
            { name: 'datadog', stepStatus: 'pass' },
            { name: 'not-implemented', stepStatus: 'skip' },
          ],
        },
        'integration scenario': {
          status: 'pass',
          steps: [
            { name: 'datadog', stepStatus: 'pass' },
            { name: 'integration', stepStatus: 'pass' },
            { name: 'pass', stepStatus: 'pass' },
          ],
        },
        'hooks fail': {
          status: 'fail',
          steps: [
            { name: 'datadog', stepStatus: 'skip' },
            { name: 'run', stepStatus: 'skip' },
            { name: 'pass', stepStatus: 'skip' },
          ],
        },
      }

      const envVars = getCiVisEvpProxyConfig(receiver.port)

      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('v0.4/traces'), (payloads) => {
          const spans = payloads.flatMap(({ payload }) => payload.flatMap(trace => trace))
          const testSpans = spans.filter(span => span.name === 'cucumber.test')

          const resourceNames = testSpans.map(span => span.resource)

          assertObjectContains(resourceNames, [
            'ci-visibility/cucumber-plugin-tests/features/simple.feature.pass scenario',
            'ci-visibility/cucumber-plugin-tests/features/simple.feature.fail scenario',
            'ci-visibility/cucumber-plugin-tests/features/simple.feature.skip scenario',
            'ci-visibility/cucumber-plugin-tests/features/simple.feature.skip scenario based on tag',
            'ci-visibility/cucumber-plugin-tests/features/simple.feature.not implemented scenario',
            'ci-visibility/cucumber-plugin-tests/features/simple.feature.integration scenario',
            'ci-visibility/cucumber-plugin-tests/features/simple.feature.hooks fail',
          ])

          testSpans.forEach(testSpan => {
            const testName = testSpan.meta[TEST_NAME]
            assert.strictEqual(testSpan.meta.language, 'javascript')
            assert.strictEqual(testSpan.meta.service, 'cucumber-test-service')
            const { status } = testInfoByTestName[testName]
            assert.strictEqual(testSpan.meta[TEST_STATUS], status,
              `Expected status for ${testName} to be ${status}`)
            assert.strictEqual(testSpan.meta[TEST_TYPE], 'test')
            assert.strictEqual(testSpan.meta[TEST_FRAMEWORK], 'cucumber')
            assert.strictEqual(testSpan.meta[ORIGIN_KEY], CI_APP_ORIGIN)
            assert.strictEqual(testSpan.meta[COMPONENT], 'cucumber')
            assert.strictEqual(testSpan.metrics[SAMPLING_PRIORITY], AUTO_KEEP)
            assert.ok(testSpan.meta[TEST_FRAMEWORK_VERSION])
            assert.strictEqual(testSpan.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
            assert.strictEqual(testSpan.meta[TEST_SUITE], 'ci-visibility/cucumber-plugin-tests/features/simple.feature')
            assert.strictEqual(
              testSpan.meta[TEST_SOURCE_FILE],
              'ci-visibility/cucumber-plugin-tests/features/simple.feature',
              'Test source file should be the simple feature'
            )
            assert.ok(testSpan.metrics[TEST_SOURCE_START])
            assert.strictEqual(testSpan.type, 'test')
            assert.strictEqual(testSpan.name, 'cucumber.test')
            assert.strictEqual(testSpan.parent_id.toString(), '0')
            if (testName === 'integration scenario') {
              const endpointUrl = envVars.DD_CIVISIBILITY_AGENTLESS_URL ||
                `http://127.0.0.1:${envVars.DD_TRACE_AGENT_PORT}`
              const httpSpan = spans.find(span => span.name === 'http.request')
              assert.strictEqual(httpSpan.meta[ORIGIN_KEY], CI_APP_ORIGIN, 'HTTP span should have the correct origin')
              assert.strictEqual(httpSpan.meta['http.url'], `${endpointUrl}/info`,
                'HTTP span should have the correct url')
              const parentCucumberStep = spans.find(span => span.meta['cucumber.step'] === 'integration')
              assert.strictEqual(httpSpan.parent_id.toString(), parentCucumberStep.span_id.toString(),
                'HTTP span should be child of the cucumber step span')
            }

            if (testName === 'not implemented scenario') {
              const notImplementedStepSpan = spans.find(span => span.meta['cucumber.step'] === 'not-implemented')
              assert.strictEqual(notImplementedStepSpan.meta[TEST_SKIP_REASON], 'not implemented')
            }

            if (testName === 'fail scenario') {
              assert.strictEqual(testSpan.meta[ERROR_TYPE], 'Error')
              const errorMessage = testSpan.meta[ERROR_MESSAGE]
              assert.match(errorMessage, /AssertionError/)
              assert.match(errorMessage, /datadog/)
              assert.match(errorMessage, /godatad/)
              assert.ok(testSpan.meta[ERROR_STACK])
            }

            if (testName === 'hooks fail') {
              assert.strictEqual(testSpan.meta[ERROR_TYPE], 'Error')
              const errorMessage = testSpan.meta[ERROR_MESSAGE]
              assert.match(errorMessage, /TypeError: Cannot set/)
              assert.match(errorMessage, /of undefined/)
              assert.match(errorMessage, /boom/)
              assert.ok(testSpan.meta[ERROR_STACK])
            }

            const testSteps = spans.filter(
              span => span.name === 'cucumber.step' && span.parent_id.toString() === testSpan.span_id.toString()
            )
            const { steps } = testInfoByTestName[testName]
            steps.forEach(({ name, stepStatus }) => {
              const stepSpan = testSteps.find(span => span.meta['cucumber.step'] === name)
              assert.ok(stepSpan)
              assert.strictEqual(stepSpan.meta['step.status'], stepStatus,
                `Test ${testName} should have step ${name} with status ${stepStatus}`)
              assert.strictEqual(stepSpan.meta[COMPONENT], 'cucumber')
              assert.notStrictEqual(stepSpan.type, 'test')
            })
          })
        })

      childProcess = exec(
        './node_modules/.bin/cucumber-js ci-visibility/cucumber-plugin-tests/features/*.feature',
        {
          cwd,
          env: {
            ...envVars,
            DD_SERVICE: 'cucumber-test-service',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })
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
      const runModes = ['serial']

      if (version !== '7.0.0') { // only on latest or 9 if node is old
        runModes.push('parallel')
      }

      runModes.forEach((runMode) => {
        it(`(${runMode}) can run and report tests`, (done) => {
          const runCommand = runMode === 'parallel' ? parallelModeCommand : runTestsCommand

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

              const stepEvents = events.filter(event => event.type === 'span')

              const { content: testSessionEventContent } = testSessionEvent
              const { content: testModuleEventContent } = testModuleEvent

              if (runMode === 'parallel') {
                assert.strictEqual(testSessionEventContent.meta[CUCUMBER_IS_PARALLEL], 'true')
              }

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
                assert.ok(meta[TEST_COMMAND])
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
                assert.ok(meta[TEST_COMMAND])
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
                assert.ok(Object.hasOwn(stepEvent.content.meta, 'cucumber.step'))
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
              assert.strictEqual(coveragePayload.name, 'coverage1')
              assert.strictEqual(coveragePayload.filename, 'coverage1.msgpack')
              assert.strictEqual(coveragePayload.type, 'application/msgpack')

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
              assert.ok(!('TEST_ITR_UNSKIPPABLE' in skippedSuite.meta))
              assert.ok(!('TEST_ITR_FORCED_RUN' in skippedSuite.meta))

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
              assert.ok(!('TEST_ITR_FORCED_RUN' in testSession.meta))
              assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')
              assert.ok(!('TEST_ITR_FORCED_RUN' in testModule.meta))

              const skippedSuite = suites.find(
                event => event.content.resource === 'test_suite.ci-visibility/features/farewell.feature'
              )
              const failedSuite = suites.find(
                event => event.content.resource === 'test_suite.ci-visibility/features/greetings.feature'
              )

              assert.strictEqual(skippedSuite.content.meta[TEST_STATUS], 'skip')
              assert.ok(!('TEST_ITR_UNSKIPPABLE' in skippedSuite.content.meta))
              assert.ok(!('TEST_ITR_FORCED_RUN' in skippedSuite.content.meta))

              assert.strictEqual(failedSuite.content.meta[TEST_STATUS], 'fail')
              assert.strictEqual(failedSuite.content.meta[TEST_ITR_UNSKIPPABLE], 'true')
              assert.ok(!('TEST_ITR_FORCED_RUN' in failedSuite.content.meta))
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

        if (!isAgentless) {
          context('if the agent is not event platform proxy compatible', () => {
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
              assert.ok(!('TEST_EARLY_FLAKE_ENABLED' in testSession.meta))

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
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.ok(!('TEST_EARLY_FLAKE_ENABLED' in testSession.meta))
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              assert.strictEqual(tests.length, 6)
              const newTests = tests.filter(test =>
                test.meta[TEST_IS_NEW] === 'true'
              )
              assert.strictEqual(newTests.length, 0)
            })

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
              assert.ok(!('TEST_EARLY_FLAKE_ENABLED' in testSession.meta))
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
              assert.ok(!('TEST_EARLY_FLAKE_ENABLED' in testSession.meta))
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
                assert.ok(!('TEST_EARLY_FLAKE_ENABLED' in testSession.meta))
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
                assert.ok(!('TEST_EARLY_FLAKE_ENABLED' in testSession.meta))
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

  it('correctly calculates test code owners when working directory is not repository root', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)

        const test = events.find(event => event.type === 'test').content
        const testSuite = events.find(event => event.type === 'test_suite_end').content
        // The test is in a subproject
        assert.notStrictEqual(test.meta[TEST_SOURCE_FILE], test.meta[TEST_SUITE])
        assert.strictEqual(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
        assert.strictEqual(testSuite.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
      })

    childProcess = exec(
      'node ../../node_modules/.bin/cucumber-js features/*.feature',
      {
        cwd: `${cwd}/ci-visibility/subproject`,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
        },
      }
    )

    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
  })

  it('takes into account untested files if "all" is passed to nyc', (done) => {
    const linesPctMatchRegex = /Lines\s*:\s*([\d.]+)%/
    let linesPctMatch
    let linesPctFromNyc = 0
    let codeCoverageWithUntestedFiles = 0
    let codeCoverageWithoutUntestedFiles = 0

    let eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testSession = events.find(event => event.type === 'test_session_end').content
        codeCoverageWithUntestedFiles = testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT]
      })

    childProcess = exec(
      './node_modules/nyc/bin/nyc.js --all -r=text-summary --nycrc-path ./my-nyc.config.js ' +
      'node ./node_modules/.bin/cucumber-js ci-visibility/features/*.feature',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          NYC_INCLUDE: JSON.stringify(
            [
              'ci-visibility/features/**',
              'ci-visibility/features-esm/**',
            ]
          ),
        },
      }
    )

    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })

    childProcess.on('exit', () => {
      linesPctMatch = testOutput.match(linesPctMatchRegex)
      linesPctFromNyc = linesPctMatch ? Number(linesPctMatch[1]) : -Infinity

      assert.strictEqual(linesPctFromNyc, codeCoverageWithUntestedFiles,
        'nyc --all output does not match the reported coverage')

      // reset test output for next test session
      testOutput = ''
      // we run the same tests without the all flag
      childProcess = exec(
        './node_modules/nyc/bin/nyc.js -r=text-summary --nycrc-path ./my-nyc.config.js ' +
        'node ./node_modules/.bin/cucumber-js ci-visibility/features/*.feature',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NYC_INCLUDE: JSON.stringify(
              [
                'ci-visibility/features/**',
                'ci-visibility/features-esm/**',
              ]
            ),
          },
        }
      )

      eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          codeCoverageWithoutUntestedFiles = testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT]
        })

      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      childProcess.on('exit', () => {
        linesPctMatch = testOutput.match(linesPctMatchRegex)
        linesPctFromNyc = linesPctMatch ? Number(linesPctMatch[1]) : -Infinity

        assert.strictEqual(linesPctFromNyc, codeCoverageWithoutUntestedFiles,
          'nyc output does not match the reported coverage (no --all flag)')

        eventsPromise.then(() => {
          assert.ok(codeCoverageWithoutUntestedFiles > codeCoverageWithUntestedFiles)
          done()
        }).catch(done)
      })
    })
  })

  context('known tests without early flake detection', () => {
    it('detects new tests without retrying them', (done) => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: false,
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
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.ok(!('TEST_EARLY_FLAKE_ENABLED' in testSession.meta))
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // new tests detected but not retried
          const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
          assert.strictEqual(newTests.length, 1)
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })
  })

  it('sets _dd.test.is_user_provided_service to true if DD_SERVICE is used', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)

        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        tests.forEach(test => {
          assert.strictEqual(test.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'true')
        })
      })

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_SERVICE: 'my-service',
        },
      }
    )

    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
  })

  context('test management', () => {
    context('attempt to fix', () => {
      beforeEach(() => {
        receiver.setTestManagementTests({
          cucumber: {
            suites: {
              'ci-visibility/features-test-management/attempt-to-fix.feature': {
                tests: {
                  'Say attempt to fix': {
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
        isQuarantined,
        isDisabled,
        shouldAlwaysPass,
        shouldFailSometimes,
      }) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isAttemptToFix) {
              assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
            } else {
              assert.ok(!('TEST_MANAGEMENT_ENABLED' in testSession.meta))
            }

            const retriedTests = tests.filter(
              test => test.meta[TEST_NAME] === 'Say attempt to fix'
            )

            if (isAttemptToFix) {
              // 3 retries + 1 initial run
              assert.strictEqual(retriedTests.length, 4)
            } else {
              assert.strictEqual(retriedTests.length, 1)
            }

            for (let i = 0; i < retriedTests.length; i++) {
              const isFirstAttempt = i === 0
              const isLastAttempt = i === retriedTests.length - 1
              const test = retriedTests[i]

              assert.strictEqual(
                test.resource,
                'ci-visibility/features-test-management/attempt-to-fix.feature.Say attempt to fix'
              )

              if (isDisabled) {
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
              } else if (isQuarantined) {
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              } else {
                assert.ok(!('TEST_MANAGEMENT_IS_DISABLED' in test.meta))
                assert.ok(!('TEST_MANAGEMENT_IS_QUARANTINED' in test.meta))
              }

              if (isAttemptToFix) {
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
                if (!isFirstAttempt) {
                  assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                  assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
                }
                if (isLastAttempt) {
                  if (shouldFailSometimes) {
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                    assert.ok(!('TEST_HAS_FAILED_ALL_RETRIES' in test.meta))
                  } else if (shouldAlwaysPass) {
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
                  } else {
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                    assert.strictEqual(test.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
                  }
                }
              } else {
                assert.ok(!('TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX' in test.meta))
                assert.ok(!('TEST_IS_RETRY' in test.meta))
                assert.ok(!('TEST_RETRY_REASON' in test.meta))
              }
            }
          })

      /**
       * @param {() => void} done
       * @param {{
       *   isAttemptToFix?: boolean,
       *   isQuarantined?: boolean,
       *   isDisabled?: boolean,
       *   extraEnvVars?: Record<string, string>,
       *   shouldAlwaysPass?: boolean,
       *   shouldFailSometimes?: boolean
       * }} [options]
       */
      const runTest = (done, {
        isAttemptToFix,
        isQuarantined,
        isDisabled,
        extraEnvVars,
        shouldAlwaysPass,
        shouldFailSometimes,
      } = {}) => {
        const testAssertions = getTestAssertions({
          isAttemptToFix,
          isQuarantined,
          isDisabled,
          shouldAlwaysPass,
          shouldFailSometimes,
        })
        let stdout = ''

        childProcess = exec(
          './node_modules/.bin/cucumber-js ci-visibility/features-test-management/attempt-to-fix.feature',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              ...extraEnvVars,
              ...(shouldAlwaysPass ? { SHOULD_ALWAYS_PASS: '1' } : {}),
              ...(shouldFailSometimes ? { SHOULD_FAIL_SOMETIMES: '1' } : {}),
            },
          }
        )

        childProcess.stdout?.on('data', (data) => {
          stdout += data.toString()
        })

        childProcess.on('exit', exitCode => {
          testAssertions.then(() => {
            assert.match(stdout, /I am running/)
            if (isQuarantined || isDisabled || shouldAlwaysPass) {
              assert.strictEqual(exitCode, 0)
            } else {
              assert.strictEqual(exitCode, 1)
            }
            done()
          }).catch(done)
        })
      }

      it('can attempt to fix and mark last attempt as failed if every attempt fails', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runTest(done, { isAttemptToFix: true })
      })

      it('can attempt to fix and mark last attempt as passed if every attempt passes', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runTest(done, { isAttemptToFix: true, shouldAlwaysPass: true })
      })

      it('can attempt to fix and not mark last attempt if attempts both pass and fail', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runTest(done, { isAttemptToFix: true, shouldFailSometimes: true })
      })

      it('does not attempt to fix tests if test management is not enabled', (done) => {
        receiver.setSettings({ test_management: { enabled: false, attempt_to_fix_retries: 3 } })

        runTest(done)
      })

      it('does not enable attempt to fix tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runTest(done, {
          extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' },
        })
      })

      it('does not fail retry if a test is quarantined', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
        receiver.setTestManagementTests({
          cucumber: {
            suites: {
              'ci-visibility/features-test-management/attempt-to-fix.feature': {
                tests: {
                  'Say attempt to fix': {
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

        runTest(done, {
          isAttemptToFix: true,
          isQuarantined: true,
        })
      })

      it('does not fail retry if a test is disabled', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
        receiver.setTestManagementTests({
          cucumber: {
            suites: {
              'ci-visibility/features-test-management/attempt-to-fix.feature': {
                tests: {
                  'Say attempt to fix': {
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

        runTest(done, {
          isAttemptToFix: true,
          isDisabled: true,
        })
      })
    })

    context('disabled', () => {
      beforeEach(() => {
        receiver.setTestManagementTests({
          cucumber: {
            suites: {
              'ci-visibility/features-test-management/disabled.feature': {
                tests: {
                  'Say disabled': {
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
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.find(event => event.type === 'test').content
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isDisabling) {
              assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
              assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
            } else {
              assert.ok(!('TEST_MANAGEMENT_ENABLED' in testSession.meta))
              assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
            }

            assert.strictEqual(tests.resource, 'ci-visibility/features-test-management/disabled.feature.Say disabled')

            if (isDisabling) {
              assert.strictEqual(tests.meta[TEST_STATUS], 'skip')
              assert.strictEqual(tests.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
            } else {
              assert.strictEqual(tests.meta[TEST_STATUS], 'fail')
              assert.ok(!('TEST_MANAGEMENT_IS_DISABLED' in tests.meta))
            }
          })

      const runTest = (done, isDisabling, extraEnvVars) => {
        const testAssertionsPromise = getTestAssertions(isDisabling)
        let stdout = ''

        childProcess = exec(
          './node_modules/.bin/cucumber-js ci-visibility/features-test-management/disabled.feature',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              ...extraEnvVars,
            },
          }
        )

        childProcess.stdout?.on('data', (data) => {
          stdout += data.toString()
        })

        childProcess.on('exit', exitCode => {
          testAssertionsPromise.then(() => {
            if (isDisabling) {
              assert.doesNotMatch(stdout, /I am running/)
              assert.strictEqual(exitCode, 0)
            } else {
              assert.match(stdout, /I am running/)
              assert.strictEqual(exitCode, 1)
            }
            done()
          }).catch(done)
        })
      }

      it('can disable tests', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runTest(done, true)
      })

      it('pass if disable is not enabled', (done) => {
        receiver.setSettings({ test_management: { enabled: false } })

        runTest(done, false)
      })

      it('does not enable disable tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
      })
    })

    context('quarantine', () => {
      beforeEach(() => {
        receiver.setTestManagementTests({
          cucumber: {
            suites: {
              'ci-visibility/features-test-management/quarantine.feature': {
                tests: {
                  'Say quarantine': {
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
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const failedTest = events.find(event => event.type === 'test').content
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isQuarantining) {
              assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
            } else {
              assert.ok(!('TEST_MANAGEMENT_ENABLED' in testSession.meta))
            }

            assert.strictEqual(
              failedTest.resource,
              'ci-visibility/features-test-management/quarantine.feature.Say quarantine'
            )

            assert.strictEqual(failedTest.meta[TEST_STATUS], 'fail')
            if (isQuarantining) {
              assert.strictEqual(failedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            } else {
              assert.ok(!('TEST_MANAGEMENT_IS_QUARANTINED' in failedTest.meta))
            }
          })

      const runTest = (done, isQuarantining, extraEnvVars) => {
        const testAssertionsPromise = getTestAssertions(isQuarantining)
        let stdout = ''
        childProcess = exec(
          './node_modules/.bin/cucumber-js ci-visibility/features-test-management/quarantine.feature',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              ...extraEnvVars,
            },
          }
        )

        childProcess.stdout?.on('data', (data) => {
          stdout += data.toString()
        })

        childProcess.on('exit', exitCode => {
          testAssertionsPromise.then(() => {
            // Regardless of whether the test is quarantined or not, it will be run
            assert.match(stdout, /I am running as quarantine/)
            if (isQuarantining) {
              // even though a test fails, the exit code is 1 because the test is quarantined
              assert.strictEqual(exitCode, 0)
            } else {
              assert.strictEqual(exitCode, 1)
            }
            done()
          }).catch(done)
        })
      }

      it('can quarantine tests', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runTest(done, true)
      })

      it('fails if quarantine is not enabled', (done) => {
        receiver.setSettings({ test_management: { enabled: false } })

        runTest(done, false)
      })

      it('does not enable quarantine tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
      })
    })

    it('does not crash if the request to get test management tests fails', async () => {
      let testOutput = ''
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
        })

      childProcess = exec(
        './node_modules/.bin/cucumber-js ci-visibility/features-test-management/attempt-to-fix.feature',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_TRACE_DEBUG: '1',
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
        once(childProcess, 'exit'),
        once(childProcess.stdout, 'end'),
        once(childProcess.stderr, 'end'),
        eventsPromise,
      ])
      assert.match(testOutput, /Test management tests could not be fetched/)
    })
  })

  context('libraries capabilities', () => {
    const runModes = ['serial']

    if (version !== '7.0.0') { // only on latest or 9 if node is old
      runModes.push('parallel')
    }

    runModes.forEach((runMode) => {
      it(`(${runMode}) adds capabilities to tests`, (done) => {
        const runCommand = runMode === 'parallel' ? parallelModeCommand : runTestsCommand

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            assert.ok(metadataDicts.length > 0)
            metadataDicts.forEach(metadata => {
              if (runMode === 'parallel') {
                assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], undefined)
              } else {
                assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], '1')
              }
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
          })

        childProcess = exec(
          runCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              DD_TEST_SESSION_NAME: 'my-test-session-name',
            },
          }
        )

        childProcess.on('exit', () => {
          receiverPromise.then(() => done()).catch(done)
        })
      })
    })
  })

  context('impacted tests', () => {
    const NUM_RETRIES = 3

    beforeEach(() => {
      // By default, the test is not new
      receiver.setKnownTests(
        {
          cucumber: {
            'ci-visibility/features-impacted-test/impacted-test.feature': ['Say impacted test'],
          },
        }
      )
    })

    // Modify `impacted-test.feature` to mark it as impacted
    before(() => {
      execSync('git checkout -b feature-branch', { cwd, stdio: 'ignore' })
      fs.writeFileSync(
        path.join(cwd, 'ci-visibility/features-impacted-test/impacted-test.feature'),
        `Feature: Impacted Test
        Scenario: Say impacted test
        When the greeter says impacted test
        Then I should have heard "impactedd test"`
      )
      execSync('git add ci-visibility/features-impacted-test/impacted-test.feature', { cwd, stdio: 'ignore' })
      execSync('git commit -m "modify impacted-test.feature"', { cwd, stdio: 'ignore' })
    })

    after(() => {
      // We can't use main here because in CI it might be "master".
      // We just use `-` which goes back to the previous branch
      execSync('git checkout -', { cwd, stdio: 'ignore' })
      execSync('git branch -D feature-branch', { cwd, stdio: 'ignore' })
    })

    const getTestAssertions = ({ isModified, isEfd, isNew, isParallel }) =>
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

          const resourceNames = tests.map(span => span.resource).sort()

          // TODO: This is a duplication of the code below. We should refactor this.
          assertObjectContains(resourceNames,
            [
              'ci-visibility/features-impacted-test/impacted-test.feature.Say impacted test',
            ]
          )

          if (isParallel) {
            assert.deepStrictEqual(resourceNames, [
              'ci-visibility/features-impacted-test/impacted-test-2.feature.Say impacted test 2',
              'ci-visibility/features-impacted-test/impacted-test.feature.Say impacted test',
            ])
          }

          const impactedTests = tests.filter(test =>
            test.meta[TEST_SOURCE_FILE] === 'ci-visibility/features-impacted-test/impacted-test.feature' &&
            test.meta[TEST_NAME] === 'Say impacted test'
          )

          if (isEfd) {
            assert.strictEqual(impactedTests.length, NUM_RETRIES + 1) // Retries + original test
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
            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, NUM_RETRIES)
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
            assert.strictEqual(retriedTestNew, isNew ? NUM_RETRIES : 0)
            assert.strictEqual(retriedTestsWithReason, NUM_RETRIES)
          }
        })

    /**
     * @param {{
     *   isModified?: boolean,
     *   isEfd?: boolean,
     *   isParallel?: boolean,
     *   isNew?: boolean
     * }} options
     * @param {Record<string, string>} [extraEnvVars]
     */
    const runImpactedTest = async (
      { isModified, isEfd, isParallel, isNew },
      extraEnvVars = {}
    ) => {
      const testAssertionsPromise = getTestAssertions({ isModified, isEfd, isParallel, isNew })

      childProcess = exec(
        isParallel
          ? './node_modules/.bin/cucumber-js ci-visibility/features-impacted-test/*.feature --parallel 2'
          : './node_modules/.bin/cucumber-js ci-visibility/features-impacted-test/impacted-test.feature',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            // we need to trick this process into not reading the event.json contents for GitHub,
            // otherwise we'll take the diff from the base repository, not from the test project in `cwd`
            GITHUB_BASE_REF: '',
            ...extraEnvVars,
          },
        }
      )

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

      onlyLatestIt('can detect impacted tests in parallel mode', async () => {
        receiver.setSettings({ impacted_tests_enabled: true })

        await runImpactedTest({ isModified: true, isParallel: true })
      })
    })

    context('test is new', () => {
      it('should be retried and marked both as new and modified', async () => {
        receiver.setKnownTests({
          cucumber: {},
        })

        receiver.setSettings({
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES,
            },
          },
          known_tests_enabled: true,
        })
        await runImpactedTest({ isModified: true, isEfd: true, isNew: true })
      })
    })
  })

  context('coverage report upload', () => {
    const gitCommitSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const gitRepositoryUrl = 'https://github.com/datadog/test-repo.git'

    it('uploads coverage report when coverage_report_upload_enabled is true', async () => {
      receiver.setSettings({
        coverage_report_upload_enabled: true,
      })

      const coverageReportPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/cicovreprt', (payloads) => {
          assert.strictEqual(payloads.length, 1)

          const coverageReport = payloads[0]

          assert.ok(coverageReport.headers['content-type'].includes('multipart/form-data'))

          assert.strictEqual(coverageReport.coverageFiles.length, 1)
          assert.strictEqual(coverageReport.coverageFiles[0].name, 'coverage1')
          assert.ok(coverageReport.coverageFiles[0].content.includes('SF:')) // LCOV format

          assert.strictEqual(coverageReport.eventFiles.length, 1)
          assert.strictEqual(coverageReport.eventFiles[0].name, 'event1')
          assert.strictEqual(coverageReport.eventFiles[0].content.type, 'coverage_report')
          assert.strictEqual(coverageReport.eventFiles[0].content.format, 'lcov')
          assert.strictEqual(coverageReport.eventFiles[0].content[GIT_COMMIT_SHA], gitCommitSha)
          assert.strictEqual(coverageReport.eventFiles[0].content[GIT_REPOSITORY_URL], gitRepositoryUrl)
        })

      const runTestsWithLcovCoverageCommand = `./node_modules/nyc/bin/nyc.js -r=lcov ${runTestsCommand}`

      childProcess = exec(
        runTestsWithLcovCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_GIT_COMMIT_SHA: gitCommitSha,
            DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
          },
        }
      )

      await Promise.all([
        coverageReportPromise,
        once(childProcess, 'exit'),
      ])
    })

    it('does not upload coverage report when coverage_report_upload_enabled is false', async () => {
      receiver.setSettings({
        coverage_report_upload_enabled: false,
      })

      let coverageReportUploaded = false
      receiver.assertPayloadReceived(() => {
        coverageReportUploaded = true
      }, ({ url }) => url === '/api/v2/cicovreprt')

      const runTestsWithLcovCoverageCommand = `./node_modules/nyc/bin/nyc.js -r=lcov -r=text-summary ${runTestsCommand}`

      childProcess = exec(
        runTestsWithLcovCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_GIT_COMMIT_SHA: gitCommitSha,
            DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
          },
        }
      )

      await once(childProcess, 'exit')

      assert.strictEqual(coverageReportUploaded, false, 'coverage report should not be uploaded')
    })

    it('batches multiple coverage reports in a single request', async () => {
      receiver.setSettings({
        coverage_report_upload_enabled: true,
      })

      const coverageReportPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/cicovreprt', (payloads) => {
          // Should receive exactly 1 request with both reports batched together
          assert.strictEqual(payloads.length, 1, 'Should receive exactly 1 batch with both reports')

          const batch = payloads[0]

          // Verify the single batch contains exactly 2 coverage reports (lcov and cobertura)
          assert.strictEqual(batch.coverageFiles.length, 2, 'Should have exactly 2 coverage files in the batch')
          assert.strictEqual(batch.eventFiles.length, 2, 'Should have exactly 2 event files in the batch')

          // Verify indexed field names (should start at 1)
          assert.strictEqual(batch.coverageFiles[0].name, 'coverage1')
          assert.strictEqual(batch.coverageFiles[1].name, 'coverage2')
          assert.strictEqual(batch.eventFiles[0].name, 'event1')
          assert.strictEqual(batch.eventFiles[1].name, 'event2')

          // Verify both formats are present
          const formats = batch.eventFiles.map(f => f.content.format)
          assert.ok(formats.includes('lcov'), 'Should include lcov format')
          assert.ok(formats.includes('cobertura'), 'Should include cobertura format')

          // Verify each report has correct metadata
          for (let i = 0; i < batch.coverageFiles.length; i++) {
            assert.strictEqual(batch.eventFiles[i].content.type, 'coverage_report')
            assert.ok(['lcov', 'cobertura'].includes(batch.eventFiles[i].content.format),
              `Coverage format should be lcov or cobertura, got: ${batch.eventFiles[i].content.format}`)
            assert.strictEqual(batch.eventFiles[i].content[GIT_COMMIT_SHA], gitCommitSha)
            assert.strictEqual(batch.eventFiles[i].content[GIT_REPOSITORY_URL], gitRepositoryUrl)
          }
        })

      const runTestsWithMultipleCoverageCommand =
        `./node_modules/nyc/bin/nyc.js -r=lcov -r=cobertura ${runTestsCommand}`

      childProcess = exec(
        runTestsWithMultipleCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_GIT_COMMIT_SHA: gitCommitSha,
            DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
          },
        }
      )

      await Promise.all([
        coverageReportPromise,
        once(childProcess, 'exit'),
      ])
    })
  })
})
