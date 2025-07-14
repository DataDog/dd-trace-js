'use strict'

const { exec, execSync } = require('child_process')

const { assert } = require('chai')
const fs = require('fs')
const path = require('path')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
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
  TEST_IS_MODIFIED,
  DD_CAPABILITIES_IMPACTED_TESTS
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')

const versions = ['7.0.0', 'latest']

const runTestsCommand = './node_modules/.bin/cucumber-js ci-visibility/features/*.feature'
const runTestsWithCoverageCommand = './node_modules/nyc/bin/nyc.js -r=text-summary ' +
  'node ./node_modules/.bin/cucumber-js ci-visibility/features/*.feature'
const parallelModeCommand = './node_modules/.bin/cucumber-js ci-visibility/features/*.feature --parallel 2'
const featuresPath = 'ci-visibility/features/'
const fileExtension = 'js'

versions.forEach(version => {
  // TODO: add esm tests
  describe(`cucumber@${version} commonJS`, () => {
    let sandbox, cwd, receiver, childProcess, testOutput

    before(async function () {
      // add an explicit timeout to make tests less flaky
      this.timeout(50000)

      sandbox = await createSandbox([`@cucumber/cucumber@${version}`, 'assert', 'nyc'], true)
      cwd = sandbox.folder
    })

    after(async function () {
      // add an explicit timeout to make tests less flaky
      this.timeout(50000)

      await sandbox.remove()
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
                    assert.equal(metadata[testLevel][TEST_SESSION_NAME], 'my-test-session')
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
                  assert.equal(testSessionEventContent.meta[CUCUMBER_IS_PARALLEL], 'true')
                }

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

                assert.includeMembers(testSuiteEvents.map(suite => suite.content.resource), [
                  `test_suite.${featuresPath}farewell.feature`,
                  `test_suite.${featuresPath}greetings.feature`
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
                  assert.isTrue(meta[TEST_SOURCE_FILE].startsWith(featuresPath))
                  assert.equal(metrics[TEST_SOURCE_START], 1)
                  assert.exists(metrics[DD_HOST_CPU_COUNT])
                })

                assert.includeMembers(testEvents.map(test => test.content.resource), [
                  `${featuresPath}farewell.feature.Say farewell`,
                  `${featuresPath}greetings.feature.Say greetings`,
                  `${featuresPath}greetings.feature.Say yeah`,
                  `${featuresPath}greetings.feature.Say yo`,
                  `${featuresPath}greetings.feature.Say skip`
                ])
                assert.includeMembers(testEvents.map(test => test.content.meta[TEST_STATUS]), [
                  'pass',
                  'pass',
                  'pass',
                  'fail',
                  'skip'
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
                  assert.equal(meta[TEST_SOURCE_FILE].startsWith('ci-visibility/features'), true)
                  assert.equal(meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'false')
                  // Can read DD_TAGS
                  assert.propertyVal(meta, 'test.customtag', 'customvalue')
                  assert.propertyVal(meta, 'test.customtag2', 'customvalue2')
                  if (runMode === 'parallel') {
                    assert.propertyVal(meta, CUCUMBER_IS_PARALLEL, 'true')
                  }
                  assert.exists(metrics[DD_HOST_CPU_COUNT])
                  if (!meta[TEST_NAME].includes('Say skip')) {
                    assert.propertyVal(meta, 'custom_tag.before', 'hello before')
                    assert.propertyVal(meta, 'custom_tag.after', 'hello after')
                  }
                })

                stepEvents.forEach(stepEvent => {
                  assert.equal(stepEvent.content.name, 'cucumber.step')
                  assert.property(stepEvent.content.meta, 'cucumber.step')
                  if (stepEvent.content.meta['cucumber.step'] === 'the greeter says greetings') {
                    assert.propertyVal(stepEvent.content.meta, 'custom_tag.when', 'hello when')
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
                  DD_SERVICE: undefined
                },
                stdio: 'pipe'
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
              eventsRequestPromise
            ]).then(([searchCommitRequest, packfileRequest, eventsRequest]) => {
              if (isAgentless) {
                assert.propertyVal(searchCommitRequest.headers, 'dd-api-key', '1')
                assert.propertyVal(packfileRequest.headers, 'dd-api-key', '1')
              } else {
                assert.notProperty(searchCommitRequest.headers, 'dd-api-key')
                assert.notProperty(packfileRequest.headers, 'dd-api-key')
              }

              const eventTypes = eventsRequest.payload.events.map(event => event.type)
              assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
              const numSuites = eventTypes.reduce(
                (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
              )
              assert.equal(numSuites, 2)

              done()
            }).catch(done)

            childProcess = exec(
              runTestsCommand,
              {
                cwd,
                env: envVars,
                stdio: 'pipe'
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
              eventsRequestPromise
            ]).then(([libraryConfigRequest, codeCovRequest, eventsRequest]) => {
              const [coveragePayload] = codeCovRequest.payload
              if (isAgentless) {
                assert.propertyVal(libraryConfigRequest.headers, 'dd-api-key', '1')
                assert.propertyVal(codeCovRequest.headers, 'dd-api-key', '1')
              } else {
                assert.notProperty(libraryConfigRequest.headers, 'dd-api-key')
                assert.notProperty(codeCovRequest.headers, 'dd-api-key', '1')
              }

              assert.propertyVal(coveragePayload, 'name', 'coverage1')
              assert.propertyVal(coveragePayload, 'filename', 'coverage1.msgpack')
              assert.propertyVal(coveragePayload, 'type', 'application/msgpack')
              assert.include(coveragePayload.content, {
                version: 2
              })
              const allCoverageFiles = codeCovRequest.payload
                .flatMap(coverage => coverage.content.coverages)
                .flatMap(file => file.files)
                .map(file => file.filename)

              assert.includeMembers(allCoverageFiles, [
                `${featuresPath}support/steps.${fileExtension}`,
                `${featuresPath}farewell.feature`,
                `${featuresPath}greetings.feature`
              ])
              // steps is twice because there are two suites using it
              assert.equal(
                allCoverageFiles.filter(file => file === `${featuresPath}support/steps.${fileExtension}`).length,
                2
              )
              assert.exists(coveragePayload.content.coverages[0].test_session_id)
              assert.exists(coveragePayload.content.coverages[0].test_suite_id)

              const testSession = eventsRequest
                .payload
                .events
                .find(event => event.type === 'test_session_end')
                .content
              assert.exists(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])

              const eventTypes = eventsRequest.payload.events.map(event => event.type)
              assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
              const numSuites = eventTypes.reduce(
                (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
              )
              assert.equal(numSuites, 2)
            }).catch(done)

            childProcess = exec(
              runTestsWithCoverageCommand,
              {
                cwd,
                env: envVars,
                stdio: 'pipe'
              }
            )
            childProcess.stdout.on('data', (chunk) => {
              testOutput += chunk.toString()
            })
            childProcess.stderr.on('data', (chunk) => {
              testOutput += chunk.toString()
            })
            childProcess.on('exit', () => {
              // check that reported coverage is still the same
              assert.include(testOutput, 'Lines        : 100%')
              done()
            })
          })

          it('does not report code coverage if disabled by the API', (done) => {
            receiver.setSettings({
              itr_enabled: false,
              code_coverage: false,
              tests_skipping: false
            })

            receiver.assertPayloadReceived(() => {
              const error = new Error('it should not report code coverage')
              done(error)
            }, ({ url }) => url.endsWith('/api/v2/citestcov')).catch(() => {})

            receiver.assertPayloadReceived(({ payload }) => {
              const eventTypes = payload.events.map(event => event.type)
              assert.includeMembers(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
              const testSession = payload.events.find(event => event.type === 'test_session_end').content
              assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'false')
              assert.propertyVal(testSession.meta, TEST_CODE_COVERAGE_ENABLED, 'false')
              assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_ENABLED, 'false')
              assert.exists(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])
              const testModule = payload.events.find(event => event.type === 'test_module_end').content
              assert.propertyVal(testModule.meta, TEST_ITR_TESTS_SKIPPED, 'false')
              assert.propertyVal(testModule.meta, TEST_CODE_COVERAGE_ENABLED, 'false')
              assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_ENABLED, 'false')
            }, ({ url }) => url.endsWith('/api/v2/citestcycle')).then(() => done()).catch(done)

            childProcess = exec(
              runTestsWithCoverageCommand,
              {
                cwd,
                env: envVars,
                stdio: 'inherit'
              }
            )
          })

          it('can skip suites received by the intelligent test runner API and still reports code coverage',
            (done) => {
              receiver.setSuitesToSkip([{
                type: 'suite',
                attributes: {
                  suite: `${featuresPath}farewell.feature`
                }
              }])

              const skippableRequestPromise = receiver
                .payloadReceived(({ url }) => url.endsWith('/api/v2/ci/tests/skippable'))
              const coverageRequestPromise = receiver.payloadReceived(({ url }) => url.endsWith('/api/v2/citestcov'))
              const eventsRequestPromise = receiver.payloadReceived(({ url }) => url.endsWith('/api/v2/citestcycle'))

              Promise.all([
                skippableRequestPromise,
                coverageRequestPromise,
                eventsRequestPromise
              ]).then(([skippableRequest, coverageRequest, eventsRequest]) => {
                const [coveragePayload] = coverageRequest.payload
                if (isAgentless) {
                  assert.propertyVal(skippableRequest.headers, 'dd-api-key', '1')
                  assert.propertyVal(coverageRequest.headers, 'dd-api-key', '1')
                  assert.propertyVal(eventsRequest.headers, 'dd-api-key', '1')
                } else {
                  assert.notProperty(skippableRequest.headers, 'dd-api-key', '1')
                  assert.notProperty(coverageRequest.headers, 'dd-api-key', '1')
                  assert.notProperty(eventsRequest.headers, 'dd-api-key', '1')
                }
                assert.propertyVal(coveragePayload, 'name', 'coverage1')
                assert.propertyVal(coveragePayload, 'filename', 'coverage1.msgpack')
                assert.propertyVal(coveragePayload, 'type', 'application/msgpack')

                const eventTypes = eventsRequest.payload.events.map(event => event.type)

                const skippedSuite = eventsRequest.payload.events.find(event =>
                  event.content.resource === `test_suite.${featuresPath}farewell.feature`
                ).content
                assert.propertyVal(skippedSuite.meta, TEST_STATUS, 'skip')
                assert.propertyVal(skippedSuite.meta, TEST_SKIPPED_BY_ITR, 'true')

                assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
                const numSuites = eventTypes.reduce(
                  (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
                )
                assert.equal(numSuites, 2)
                const testSession = eventsRequest
                  .payload.events.find(event => event.type === 'test_session_end').content
                assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'true')
                assert.propertyVal(testSession.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
                assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
                assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_TYPE, 'suite')
                assert.propertyVal(testSession.metrics, TEST_ITR_SKIPPING_COUNT, 1)

                const testModule = eventsRequest
                  .payload.events.find(event => event.type === 'test_module_end').content
                assert.propertyVal(testModule.meta, TEST_ITR_TESTS_SKIPPED, 'true')
                assert.propertyVal(testModule.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
                assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
                assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_TYPE, 'suite')
                assert.propertyVal(testModule.metrics, TEST_ITR_SKIPPING_COUNT, 1)
                done()
              }).catch(done)

              childProcess = exec(
                runTestsWithCoverageCommand,
                {
                  cwd,
                  env: envVars,
                  stdio: 'inherit'
                }
              )
            })

          it('does not skip tests if git metadata upload fails', (done) => {
            receiver.setSuitesToSkip([{
              type: 'suite',
              attributes: {
                suite: `${featuresPath}farewell.feature`
              }
            }])

            receiver.setGitUploadStatus(404)

            receiver.assertPayloadReceived(() => {
              const error = new Error('should not request skippable')
              done(error)
            }, ({ url }) => url.endsWith('/api/v2/ci/tests/skippable'))

            receiver.assertPayloadReceived(({ payload }) => {
              const eventTypes = payload.events.map(event => event.type)
              // because they are not skipped
              assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
              const numSuites = eventTypes.reduce(
                (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
              )
              assert.equal(numSuites, 2)
              const testSession = payload.events.find(event => event.type === 'test_session_end').content
              assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'false')
              assert.propertyVal(testSession.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
              assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
              const testModule = payload.events.find(event => event.type === 'test_module_end').content
              assert.propertyVal(testModule.meta, TEST_ITR_TESTS_SKIPPED, 'false')
              assert.propertyVal(testModule.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
              assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
            }, ({ url }) => url.endsWith('/api/v2/citestcycle')).then(() => done()).catch(done)

            childProcess = exec(
              runTestsWithCoverageCommand,
              {
                cwd,
                env: envVars,
                stdio: 'inherit'
              }
            )
          })

          it('does not skip tests if test skipping is disabled by the API', (done) => {
            receiver.setSettings({
              itr_enabled: true,
              code_coverage: true,
              tests_skipping: false
            })

            receiver.setSuitesToSkip([{
              type: 'suite',
              attributes: {
                suite: `${featuresPath}farewell.feature`
              }
            }])

            receiver.assertPayloadReceived(() => {
              const error = new Error('should not request skippable')
              done(error)
            }, ({ url }) => url.endsWith('/api/v2/ci/tests/skippable'))

            receiver.assertPayloadReceived(({ payload }) => {
              const eventTypes = payload.events.map(event => event.type)
              // because they are not skipped
              assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
              const numSuites = eventTypes.reduce(
                (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
              )
              assert.equal(numSuites, 2)
            }, ({ url }) => url.endsWith('/api/v2/citestcycle')).then(() => done()).catch(done)

            childProcess = exec(
              runTestsWithCoverageCommand,
              {
                cwd,
                env: getCiVisAgentlessConfig(receiver.port),
                stdio: 'inherit'
              }
            )
          })

          it('does not skip suites if suite is marked as unskippable', (done) => {
            receiver.setSettings({
              itr_enabled: true,
              code_coverage: true,
              tests_skipping: true
            })

            receiver.setSuitesToSkip([
              {
                type: 'suite',
                attributes: {
                  suite: `${featuresPath}farewell.feature`
                }
              },
              {
                type: 'suite',
                attributes: {
                  suite: `${featuresPath}greetings.feature`
                }
              }
            ])

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const suites = events.filter(event => event.type === 'test_suite_end')

                assert.equal(suites.length, 2)

                const testSession = events.find(event => event.type === 'test_session_end').content
                const testModule = events.find(event => event.type === 'test_session_end').content

                assert.propertyVal(testSession.meta, TEST_ITR_UNSKIPPABLE, 'true')
                assert.propertyVal(testSession.meta, TEST_ITR_FORCED_RUN, 'true')
                assert.propertyVal(testModule.meta, TEST_ITR_UNSKIPPABLE, 'true')
                assert.propertyVal(testModule.meta, TEST_ITR_FORCED_RUN, 'true')

                const skippedSuite = suites.find(
                  event => event.content.resource === 'test_suite.ci-visibility/features/farewell.feature'
                ).content
                const forcedToRunSuite = suites.find(
                  event => event.content.resource === 'test_suite.ci-visibility/features/greetings.feature'
                ).content

                assert.propertyVal(skippedSuite.meta, TEST_STATUS, 'skip')
                assert.notProperty(skippedSuite.meta, TEST_ITR_UNSKIPPABLE)
                assert.notProperty(skippedSuite.meta, TEST_ITR_FORCED_RUN)

                assert.propertyVal(forcedToRunSuite.meta, TEST_STATUS, 'fail')
                assert.propertyVal(forcedToRunSuite.meta, TEST_ITR_UNSKIPPABLE, 'true')
                assert.propertyVal(forcedToRunSuite.meta, TEST_ITR_FORCED_RUN, 'true')
              }, 25000)

            childProcess = exec(
              runTestsWithCoverageCommand,
              {
                cwd,
                env: envVars,
                stdio: 'inherit'
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
              tests_skipping: true
            })

            receiver.setSuitesToSkip([
              {
                type: 'suite',
                attributes: {
                  suite: `${featuresPath}farewell.feature`
                }
              }
            ])

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const suites = events.filter(event => event.type === 'test_suite_end')

                assert.equal(suites.length, 2)

                const testSession = events.find(event => event.type === 'test_session_end').content
                const testModule = events.find(event => event.type === 'test_session_end').content

                assert.propertyVal(testSession.meta, TEST_ITR_UNSKIPPABLE, 'true')
                assert.notProperty(testSession.meta, TEST_ITR_FORCED_RUN)
                assert.propertyVal(testModule.meta, TEST_ITR_UNSKIPPABLE, 'true')
                assert.notProperty(testModule.meta, TEST_ITR_FORCED_RUN)

                const skippedSuite = suites.find(
                  event => event.content.resource === 'test_suite.ci-visibility/features/farewell.feature'
                )
                const failedSuite = suites.find(
                  event => event.content.resource === 'test_suite.ci-visibility/features/greetings.feature'
                )

                assert.propertyVal(skippedSuite.content.meta, TEST_STATUS, 'skip')
                assert.notProperty(skippedSuite.content.meta, TEST_ITR_UNSKIPPABLE)
                assert.notProperty(skippedSuite.content.meta, TEST_ITR_FORCED_RUN)

                assert.propertyVal(failedSuite.content.meta, TEST_STATUS, 'fail')
                assert.propertyVal(failedSuite.content.meta, TEST_ITR_UNSKIPPABLE, 'true')
                assert.notProperty(failedSuite.content.meta, TEST_ITR_FORCED_RUN)
              }, 25000)

            childProcess = exec(
              runTestsWithCoverageCommand,
              {
                cwd,
                env: envVars,
                stdio: 'inherit'
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
                suite: `${featuresPath}not-existing.feature`
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

            childProcess = exec(
              runTestsWithCoverageCommand,
              {
                cwd,
                env: envVars,
                stdio: 'inherit'
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

                  assert.includeMembers(resourceNames,
                    [
                      `${featuresPath}farewell.feature.Say farewell`,
                      `${featuresPath}greetings.feature.Say greetings`,
                      `${featuresPath}greetings.feature.Say yeah`,
                      `${featuresPath}greetings.feature.Say yo`,
                      `${featuresPath}greetings.feature.Say skip`
                    ]
                  )
                }, ({ url }) => url === '/v0.4/traces').then(() => done()).catch(done)

                childProcess = exec(
                  runTestsWithCoverageCommand,
                  {
                    cwd,
                    env: getCiVisEvpProxyConfig(receiver.port),
                    stdio: 'inherit'
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
                  assert.equal(testSuite.itr_correlation_id, itrCorrelationId)
                })
              }, 25000)

            childProcess = exec(
              runTestsWithCoverageCommand,
              {
                cwd,
                env: envVars,
                stdio: 'inherit'
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
              tests_skipping: false
            })

            const codeCoveragesPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
                const coveredFiles = payloads
                  .flatMap(({ payload }) => payload)
                  .flatMap(({ content: { coverages } }) => coverages)
                  .flatMap(({ files }) => files)
                  .map(({ filename }) => filename)

                assert.includeMembers(coveredFiles, [
                  'ci-visibility/subproject/features/support/steps.js',
                  'ci-visibility/subproject/features/greetings.feature'
                ])
              })

            childProcess = exec(
              '../../node_modules/nyc/bin/nyc.js node ../../node_modules/.bin/cucumber-js features/*.feature',
              {
                cwd: `${cwd}/ci-visibility/subproject`,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port)
                },
                stdio: 'inherit'
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
                  '5s': NUM_RETRIES_EFD
                }
              },
              known_tests_enabled: true
            })
            // cucumber.ci-visibility/features/farewell.feature.Say whatever will be considered new
            receiver.setKnownTests(
              {
                cucumber: {
                  'ci-visibility/features/farewell.feature': ['Say farewell'],
                  'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip']
                }
              }
            )
            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)

                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')
                const tests = events.filter(event => event.type === 'test').map(event => event.content)

                const newTests = tests.filter(test =>
                  test.resource === 'ci-visibility/features/farewell.feature.Say whatever'
                )
                newTests.forEach(test => {
                  assert.propertyVal(test.meta, TEST_IS_NEW, 'true')
                })
                const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
                // all but one has been retried
                assert.equal(
                  newTests.length - 1,
                  retriedTests.length
                )
                assert.equal(retriedTests.length, NUM_RETRIES_EFD)
                retriedTests.forEach(test => {
                  assert.propertyVal(test.meta, TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.efd)
                })
                // Test name does not change
                newTests.forEach(test => {
                  assert.equal(test.meta[TEST_NAME], 'Say whatever')
                })
              })
            childProcess = exec(
              runTestsCommand,
              {
                cwd,
                env: envVars,
                stdio: 'pipe'
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
                  '5s': NUM_RETRIES_EFD
                }
              },
              known_tests_enabled: true
            })

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)

                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const newTests = tests.filter(test =>
                  test.meta[TEST_IS_NEW] === 'true'
                )
                // new tests are detected but not retried
                assert.equal(newTests.length, 1)
                const retriedTests = tests.filter(test =>
                  test.meta[TEST_IS_RETRY] === 'true'
                )
                assert.equal(retriedTests.length, 0)
              })
            // cucumber.ci-visibility/features/farewell.feature.Say whatever will be considered new
            receiver.setKnownTests({
              cucumber: {
                'ci-visibility/features/farewell.feature': ['Say farewell'],
                'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip']
              }
            })

            childProcess = exec(
              runTestsCommand,
              {
                cwd,
                env: { ...envVars, DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false' },
                stdio: 'pipe'
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
                  '5s': NUM_RETRIES_EFD
                }
              },
              known_tests_enabled: true
            })
            // Tests in "cucumber.ci-visibility/features-flaky/flaky.feature" will be considered new
            receiver.setKnownTests({})

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)

                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)

                tests.forEach(test => {
                  assert.propertyVal(test.meta, TEST_IS_NEW, 'true')
                })
                // All test suites pass, even though there are failed tests
                testSuites.forEach(testSuite => {
                  assert.propertyVal(testSuite.meta, TEST_STATUS, 'pass')
                })

                const failedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
                const passedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'pass')

                // (1 original run + 3 retries) / 2
                assert.equal(failedAttempts.length, 2)
                assert.equal(passedAttempts.length, 2)
              })

            childProcess = exec(
              './node_modules/.bin/cucumber-js ci-visibility/features-flaky/*.feature',
              {
                cwd,
                env: envVars,
                stdio: 'pipe'
              }
            )
            childProcess.on('exit', (exitCode) => {
              assert.equal(exitCode, 0)
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
                  '5s': NUM_RETRIES_EFD
                }
              },
              known_tests_enabled: true
            })
            // "cucumber.ci-visibility/features/farewell.feature.Say whatever" will be considered new
            // "cucumber.ci-visibility/features/greetings.feature.Say skip" will be considered new
            receiver.setKnownTests({
              cucumber: {
                'ci-visibility/features/farewell.feature': ['Say farewell'],
                'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo']
              }
            })

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)

                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')
                const tests = events.filter(event => event.type === 'test').map(event => event.content)

                const skippedNewTest = tests.filter(test =>
                  test.resource === 'ci-visibility/features/greetings.feature.Say skip'
                )
                // not retried
                assert.equal(skippedNewTest.length, 1)
              })

            childProcess = exec(
              runTestsCommand,
              {
                cwd,
                env: envVars,
                stdio: 'pipe'
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
                  '5s': NUM_RETRIES_EFD
                }
              },
              known_tests_enabled: true
            })
            receiver.setKnownTestsResponseCode(500)
            receiver.setKnownTests({})
            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)

                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)

                assert.equal(tests.length, 6)
                const newTests = tests.filter(test =>
                  test.meta[TEST_IS_NEW] === 'true'
                )
                assert.equal(newTests.length, 0)
              })

            childProcess = exec(
              runTestsCommand,
              { cwd, env: envVars, stdio: 'pipe' }
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
                  '5s': NUM_RETRIES_EFD
                },
                faulty_session_threshold: 0
              },
              known_tests_enabled: true
            })
            // tests in cucumber.ci-visibility/features/farewell.feature will be considered new
            receiver.setKnownTests(
              {
                cucumber: {
                  'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip']
                }
              }
            )
            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)

                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)
                assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ABORT_REASON, 'faulty')

                const tests = events.filter(event => event.type === 'test').map(event => event.content)

                const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
                assert.equal(newTests.length, 0)

                const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
                assert.equal(retriedTests.length, 0)
              })

            childProcess = exec(
              runTestsCommand,
              {
                cwd,
                env: envVars,
                stdio: 'pipe'
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
                  '5s': NUM_RETRIES_EFD
                }
              },
              known_tests_enabled: false
            })
            // cucumber.ci-visibility/features/farewell.feature.Say whatever will be considered new
            receiver.setKnownTests(
              {
                cucumber: {
                  'ci-visibility/features/farewell.feature': ['Say farewell'],
                  'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip']
                }
              }
            )
            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)

                const testSession = events.find(event => event.type === 'test_session_end').content
                assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)

                // no new tests detected
                const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
                assert.equal(newTests.length, 0)
                // no retries
                const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
                assert.equal(retriedTests.length, 0)
              })

            childProcess = exec(
              runTestsCommand,
              {
                cwd,
                env: envVars,
                stdio: 'pipe'
              }
            )

            childProcess.on('exit', () => {
              eventsPromise.then(() => {
                done()
              }).catch(done)
            })
          })

          if (version !== '7.0.0') { // EFD in parallel mode only supported from cucumber>=11
            context('parallel mode', () => {
              it('retries new tests', (done) => {
                const NUM_RETRIES_EFD = 3
                receiver.setSettings({
                  early_flake_detection: {
                    enabled: true,
                    slow_test_retries: {
                      '5s': NUM_RETRIES_EFD
                    }
                  },
                  known_tests_enabled: true
                })
                // cucumber.ci-visibility/features/farewell.feature.Say whatever will be considered new
                receiver.setKnownTests(
                  {
                    cucumber: {
                      'ci-visibility/features/farewell.feature': ['Say farewell'],
                      'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip']
                    }
                  }
                )
                const eventsPromise = receiver
                  .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                    const events = payloads.flatMap(({ payload }) => payload.events)

                    const testSession = events.find(event => event.type === 'test_session_end').content
                    assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')
                    assert.propertyVal(testSession.meta, CUCUMBER_IS_PARALLEL, 'true')

                    const tests = events.filter(event => event.type === 'test').map(event => event.content)

                    const newTests = tests.filter(test =>
                      test.resource === 'ci-visibility/features/farewell.feature.Say whatever'
                    )
                    newTests.forEach(test => {
                      assert.propertyVal(test.meta, TEST_IS_NEW, 'true')
                      // Test name does not change
                      assert.propertyVal(test.meta, TEST_NAME, 'Say whatever')
                      assert.propertyVal(test.meta, CUCUMBER_IS_PARALLEL, 'true')
                    })
                    const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
                    // all but one has been retried
                    assert.equal(
                      newTests.length - 1,
                      retriedTests.length
                    )
                    assert.equal(retriedTests.length, NUM_RETRIES_EFD)
                  })

                childProcess = exec(
                  parallelModeCommand,
                  {
                    cwd,
                    env: envVars,
                    stdio: 'pipe'
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
                      '5s': NUM_RETRIES_EFD
                    }
                  },
                  known_tests_enabled: true
                })
                // Tests in "cucumber.ci-visibility/features-flaky/flaky.feature" will be considered new
                receiver.setKnownTests({})

                const eventsPromise = receiver
                  .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                    const events = payloads.flatMap(({ payload }) => payload.events)

                    const testSession = events.find(event => event.type === 'test_session_end').content
                    assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')
                    assert.propertyVal(testSession.meta, CUCUMBER_IS_PARALLEL, 'true')
                    const tests = events.filter(event => event.type === 'test').map(event => event.content)
                    const testSuites = events
                      .filter(event => event.type === 'test_suite_end').map(event => event.content)

                    tests.forEach(test => {
                      assert.propertyVal(test.meta, TEST_IS_NEW, 'true')
                      assert.propertyVal(test.meta, CUCUMBER_IS_PARALLEL, 'true')
                    })

                    // All test suites pass, even though there are failed tests
                    testSuites.forEach(testSuite => {
                      assert.propertyVal(testSuite.meta, TEST_STATUS, 'pass')
                    })

                    const failedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
                    const passedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'pass')

                    // (1 original run + 3 retries) / 2
                    assert.equal(failedAttempts.length, 2)
                    assert.equal(passedAttempts.length, 2)
                  })

                childProcess = exec(
                  './node_modules/.bin/cucumber-js ci-visibility/features-flaky/*.feature --parallel 2',
                  {
                    cwd,
                    env: envVars,
                    stdio: 'pipe'
                  }
                )

                childProcess.on('exit', (exitCode) => {
                  assert.equal(exitCode, 0)
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
                      '5s': NUM_RETRIES_EFD
                    },
                    faulty_session_threshold: 0
                  },
                  known_tests_enabled: true
                })
                // tests in cucumber.ci-visibility/features/farewell.feature will be considered new
                receiver.setKnownTests(
                  {
                    cucumber: {
                      'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip']
                    }
                  }
                )

                const eventsPromise = receiver
                  .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                    const events = payloads.flatMap(({ payload }) => payload.events)

                    const testSession = events.find(event => event.type === 'test_session_end').content
                    assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)
                    assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ABORT_REASON, 'faulty')
                    assert.propertyVal(testSession.meta, CUCUMBER_IS_PARALLEL, 'true')

                    const tests = events.filter(event => event.type === 'test').map(event => event.content)

                    const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
                    assert.equal(newTests.length, 0)

                    const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
                    assert.equal(retriedTests.length, 0)
                  })

                childProcess = exec(
                  parallelModeCommand,
                  {
                    cwd,
                    env: envVars,
                    stdio: 'pipe'
                  }
                )

                childProcess.on('exit', () => {
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
                      '5s': NUM_RETRIES_EFD
                    }
                  },
                  known_tests_enabled: true
                })
                // "cucumber.ci-visibility/features/farewell.feature.Say whatever" will be considered new
                // "cucumber.ci-visibility/features/greetings.feature.Say skip" will be considered new
                receiver.setKnownTests({
                  cucumber: {
                    'ci-visibility/features/farewell.feature': ['Say farewell'],
                    'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo']
                  }
                })

                const eventsPromise = receiver
                  .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                    const events = payloads.flatMap(({ payload }) => payload.events)

                    const testSession = events.find(event => event.type === 'test_session_end').content
                    assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')
                    assert.propertyVal(testSession.meta, CUCUMBER_IS_PARALLEL, 'true')
                    const tests = events.filter(event => event.type === 'test').map(event => event.content)

                    const skippedNewTest = tests.filter(test =>
                      test.resource === 'ci-visibility/features/greetings.feature.Say skip'
                    )
                    // not retried
                    assert.equal(skippedNewTest.length, 1)
                  })

                childProcess = exec(
                  parallelModeCommand,
                  {
                    cwd,
                    env: envVars,
                    stdio: 'pipe'
                  }
                )
                childProcess.on('exit', () => {
                  eventsPromise.then(() => {
                    done()
                  }).catch(done)
                })
              })
            })
          }
        })

        if (version === 'latest') { // flaky test retries only supported from >=8.0.0
          context('flaky test retries', () => {
            it('can retry failed tests', (done) => {
              receiver.setSettings({
                itr_enabled: false,
                code_coverage: false,
                tests_skipping: false,
                flaky_test_retries_enabled: true,
                early_flake_detection: {
                  enabled: false
                }
              })

              const eventsPromise = receiver
                .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                  const events = payloads.flatMap(({ payload }) => payload.events)

                  const tests = events.filter(event => event.type === 'test').map(event => event.content)

                  // 2 failures and 1 passed attempt
                  assert.equal(tests.length, 3)

                  const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
                  assert.equal(failedTests.length, 2)
                  const passedTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
                  assert.equal(passedTests.length, 1)

                  // All but the first one are retries
                  const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
                  assert.equal(retriedTests.length, 2)
                  assert.equal(retriedTests.filter(
                    test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
                  ).length, 2)
                })

              childProcess = exec(
                './node_modules/.bin/cucumber-js ci-visibility/features-retry/*.feature',
                {
                  cwd,
                  env: envVars,
                  stdio: 'pipe'
                }
              )

              childProcess.on('exit', () => {
                eventsPromise.then(() => {
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

              const eventsPromise = receiver
                .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                  const events = payloads.flatMap(({ payload }) => payload.events)

                  const tests = events.filter(event => event.type === 'test').map(event => event.content)

                  assert.equal(tests.length, 1)

                  const retriedTests = tests.filter(
                    test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
                  )
                  assert.equal(retriedTests.length, 0)
                })

              childProcess = exec(
                './node_modules/.bin/cucumber-js ci-visibility/features-retry/*.feature',
                {
                  cwd,
                  env: {
                    ...envVars,
                    DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false'
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

              const eventsPromise = receiver
                .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                  const events = payloads.flatMap(({ payload }) => payload.events)

                  const tests = events.filter(event => event.type === 'test').map(event => event.content)

                  // 2 failures
                  assert.equal(tests.length, 2)

                  const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
                  assert.equal(failedTests.length, 2)
                  const passedTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
                  assert.equal(passedTests.length, 0)

                  // All but the first one are retries
                  const retriedTests = tests.filter(
                    test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
                  )
                  assert.equal(retriedTests.length, 1)
                })

              childProcess = exec(
                './node_modules/.bin/cucumber-js ci-visibility/features-retry/*.feature',
                {
                  cwd,
                  env: {
                    ...envVars,
                    DD_CIVISIBILITY_FLAKY_RETRY_COUNT: 1
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
          })
          // Dynamic instrumentation only supported from >=8.0.0
          context('dynamic instrumentation', () => {
            it('does not activate if DD_TEST_FAILED_TEST_REPLAY_ENABLED is set to false', (done) => {
              receiver.setSettings({
                flaky_test_retries_enabled: true,
                di_enabled: true
              })

              const eventsPromise = receiver
                .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                  const events = payloads.flatMap(({ payload }) => payload.events)

                  const tests = events.filter(event => event.type === 'test').map(event => event.content)
                  const retriedTests = tests.filter(
                    test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
                  )

                  assert.equal(retriedTests.length, 1)
                  const [retriedTest] = retriedTests

                  const hasDebugTags = Object.keys(retriedTest.meta)
                    .some(property =>
                      property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                    )

                  assert.isFalse(hasDebugTags)
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
                    DD_TEST_FAILED_TEST_REPLAY_ENABLED: 'false'
                  },
                  stdio: 'pipe'
                }
              )

              childProcess.on('exit', () => {
                Promise.all([eventsPromise, logsPromise]).then(() => {
                  done()
                }).catch(done)
              })
            })

            it('does not activate dynamic instrumentation if remote settings are disabled', (done) => {
              receiver.setSettings({
                flaky_test_retries_enabled: true,
                di_enabled: false
              })

              const eventsPromise = receiver
                .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                  const events = payloads.flatMap(({ payload }) => payload.events)

                  const tests = events.filter(event => event.type === 'test').map(event => event.content)
                  const retriedTests = tests.filter(
                    test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
                  )

                  assert.equal(retriedTests.length, 1)
                  const [retriedTest] = retriedTests
                  const hasDebugTags = Object.keys(retriedTest.meta)
                    .some(property =>
                      property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                    )

                  assert.isFalse(hasDebugTags)
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
                  stdio: 'pipe'
                }
              )

              childProcess.on('exit', () => {
                Promise.all([eventsPromise, logsPromise]).then(() => {
                  done()
                }).catch(done)
              })
            })

            it('runs retries with dynamic instrumentation', (done) => {
              receiver.setSettings({
                flaky_test_retries_enabled: true,
                di_enabled: true
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

                  assert.equal(retriedTests.length, 1)
                  const [retriedTest] = retriedTests

                  assert.propertyVal(retriedTest.meta, DI_ERROR_DEBUG_INFO_CAPTURED, 'true')

                  assert.isTrue(
                    retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
                      .endsWith('ci-visibility/features-di/support/sum.js')
                  )
                  assert.equal(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 6)

                  const snapshotIdKey = `${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX}`
                  assert.exists(retriedTest.meta[snapshotIdKey])

                  snapshotIdByTest = retriedTest.meta[snapshotIdKey]
                  spanIdByTest = retriedTest.span_id.toString()
                  traceIdByTest = retriedTest.trace_id.toString()
                })

              const logsPromise = receiver
                .gatherPayloadsMaxTimeout(({ url }) => url === logsEndpoint, (payloads) => {
                  const [{ logMessage: [diLog] }] = payloads
                  assert.deepInclude(diLog, {
                    ddsource: 'dd_debugger',
                    level: 'error'
                  })
                  assert.equal(diLog.debugger.snapshot.language, 'javascript')
                  assert.deepInclude(diLog.debugger.snapshot.captures.lines['6'].locals, {
                    a: {
                      type: 'number',
                      value: '11'
                    },
                    b: {
                      type: 'number',
                      value: '3'
                    },
                    localVariable: {
                      type: 'number',
                      value: '2'
                    }
                  })
                  spanIdByLog = diLog.dd.span_id
                  traceIdByLog = diLog.dd.trace_id
                  snapshotIdByLog = diLog.debugger.snapshot.id
                })

              childProcess = exec(
                './node_modules/.bin/cucumber-js ci-visibility/features-di/test-hit-breakpoint.feature --retry 1',
                {
                  cwd,
                  env: envVars,
                  stdio: 'pipe'
                }
              )

              childProcess.on('exit', () => {
                Promise.all([eventsPromise, logsPromise]).then(() => {
                  assert.equal(snapshotIdByTest, snapshotIdByLog)
                  assert.equal(spanIdByTest, spanIdByLog)
                  assert.equal(traceIdByTest, traceIdByLog)
                  done()
                }).catch(done)
              })
            })

            it('does not crash if the retry does not hit the breakpoint', (done) => {
              receiver.setSettings({
                flaky_test_retries_enabled: true,
                di_enabled: true
              })

              const eventsPromise = receiver
                .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                  const events = payloads.flatMap(({ payload }) => payload.events)

                  const tests = events.filter(event => event.type === 'test').map(event => event.content)
                  const retriedTests = tests.filter(
                    test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
                  )

                  assert.equal(retriedTests.length, 1)
                  const [retriedTest] = retriedTests

                  const hasDebugTags = Object.keys(retriedTest.meta)
                    .some(property =>
                      property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                    )

                  assert.isFalse(hasDebugTags)
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
                  stdio: 'pipe'
                }
              )

              childProcess.on('exit', (exitCode) => {
                Promise.all([eventsPromise, logsPromise]).then(() => {
                  assert.equal(exitCode, 0)
                  done()
                }).catch(done)
              })
            })
          })
        }
      })
    })

    it('correctly calculates test code owners when working directory is not repository root', (done) => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const test = events.find(event => event.type === 'test').content
          const testSuite = events.find(event => event.type === 'test_suite_end').content
          // The test is in a subproject
          assert.notEqual(test.meta[TEST_SOURCE_FILE], test.meta[TEST_SUITE])
          assert.equal(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
          assert.equal(testSuite.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
        })

      childProcess = exec(
        'node ../../node_modules/.bin/cucumber-js features/*.feature',
        {
          cwd: `${cwd}/ci-visibility/subproject`,
          env: {
            ...getCiVisAgentlessConfig(receiver.port)
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
                'ci-visibility/features-esm/**'
              ]
            )
          },
          stdio: 'inherit'
        }
      )

      childProcess.stdout.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      childProcess.on('exit', () => {
        linesPctMatch = testOutput.match(linesPctMatchRegex)
        linesPctFromNyc = linesPctMatch ? Number(linesPctMatch[1]) : null

        assert.equal(
          linesPctFromNyc,
          codeCoverageWithUntestedFiles,
          'nyc --all output does not match the reported coverage'
        )

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
                  'ci-visibility/features-esm/**'
                ]
              )
            },
            stdio: 'inherit'
          }
        )

        eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            codeCoverageWithoutUntestedFiles = testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT]
          })

        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })

        childProcess.on('exit', () => {
          linesPctMatch = testOutput.match(linesPctMatchRegex)
          linesPctFromNyc = linesPctMatch ? Number(linesPctMatch[1]) : null

          assert.equal(
            linesPctFromNyc,
            codeCoverageWithoutUntestedFiles,
            'nyc output does not match the reported coverage (no --all flag)'
          )

          eventsPromise.then(() => {
            assert.isAbove(codeCoverageWithoutUntestedFiles, codeCoverageWithUntestedFiles)
            done()
          }).catch(done)
        })
      })
    })

    context('known tests without early flake detection', () => {
      it('detects new tests without retrying them', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: false
          },
          known_tests_enabled: true
        })
        // cucumber.ci-visibility/features/farewell.feature.Say whatever will be considered new
        receiver.setKnownTests(
          {
            cucumber: {
              'ci-visibility/features/farewell.feature': ['Say farewell'],
              'ci-visibility/features/greetings.feature': ['Say greetings', 'Say yeah', 'Say yo', 'Say skip']
            }
          }
        )
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // new tests detected but not retried
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.equal(newTests.length, 1)
            const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
            stdio: 'pipe'
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
            assert.equal(test.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'true')
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_SERVICE: 'my-service'
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
          isQuarantined,
          isDisabled,
          shouldAlwaysPass,
          shouldFailSometimes
        }) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const testSession = events.find(event => event.type === 'test_session_end').content

              if (isAttemptToFix) {
                assert.propertyVal(testSession.meta, TEST_MANAGEMENT_ENABLED, 'true')
              } else {
                assert.notProperty(testSession.meta, TEST_MANAGEMENT_ENABLED)
              }

              const retriedTests = tests.filter(
                test => test.meta[TEST_NAME] === 'Say attempt to fix'
              )

              if (isAttemptToFix) {
                // 3 retries + 1 initial run
                assert.equal(retriedTests.length, 4)
              } else {
                assert.equal(retriedTests.length, 1)
              }

              for (let i = 0; i < retriedTests.length; i++) {
                const isFirstAttempt = i === 0
                const isLastAttempt = i === retriedTests.length - 1
                const test = retriedTests[i]

                assert.equal(
                  test.resource,
                  'ci-visibility/features-test-management/attempt-to-fix.feature.Say attempt to fix'
                )

                if (isDisabled) {
                  assert.propertyVal(test.meta, TEST_MANAGEMENT_IS_DISABLED, 'true')
                } else if (isQuarantined) {
                  assert.propertyVal(test.meta, TEST_MANAGEMENT_IS_QUARANTINED, 'true')
                } else {
                  assert.notProperty(test.meta, TEST_MANAGEMENT_IS_DISABLED)
                  assert.notProperty(test.meta, TEST_MANAGEMENT_IS_QUARANTINED)
                }

                if (isAttemptToFix) {
                  assert.propertyVal(test.meta, TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX, 'true')
                  if (!isFirstAttempt) {
                    assert.propertyVal(test.meta, TEST_IS_RETRY, 'true')
                    assert.propertyVal(test.meta, TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atf)
                  }
                  if (isLastAttempt) {
                    if (shouldFailSometimes) {
                      assert.propertyVal(test.meta, TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
                      assert.notProperty(test.meta, TEST_HAS_FAILED_ALL_RETRIES)
                    } else if (shouldAlwaysPass) {
                      assert.propertyVal(test.meta, TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'true')
                    } else {
                      assert.propertyVal(test.meta, TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
                      assert.propertyVal(test.meta, TEST_HAS_FAILED_ALL_RETRIES, 'true')
                    }
                  }
                } else {
                  assert.notProperty(test.meta, TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX)
                  assert.notProperty(test.meta, TEST_IS_RETRY)
                  assert.notProperty(test.meta, TEST_RETRY_REASON)
                }
              }
            })

        const runTest = (done, {
          isAttemptToFix,
          isQuarantined,
          isDisabled,
          extraEnvVars,
          shouldAlwaysPass,
          shouldFailSometimes
        } = {}) => {
          const testAssertions = getTestAssertions({
            isAttemptToFix,
            isQuarantined,
            isDisabled,
            shouldAlwaysPass,
            shouldFailSometimes
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
                ...(shouldFailSometimes ? { SHOULD_FAIL_SOMETIMES: '1' } : {})
              },
              stdio: 'inherit'
            }
          )

          childProcess.stdout.on('data', (data) => {
            stdout += data.toString()
          })

          childProcess.on('exit', exitCode => {
            testAssertions.then(() => {
              assert.include(stdout, 'I am running')
              if (isQuarantined || isDisabled || shouldAlwaysPass) {
                assert.equal(exitCode, 0)
              } else {
                assert.equal(exitCode, 1)
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
            extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' }
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
                        quarantined: true
                      }
                    }
                  }
                }
              }
            }
          })

          runTest(done, {
            isAttemptToFix: true,
            isQuarantined: true
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
                        disabled: true
                      }
                    }
                  }
                }
              }
            }
          })

          runTest(done, {
            isAttemptToFix: true,
            isDisabled: true
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
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.find(event => event.type === 'test').content
              const testSession = events.find(event => event.type === 'test_session_end').content

              if (isDisabling) {
                assert.propertyVal(testSession.meta, TEST_MANAGEMENT_ENABLED, 'true')
                assert.propertyVal(testSession.meta, TEST_STATUS, 'pass')
              } else {
                assert.notProperty(testSession.meta, TEST_MANAGEMENT_ENABLED)
                assert.propertyVal(testSession.meta, TEST_STATUS, 'fail')
              }

              assert.equal(tests.resource, 'ci-visibility/features-test-management/disabled.feature.Say disabled')

              if (isDisabling) {
                assert.equal(tests.meta[TEST_STATUS], 'skip')
                assert.propertyVal(tests.meta, TEST_MANAGEMENT_IS_DISABLED, 'true')
              } else {
                assert.equal(tests.meta[TEST_STATUS], 'fail')
                assert.notProperty(tests.meta, TEST_MANAGEMENT_IS_DISABLED)
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
                ...extraEnvVars
              },
              stdio: 'inherit'
            }
          )

          childProcess.stdout.on('data', (data) => {
            stdout += data.toString()
          })

          childProcess.on('exit', exitCode => {
            testAssertionsPromise.then(() => {
              if (isDisabling) {
                assert.notInclude(stdout, 'I am running')
                assert.equal(exitCode, 0)
              } else {
                assert.include(stdout, 'I am running')
                assert.equal(exitCode, 1)
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
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const failedTest = events.find(event => event.type === 'test').content
              const testSession = events.find(event => event.type === 'test_session_end').content

              if (isQuarantining) {
                assert.propertyVal(testSession.meta, TEST_MANAGEMENT_ENABLED, 'true')
              } else {
                assert.notProperty(testSession.meta, TEST_MANAGEMENT_ENABLED)
              }

              assert.equal(failedTest.resource,
                'ci-visibility/features-test-management/quarantine.feature.Say quarantine')

              assert.equal(failedTest.meta[TEST_STATUS], 'fail')
              if (isQuarantining) {
                assert.propertyVal(failedTest.meta, TEST_MANAGEMENT_IS_QUARANTINED, 'true')
              } else {
                assert.notProperty(failedTest.meta, TEST_MANAGEMENT_IS_QUARANTINED)
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
                ...extraEnvVars
              },
              stdio: 'inherit'
            }
          )

          childProcess.stdout.on('data', (data) => {
            stdout += data.toString()
          })

          childProcess.on('exit', exitCode => {
            testAssertionsPromise.then(() => {
              // Regardless of whether the test is quarantined or not, it will be run
              assert.include(stdout, 'I am running as quarantine')
              if (isQuarantining) {
                // even though a test fails, the exit code is 1 because the test is quarantined
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

              assert.isNotEmpty(metadataDicts)
              metadataDicts.forEach(metadata => {
                if (runMode === 'parallel') {
                  assert.equal(metadata.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], undefined)
                } else {
                  assert.equal(metadata.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], '1')
                }
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
            })

          childProcess = exec(
            runCommand,
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                DD_TEST_SESSION_NAME: 'my-test-session-name'
              },
              stdio: 'pipe'
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
              'ci-visibility/features-impacted-test/impacted-test.feature': ['Say impacted test']
            }
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
              assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')
            } else {
              assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)
            }

            const resourceNames = tests.map(span => span.resource)

            assert.includeMembers(resourceNames,
              [
                'ci-visibility/features-impacted-test/impacted-test.feature.Say impacted test'
              ]
            )

            if (isParallel) {
              assert.includeMembers(resourceNames, [
                'ci-visibility/features-impacted-test/impacted-test.feature.Say impacted test',
                'ci-visibility/features-impacted-test/impacted-test-2.feature.Say impacted test 2'
              ])
            }

            const impactedTests = tests.filter(test =>
              test.meta[TEST_SOURCE_FILE] === 'ci-visibility/features-impacted-test/impacted-test.feature' &&
              test.meta[TEST_NAME] === 'Say impacted test'
            )

            if (isEfd) {
              assert.equal(impactedTests.length, NUM_RETRIES + 1) // Retries + original test
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
              assert.equal(retriedTestNew, isNew ? NUM_RETRIES : 0)
              assert.equal(retriedTestsWithReason, NUM_RETRIES)
            }
          })

      const runImpactedTest = (
        done,
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
              ...extraEnvVars
            },
            stdio: 'inherit'
          }
        )

        childProcess.on('exit', (code) => {
          testAssertionsPromise.then(done).catch(done)
        })
      }

      context('test is not new', () => {
        it('should be detected as impacted', (done) => {
          receiver.setSettings({ impacted_tests_enabled: true })

          runImpactedTest(done, { isModified: true })
        })

        it('should not be detected as impacted if disabled', (done) => {
          receiver.setSettings({ impacted_tests_enabled: false })

          runImpactedTest(done, { isModified: false })
        })

        it('should not be detected as impacted if DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED is false',
          (done) => {
            receiver.setSettings({ impacted_tests_enabled: true })

            runImpactedTest(done,
              { isModified: false },
              { DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: '0' }
            )
          })

        if (version !== '7.0.0') {
          it('can detect impacted tests in parallel mode', (done) => {
            receiver.setSettings({ impacted_tests_enabled: true })

            runImpactedTest(done, { isModified: true, isParallel: true })
          })
        }
      })

      context('test is new', () => {
        it('should be retried and marked both as new and modified', (done) => {
          receiver.setKnownTests({})

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
          runImpactedTest(done, { isModified: true, isEfd: true, isNew: true })
        })
      })
    })
  })
})
