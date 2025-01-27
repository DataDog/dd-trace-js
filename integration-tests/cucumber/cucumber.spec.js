'use strict'

const { exec } = require('child_process')

const getPort = require('get-port')
const { assert } = require('chai')

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
  TEST_RETRY_REASON
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
      const port = await getPort()
      receiver = await new FakeCiVisIntake(port).start()
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
                  // Can read DD_TAGS
                  assert.propertyVal(meta, 'test.customtag', 'customvalue')
                  assert.propertyVal(meta, 'test.customtag2', 'customvalue2')
                  if (runMode === 'parallel') {
                    assert.propertyVal(meta, CUCUMBER_IS_PARALLEL, 'true')
                  }
                  assert.exists(metrics[DD_HOST_CPU_COUNT])
                })

                stepEvents.forEach(stepEvent => {
                  assert.equal(stepEvent.content.name, 'cucumber.step')
                  assert.property(stepEvent.content.meta, 'cucumber.step')
                })
              }, 5000)

            childProcess = exec(
              runCommand,
              {
                cwd,
                env: {
                  ...envVars,
                  DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2',
                  DD_TEST_SESSION_NAME: 'my-test-session'
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
                  assert.propertyVal(test.meta, TEST_RETRY_REASON, 'efd')
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

                  const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
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
                  const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
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
            it('does not activate if DD_TEST_DYNAMIC_INSTRUMENTATION_ENABLED is not set', (done) => {
              receiver.setSettings({
                flaky_test_retries_enabled: true,
                di_enabled: true
              })

              const eventsPromise = receiver
                .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                  const events = payloads.flatMap(({ payload }) => payload.events)

                  const tests = events.filter(event => event.type === 'test').map(event => event.content)
                  const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

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

            it('does not activate dynamic instrumentation if remote settings are disabled', (done) => {
              receiver.setSettings({
                flaky_test_retries_enabled: true,
                di_enabled: false
              })

              const eventsPromise = receiver
                .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                  const events = payloads.flatMap(({ payload }) => payload.events)

                  const tests = events.filter(event => event.type === 'test').map(event => event.content)
                  const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

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
                    DD_TEST_DYNAMIC_INSTRUMENTATION_ENABLED: 'true'
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

                  const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

                  assert.equal(retriedTests.length, 1)
                  const [retriedTest] = retriedTests

                  assert.propertyVal(retriedTest.meta, DI_ERROR_DEBUG_INFO_CAPTURED, 'true')

                  assert.isTrue(
                    retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
                      .endsWith('ci-visibility/features-di/support/sum.js')
                  )
                  assert.equal(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 4)

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
                  assert.deepInclude(diLog.debugger.snapshot.captures.lines['4'].locals, {
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
                  env: {
                    ...envVars,
                    DD_TEST_DYNAMIC_INSTRUMENTATION_ENABLED: 'true'
                  },
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
                  const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

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
                  env: {
                    ...envVars,
                    DD_TEST_DYNAMIC_INSTRUMENTATION_ENABLED: 'true'
                  },
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
  })
})
