'use strict'

const { exec } = require('child_process')

const getPort = require('get-port')
const semver = require('semver')
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
  TEST_CODE_COVERAGE_LINES_PCT
} = require('../../packages/dd-trace/src/plugins/util/test')

const isOldNode = semver.satisfies(process.version, '<=12')
const versions = ['7.0.0', isOldNode ? '8' : 'latest']

const runTestsCommand = './node_modules/.bin/cucumber-js ci-visibility/features/*.feature'
const runTestsWithCoverageCommand =
  './node_modules/nyc/bin/nyc.js -r=text-summary node ./node_modules/.bin/cucumber-js ci-visibility/features/*.feature'

versions.forEach(version => {
  describe(`cucumber@${version}`, () => {
    let sandbox, cwd, receiver, childProcess
    before(async () => {
      sandbox = await createSandbox([`@cucumber/cucumber@${version}`, 'assert', 'nyc'], true)
      cwd = sandbox.folder
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async function () {
      const port = await getPort()
      receiver = await new FakeCiVisIntake(port).start()
    })

    afterEach(async () => {
      childProcess.kill()
      await receiver.stop()
    })
    const reportMethods = ['agentless', 'evp proxy']

    it('does not crash with parallel mode', (done) => {
      let testOutput
      childProcess = exec(
        `./node_modules/.bin/cucumber-js ci-visibility/features/farewell.feature --parallel 2 --publish-quiet`,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_TRACE_DEBUG: 1,
            DD_TRACE_LOG_LEVEL: 'warn'
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
      childProcess.on('exit', (code) => {
        assert.notInclude(testOutput, 'TypeError')
        assert.include(testOutput, 'Unable to initialize CI Visibility because Cucumber is running in parallel mode.')
        assert.equal(code, 0)
        done()
      })
    })

    reportMethods.forEach((reportMethod) => {
      context(`reporting via ${reportMethod}`, () => {
        let envVars, isAgentless
        beforeEach(() => {
          isAgentless = reportMethod === 'agentless'
          envVars = isAgentless ? getCiVisAgentlessConfig(receiver.port) : getCiVisEvpProxyConfig(receiver.port)
        })
        it('can run and report tests', (done) => {
          receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')
            const testModuleEvent = events.find(event => event.type === 'test_module_end')
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            const stepEvents = events.filter(event => event.type === 'span')

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

            assert.includeMembers(testSuiteEvents.map(suite => suite.content.resource), [
              'test_suite.ci-visibility/features/farewell.feature',
              'test_suite.ci-visibility/features/greetings.feature'
            ])
            assert.includeMembers(testSuiteEvents.map(suite => suite.content.meta[TEST_STATUS]), [
              'pass',
              'fail'
            ])

            testSuiteEvents.forEach(({
              content: {
                meta,
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
            })

            assert.includeMembers(testEvents.map(test => test.content.resource), [
              'ci-visibility/features/farewell.feature.Say farewell',
              'ci-visibility/features/greetings.feature.Say greetings',
              'ci-visibility/features/greetings.feature.Say yeah',
              'ci-visibility/features/greetings.feature.Say yo',
              'ci-visibility/features/greetings.feature.Say skip'
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
            })

            stepEvents.forEach(stepEvent => {
              assert.equal(stepEvent.content.name, 'cucumber.step')
              assert.property(stepEvent.content.meta, 'cucumber.step')
            })
          }, 5000).then(() => done()).catch(done)

          childProcess = exec(
            runTestsCommand,
            {
              cwd,
              env: envVars,
              stdio: 'pipe'
            }
          )
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
            let testOutput
            const itrConfigRequestPromise = receiver.payloadReceived(
              ({ url }) => url.endsWith('/api/v2/libraries/tests/services/setting')
            )
            const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url.endsWith('/api/v2/citestcov'))
            const eventsRequestPromise = receiver.payloadReceived(({ url }) => url.endsWith('/api/v2/citestcycle'))

            Promise.all([
              itrConfigRequestPromise,
              codeCovRequestPromise,
              eventsRequestPromise
            ]).then(([itrConfigRequest, codeCovRequest, eventsRequest]) => {
              const [coveragePayload] = codeCovRequest.payload
              if (isAgentless) {
                assert.propertyVal(itrConfigRequest.headers, 'dd-api-key', '1')
                assert.propertyVal(itrConfigRequest.headers, 'dd-application-key', '1')
                assert.propertyVal(codeCovRequest.headers, 'dd-api-key', '1')
              } else {
                assert.notProperty(itrConfigRequest.headers, 'dd-api-key')
                assert.notProperty(itrConfigRequest.headers, 'dd-application-key')
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
                'ci-visibility/features/support/steps.js',
                'ci-visibility/features/farewell.feature',
                'ci-visibility/features/greetings.feature'
              ])
              // steps is twice because there are two suites using it
              assert.equal(
                allCoverageFiles.filter(file => file === 'ci-visibility/features/support/steps.js').length,
                2
              )
              assert.exists(coveragePayload.content.coverages[0].test_session_id)
              assert.exists(coveragePayload.content.coverages[0].test_suite_id)

              const testSession = eventsRequest.payload.events.find(event => event.type === 'test_session_end').content
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
              assert.include(testOutput, 'Lines        : 100% ( 18/18 )')
              done()
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

            receiver.assertPayloadReceived(({ payload }) => {
              const eventTypes = payload.events.map(event => event.type)
              assert.includeMembers(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
              const testSession = payload.events.find(event => event.type === 'test_session_end').content
              assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'false')
              assert.propertyVal(testSession.meta, TEST_CODE_COVERAGE_ENABLED, 'false')
              assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_ENABLED, 'false')
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
          it('can skip suites received by the intelligent test runner API and still reports code coverage', (done) => {
            receiver.setSuitesToSkip([{
              type: 'suite',
              attributes: {
                suite: 'ci-visibility/features/farewell.feature'
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
                assert.propertyVal(skippableRequest.headers, 'dd-application-key', '1')
                assert.propertyVal(coverageRequest.headers, 'dd-api-key', '1')
                assert.propertyVal(eventsRequest.headers, 'dd-api-key', '1')
              } else {
                assert.notProperty(skippableRequest.headers, 'dd-api-key', '1')
                assert.notProperty(skippableRequest.headers, 'dd-application-key', '1')
                assert.notProperty(coverageRequest.headers, 'dd-api-key', '1')
                assert.notProperty(eventsRequest.headers, 'dd-api-key', '1')
              }
              assert.propertyVal(coveragePayload, 'name', 'coverage1')
              assert.propertyVal(coveragePayload, 'filename', 'coverage1.msgpack')
              assert.propertyVal(coveragePayload, 'type', 'application/msgpack')

              const eventTypes = eventsRequest.payload.events.map(event => event.type)

              const skippedSuite = eventsRequest.payload.events.find(event =>
                event.content.resource === 'test_suite.ci-visibility/features/farewell.feature'
              ).content
              assert.propertyVal(skippedSuite.meta, TEST_STATUS, 'skip')
              assert.propertyVal(skippedSuite.meta, TEST_SKIPPED_BY_ITR, 'true')

              assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
              const numSuites = eventTypes.reduce(
                (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
              )
              assert.equal(numSuites, 2)
              const testSession = eventsRequest.payload.events.find(event => event.type === 'test_session_end').content
              assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'true')
              assert.propertyVal(testSession.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
              assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
              assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_TYPE, 'suite')
              assert.propertyVal(testSession.metrics, TEST_ITR_SKIPPING_COUNT, 1)

              const testModule = eventsRequest.payload.events.find(event => event.type === 'test_module_end').content
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
                suite: 'ci-visibility/features/farewell.feature'
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
              code_coverage: true,
              tests_skipping: false
            })

            receiver.setSuitesToSkip([{
              type: 'suite',
              attributes: {
                suite: 'ci-visibility/features/farewell.feature'
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
          it('sets _dd.ci.itr.tests_skipped to false if the received suite is not skipped', (done) => {
            receiver.setSuitesToSkip([{
              type: 'suite',
              attributes: {
                suite: 'ci-visibility/features/not-existing.feature'
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
                      'ci-visibility/features/farewell.feature.Say farewell',
                      'ci-visibility/features/greetings.feature.Say greetings',
                      'ci-visibility/features/greetings.feature.Say yeah',
                      'ci-visibility/features/greetings.feature.Say yo',
                      'ci-visibility/features/greetings.feature.Say skip'
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
        })
      })
    })
  })
})
