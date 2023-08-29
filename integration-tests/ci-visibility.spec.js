'use strict'

const { fork, exec } = require('child_process')
const path = require('path')

const { assert } = require('chai')
const semver = require('semver')
const getPort = require('get-port')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('./helpers')
const { FakeCiVisIntake } = require('./ci-visibility-intake')

const {
  TEST_CODE_COVERAGE_ENABLED,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_ITR_TESTS_SKIPPED,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_SUITE,
  TEST_STATUS,
  TEST_SKIPPED_BY_ITR,
  TEST_ITR_SKIPPING_TYPE,
  TEST_ITR_SKIPPING_COUNT
} = require('../packages/dd-trace/src/plugins/util/test')

const hookFile = 'dd-trace/loader-hook.mjs'

// TODO: remove when 2.x support is removed.
// This is done because newest versions of mocha and jest do not support node@12
const isOldNode = semver.satisfies(process.version, '<=12')

const mochaCommonOptions = {
  expectedStdout: '2 passing',
  extraStdout: 'end event: can add event listeners to mocha'
}

const jestCommonOptions = {
  dependencies: [isOldNode ? 'jest@28' : 'jest', 'chai', isOldNode ? 'jest-jasmine2@28' : 'jest-jasmine2'],
  expectedStdout: 'Test Suites: 2 passed',
  expectedCoverageFiles: [
    'ci-visibility/test/sum.js',
    'ci-visibility/test/ci-visibility-test.js',
    'ci-visibility/test/ci-visibility-test-2.js'
  ]
}

const testFrameworks = [
  {
    ...mochaCommonOptions,
    name: 'mocha',
    testFile: 'ci-visibility/run-mocha.js',
    dependencies: [isOldNode ? 'mocha@9' : 'mocha', 'chai', 'nyc'],
    expectedCoverageFiles: [
      'ci-visibility/run-mocha.js',
      'ci-visibility/test/sum.js',
      'ci-visibility/test/ci-visibility-test.js',
      'ci-visibility/test/ci-visibility-test-2.js'
    ],
    runTestsWithCoverageCommand: './node_modules/nyc/bin/nyc.js -r=text-summary node ./ci-visibility/run-mocha.js',
    coverageMessage: 'Lines        : 80%',
    type: 'commonJS'
  },
  {
    ...mochaCommonOptions,
    name: 'mocha',
    testFile: 'ci-visibility/run-mocha.mjs',
    dependencies: [isOldNode ? 'mocha@9' : 'mocha', 'chai', 'nyc', '@istanbuljs/esm-loader-hook'],
    expectedCoverageFiles: [
      'ci-visibility/run-mocha.mjs',
      'ci-visibility/test/sum.js',
      'ci-visibility/test/ci-visibility-test.js',
      'ci-visibility/test/ci-visibility-test-2.js'
    ],
    runTestsWithCoverageCommand:
      `./node_modules/nyc/bin/nyc.js -r=text-summary ` +
      `node --loader=./node_modules/@istanbuljs/esm-loader-hook/index.js ` +
      `--loader=${hookFile} ./ci-visibility/run-mocha.mjs`,
    coverageMessage: 'Lines        : 78.57%',
    type: 'esm'
  },
  {
    ...jestCommonOptions,
    name: 'jest',
    testFile: 'ci-visibility/run-jest.js',
    runTestsWithCoverageCommand: 'node ./ci-visibility/run-jest.js',
    type: 'commonJS'
  },
  {
    ...jestCommonOptions,
    name: 'jest',
    testFile: 'ci-visibility/run-jest.mjs',
    runTestsWithCoverageCommand: `node --loader=${hookFile} ./ci-visibility/run-jest.mjs`,
    type: 'esm'
  }
]

testFrameworks.forEach(({
  name,
  dependencies,
  testFile,
  expectedStdout,
  extraStdout,
  expectedCoverageFiles,
  runTestsWithCoverageCommand,
  coverageMessage,
  type
}) => {
  // to avoid this error: @istanbuljs/esm-loader-hook@0.2.0: The engine "node"
  // is incompatible with this module. Expected version ">=16.12.0". Got "14.21.3"
  if (type === 'esm' && name === 'mocha' && semver.satisfies(process.version, '<16.12.0')) {
    return
  }
  describe(`${name} ${type}`, () => {
    let receiver
    let childProcess
    let sandbox
    let cwd
    let startupTestFile
    let testOutput = ''

    before(async () => {
      sandbox = await createSandbox(dependencies, true)
      cwd = sandbox.folder
      startupTestFile = path.join(cwd, testFile)
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
      testOutput = ''
      await receiver.stop()
    })

    if (name === 'mocha') {
      it('does not change mocha config if CI Visibility fails to init', (done) => {
        receiver.assertPayloadReceived(() => {
          const error = new Error('it should not report tests')
          done(error)
        }, ({ url }) => url === '/api/v2/citestcycle', 3000).catch(() => {})

        const { DD_CIVISIBILITY_AGENTLESS_URL, ...restEnvVars } = getCiVisAgentlessConfig(receiver.port)

        // `runMocha` is only executed when using the CLI, which is where we modify mocha config
        // if CI Visibility is init
        childProcess = exec('mocha ./ci-visibility/test/ci-visibility-test.js', {
          cwd,
          env: {
            ...restEnvVars,
            DD_TRACE_DEBUG: 1,
            DD_TRACE_LOG_LEVEL: 'error',
            DD_SITE: '= invalid = url'
          },
          stdio: 'pipe'
        })
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('exit', () => {
          assert.include(testOutput, 'Invalid URL')
          assert.include(testOutput, '1 passing') // we only run one file here
          done()
        })
      })

      it('does not init CI Visibility when running in parallel mode', (done) => {
        receiver.assertPayloadReceived(() => {
          const error = new Error('it should not report tests')
          done(error)
        }, ({ url }) => url === '/api/v2/citestcycle', 3000).catch(() => {})

        childProcess = fork(testFile, {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            RUN_IN_PARALLEL: true,
            DD_TRACE_DEBUG: 1,
            DD_TRACE_LOG_LEVEL: 'warn'
          },
          stdio: 'pipe'
        })
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('message', () => {
          assert.include(testOutput, 'Unable to initialize CI Visibility because Mocha is running in parallel mode.')
          done()
        })
      })
    }

    if (name === 'jest') {
      it('works when sharding', (done) => {
        receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle').then(events => {
          const testSuiteEvents = events.payload.events.filter(event => event.type === 'test_suite_end')
          assert.equal(testSuiteEvents.length, 3)
          const testSuites = testSuiteEvents.map(span => span.content.meta[TEST_SUITE])

          assert.includeMembers(testSuites,
            [
              'ci-visibility/sharding-test/sharding-test-5.js',
              'ci-visibility/sharding-test/sharding-test-4.js',
              'ci-visibility/sharding-test/sharding-test-1.js'
            ]
          )

          const testSession = events.payload.events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'false')

          // We run the second shard
          receiver.setSuitesToSkip([
            {
              type: 'suite',
              attributes: {
                suite: 'ci-visibility/sharding-test/sharding-test-2.js'
              }
            },
            {
              type: 'suite',
              attributes: {
                suite: 'ci-visibility/sharding-test/sharding-test-3.js'
              }
            }
          ])
          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_REGEX: 'sharding-test/sharding-test',
                TEST_SHARD: '2/2'
              },
              stdio: 'inherit'
            }
          )

          receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle').then(secondShardEvents => {
            const testSuiteEvents = secondShardEvents.payload.events.filter(event => event.type === 'test_suite_end')

            // The suites for this shard are to be skipped
            assert.equal(testSuiteEvents.length, 2)

            testSuiteEvents.forEach(testSuite => {
              assert.propertyVal(testSuite.content.meta, TEST_STATUS, 'skip')
              assert.propertyVal(testSuite.content.meta, TEST_SKIPPED_BY_ITR, 'true')
            })

            const testSession = secondShardEvents
              .payload
              .events
              .find(event => event.type === 'test_session_end').content

            assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'true')
            assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_TYPE, 'suite')
            assert.propertyVal(testSession.metrics, TEST_ITR_SKIPPING_COUNT, 2)

            done()
          })
        })
        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_REGEX: 'sharding-test/sharding-test',
              TEST_SHARD: '1/2'
            },
            stdio: 'inherit'
          }
        )
      })
      it('does not crash when jest is badly initialized', (done) => {
        childProcess = fork('ci-visibility/run-jest-bad-init.js', {
          cwd,
          env: {
            DD_TRACE_AGENT_PORT: receiver.port
          },
          stdio: 'pipe'
        })
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('message', () => {
          assert.notInclude(testOutput, 'TypeError')
          assert.include(testOutput, expectedStdout)
          done()
        })
      })
      it('does not crash when jest uses jest-jasmine2', (done) => {
        childProcess = fork(testFile, {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            OLD_RUNNER: 1,
            NODE_OPTIONS: '-r dd-trace/ci/init',
            RUN_IN_PARALLEL: true
          },
          stdio: 'pipe'
        })
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('message', () => {
          assert.notInclude(testOutput, 'TypeError')
          done()
        })
      })
      describe('when jest is using workers to run tests in parallel', () => {
        it('reports tests when using the agent', (done) => {
          receiver.setInfoResponse({ endpoints: [] })
          childProcess = fork(testFile, {
            cwd,
            env: {
              DD_TRACE_AGENT_PORT: receiver.port,
              NODE_OPTIONS: '-r dd-trace/ci/init',
              RUN_IN_PARALLEL: true
            },
            stdio: 'pipe'
          })

          receiver.gatherPayloads(({ url }) => url === '/v0.4/traces', 5000).then(tracesRequests => {
            const testSpans = tracesRequests.flatMap(trace => trace.payload).flatMap(request => request)
            assert.equal(testSpans.length, 2)
            const spanTypes = testSpans.map(span => span.type)
            assert.includeMembers(spanTypes, ['test'])
            assert.notInclude(spanTypes, ['test_session_end', 'test_suite_end', 'test_module_end'])
            receiver.setInfoResponse({ endpoints: ['/evp_proxy/v2'] })
            done()
          }).catch(done)
        })
        it('reports tests when using agentless', (done) => {
          childProcess = fork(testFile, {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              RUN_IN_PARALLEL: true
            },
            stdio: 'pipe'
          })

          receiver.gatherPayloads(({ url }) => url === '/api/v2/citestcycle', 5000).then(eventsRequests => {
            const eventTypes = eventsRequests.map(({ payload }) => payload)
              .flatMap(({ events }) => events)
              .map(event => event.type)

            assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
            done()
          }).catch(done)
        })
        it('reports tests when using evp proxy', (done) => {
          childProcess = fork(testFile, {
            cwd,
            env: {
              ...getCiVisEvpProxyConfig(receiver.port),
              RUN_IN_PARALLEL: true
            },
            stdio: 'pipe'
          })

          receiver.gatherPayloads(({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle', 5000)
            .then(eventsRequests => {
              const eventTypes = eventsRequests.map(({ payload }) => payload)
                .flatMap(({ events }) => events)
                .map(event => event.type)

              assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
              done()
            }).catch(done)
        })
      })
      it('reports timeout error message', (done) => {
        childProcess = fork(testFile, {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '-r dd-trace/ci/init',
            RUN_IN_PARALLEL: true,
            TEST_REGEX: 'timeout-test/timeout-test.js'
          },
          stdio: 'pipe'
        })
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('message', () => {
          assert.include(testOutput, 'Exceeded timeout of 100 ms for a test')
          done()
        })
      })
    }

    it('can run tests and report spans', (done) => {
      receiver.setInfoResponse({ endpoints: [] })
      receiver.payloadReceived(({ url }) => url === '/v0.4/traces').then(({ payload }) => {
        const testSpans = payload.flatMap(trace => trace)
        const resourceNames = testSpans.map(span => span.resource)

        assert.includeMembers(resourceNames,
          [
            'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
            'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2'
          ]
        )

        const areAllTestSpans = testSpans.every(span => span.name === `${name}.test`)
        assert.isTrue(areAllTestSpans)

        assert.include(testOutput, expectedStdout)

        if (extraStdout) {
          assert.include(testOutput, extraStdout)
        }

        done()
      })

      childProcess = fork(startupTestFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: receiver.port,
          NODE_OPTIONS: type === 'esm' ? `-r dd-trace/ci/init --loader=${hookFile}` : '-r dd-trace/ci/init'
        },
        stdio: 'pipe'
      })
      childProcess.stdout.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
    })
    const envVarSettings = ['DD_TRACING_ENABLED', 'DD_TRACE_ENABLED']

    envVarSettings.forEach(envVar => {
      context(`when ${envVar}=false`, () => {
        it('does not report spans but still runs tests', (done) => {
          receiver.assertMessageReceived(() => {
            done(new Error('Should not create spans'))
          }).catch(() => {})

          childProcess = fork(startupTestFile, {
            cwd,
            env: {
              DD_TRACE_AGENT_PORT: receiver.port,
              NODE_OPTIONS: '-r dd-trace/ci/init',
              [envVar]: 'false'
            },
            stdio: 'pipe'
          })
          childProcess.stdout.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.stderr.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.on('message', () => {
            assert.include(testOutput, expectedStdout)
            done()
          })
        })
      })
    })
    context('when no ci visibility init is used', () => {
      it('does not crash', (done) => {
        childProcess = fork(startupTestFile, {
          cwd,
          env: {
            DD_TRACE_AGENT_PORT: receiver.port,
            NODE_OPTIONS: '-r dd-trace/init'
          },
          stdio: 'pipe'
        })
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('message', () => {
          assert.notInclude(testOutput, 'TypeError')
          assert.notInclude(testOutput, 'Uncaught error outside test suite')
          assert.include(testOutput, expectedStdout)
          done()
        })
      })
    })

    describe('agentless', () => {
      it('does not init if DD_API_KEY is not set', (done) => {
        receiver.assertMessageReceived(() => {
          done(new Error('Should not create spans'))
        }).catch(() => {})

        childProcess = fork(startupTestFile, {
          cwd,
          env: {
            DD_CIVISIBILITY_AGENTLESS_ENABLED: 1,
            NODE_OPTIONS: '-r dd-trace/ci/init'
          },
          stdio: 'pipe'
        })
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('message', () => {
          assert.include(testOutput, expectedStdout)
          assert.include(testOutput, 'DD_CIVISIBILITY_AGENTLESS_ENABLED is set, ' +
            'but neither DD_API_KEY nor DATADOG_API_KEY are set in your environment, ' +
            'so dd-trace will not be initialized.'
          )
          done()
        })
      })
      it('can report git metadata', (done) => {
        const searchCommitsRequestPromise = receiver.payloadReceived(
          ({ url }) => url === '/api/v2/git/repository/search_commits'
        )
        const packfileRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/git/repository/packfile')
        const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

        Promise.all([
          searchCommitsRequestPromise,
          packfileRequestPromise,
          eventsRequestPromise
        ]).then(([searchCommitRequest, packfileRequest, eventsRequest]) => {
          assert.propertyVal(searchCommitRequest.headers, 'dd-api-key', '1')
          assert.propertyVal(packfileRequest.headers, 'dd-api-key', '1')

          const eventTypes = eventsRequest.payload.events.map(event => event.type)
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)

          done()
        }).catch(done)

        childProcess = fork(startupTestFile, {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
          stdio: 'pipe'
        })
      })
      it('can report code coverage', (done) => {
        let testOutput
        const itrConfigRequestPromise = receiver.payloadReceived(
          ({ url }) => url === '/api/v2/libraries/tests/services/setting'
        )
        const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')
        const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

        Promise.all([
          itrConfigRequestPromise,
          codeCovRequestPromise,
          eventsRequestPromise
        ]).then(([itrConfigRequest, codeCovRequest, eventsRequest]) => {
          assert.propertyVal(itrConfigRequest.headers, 'dd-api-key', '1')
          assert.propertyVal(itrConfigRequest.headers, 'dd-application-key', '1')

          const [coveragePayload] = codeCovRequest.payload
          assert.propertyVal(codeCovRequest.headers, 'dd-api-key', '1')

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

          assert.includeMembers(allCoverageFiles, expectedCoverageFiles)
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
            env: getCiVisAgentlessConfig(receiver.port),
            stdio: 'pipe'
          }
        )
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('exit', () => {
          if (coverageMessage) {
            assert.include(testOutput, coverageMessage)
          }
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
        }, ({ url }) => url === '/api/v2/citestcov').catch(() => {})

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'dd-api-key', '1')
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
        }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
      it('can skip suites received by the intelligent test runner API and still reports code coverage', (done) => {
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])

        const skippableRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/ci/tests/skippable')
        const coverageRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')
        const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

        Promise.all([
          skippableRequestPromise,
          coverageRequestPromise,
          eventsRequestPromise
        ]).then(([skippableRequest, coverageRequest, eventsRequest]) => {
          assert.propertyVal(skippableRequest.headers, 'dd-api-key', '1')
          assert.propertyVal(skippableRequest.headers, 'dd-application-key', '1')
          const [coveragePayload] = coverageRequest.payload
          assert.propertyVal(coverageRequest.headers, 'dd-api-key', '1')
          assert.propertyVal(coveragePayload, 'name', 'coverage1')
          assert.propertyVal(coveragePayload, 'filename', 'coverage1.msgpack')
          assert.propertyVal(coveragePayload, 'type', 'application/msgpack')

          assert.propertyVal(eventsRequest.headers, 'dd-api-key', '1')
          const eventTypes = eventsRequest.payload.events.map(event => event.type)
          const skippedSuite = eventsRequest.payload.events.find(event =>
            event.content.resource === 'test_suite.ci-visibility/test/ci-visibility-test.js'
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
            env: getCiVisAgentlessConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
      it('does not skip tests if git metadata upload fails', (done) => {
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])

        receiver.setGitUploadStatus(404)

        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request skippable')
          done(error)
        }, ({ url }) => url === '/api/v2/ci/tests/skippable').catch(() => {})

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'dd-api-key', '1')
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
        }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
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
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])

        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request skippable')
          done(error)
        }, ({ url }) => url === '/api/v2/ci/tests/skippable').catch(() => {})

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'dd-api-key', '1')
          const eventTypes = payload.events.map(event => event.type)
          // because they are not skipped
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
        }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

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
            suite: 'ci-visibility/test/not-existing-test.js'
          }
        }])
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'false')
            assert.propertyVal(testSession.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
            assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
            const testModule = events.find(event => event.type === 'test_module_end').content
            assert.propertyVal(testModule.meta, TEST_ITR_TESTS_SKIPPED, 'false')
            assert.propertyVal(testModule.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
            assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
          }, 25000)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
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

    describe('evp proxy', () => {
      context('if the agent is not event platform proxy compatible', () => {
        it('does not do any intelligent test runner request', (done) => {
          receiver.setInfoResponse({ endpoints: [] })

          receiver.assertPayloadReceived(() => {
            const error = new Error('should not request search_commits')
            done(error)
          }, ({ url }) => url === '/evp_proxy/v2/api/v2/git/repository/search_commits').catch(() => {})
          receiver.assertPayloadReceived(() => {
            const error = new Error('should not request search_commits')
            done(error)
          }, ({ url }) => url === '/api/v2/git/repository/search_commits').catch(() => {})
          receiver.assertPayloadReceived(() => {
            const error = new Error('should not request setting')
            done(error)
          }, ({ url }) => url === '/api/v2/libraries/tests/services/setting').catch(() => {})
          receiver.assertPayloadReceived(() => {
            const error = new Error('should not request setting')
            done(error)
          }, ({ url }) => url === '/evp_proxy/v2/api/v2/libraries/tests/services/setting').catch(() => {})

          receiver.assertPayloadReceived(({ payload }) => {
            const testSpans = payload.flatMap(trace => trace)
            const resourceNames = testSpans.map(span => span.resource)

            assert.includeMembers(resourceNames,
              [
                'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
                'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2'
              ]
            )
          }, ({ url }) => url === '/v0.4/traces').then(() => done()).catch(done)

          childProcess = fork(startupTestFile, {
            cwd,
            env: getCiVisEvpProxyConfig(receiver.port),
            stdio: 'pipe'
          })
        })
      })
      it('can report git metadata', (done) => {
        const infoRequestPromise = receiver.payloadReceived(({ url }) => url === '/info')
        const searchCommitsRequestPromise = receiver.payloadReceived(
          ({ url }) => url === '/evp_proxy/v2/api/v2/git/repository/search_commits'
        )
        const packFileRequestPromise = receiver.payloadReceived(
          ({ url }) => url === '/evp_proxy/v2/api/v2/git/repository/packfile'
        )
        const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle')

        Promise.all([
          infoRequestPromise,
          searchCommitsRequestPromise,
          packFileRequestPromise,
          eventsRequestPromise
        ]).then(([infoRequest, searchCommitsRequest, packfileRequest, eventsRequest]) => {
          assert.notProperty(infoRequest.headers, 'dd-api-key')

          assert.notProperty(searchCommitsRequest.headers, 'dd-api-key')
          assert.propertyVal(searchCommitsRequest.headers, 'x-datadog-evp-subdomain', 'api')

          assert.notProperty(packfileRequest.headers, 'dd-api-key')
          assert.propertyVal(packfileRequest.headers, 'x-datadog-evp-subdomain', 'api')

          const eventTypes = eventsRequest.payload.events.map(event => event.type)
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
          done()
        }).catch(done)

        childProcess = fork(startupTestFile, {
          cwd,
          env: getCiVisEvpProxyConfig(receiver.port),
          stdio: 'pipe'
        })
      })
      it('can report code coverage', (done) => {
        let testOutput
        const itrConfigRequestPromise = receiver.payloadReceived(
          ({ url }) => url === '/evp_proxy/v2/api/v2/libraries/tests/services/setting'
        )
        const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url === '/evp_proxy/v2/api/v2/citestcov')
        const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle')

        Promise.all([
          itrConfigRequestPromise,
          codeCovRequestPromise,
          eventsRequestPromise
        ]).then(([itrConfigRequest, codeCovRequest, eventsRequest]) => {
          assert.notProperty(itrConfigRequest.headers, 'dd-api-key')
          assert.notProperty(itrConfigRequest.headers, 'dd-application-key')
          assert.propertyVal(itrConfigRequest.headers, 'x-datadog-evp-subdomain', 'api')

          const [coveragePayload] = codeCovRequest.payload
          assert.notProperty(codeCovRequest.headers, 'dd-api-key')
          assert.notProperty(codeCovRequest.headers, 'dd-application-key')

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

          assert.includeMembers(allCoverageFiles, expectedCoverageFiles)
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
            env: getCiVisEvpProxyConfig(receiver.port),
            stdio: 'pipe'
          }
        )
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('exit', () => {
          // check that reported coverage is still the same
          if (coverageMessage) {
            assert.include(testOutput, coverageMessage)
          }
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
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/citestcov').catch(() => {})

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.notProperty(headers, 'dd-api-key')
          assert.propertyVal(headers, 'x-datadog-evp-subdomain', 'citestcycle-intake')
          const eventTypes = payload.events.map(event => event.type)
          assert.includeMembers(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle').then(() => done()).catch(done)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisEvpProxyConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
      it('can skip suites received by the intelligent test runner API and still reports code coverage', (done) => {
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])

        const skippableRequestPromise = receiver.payloadReceived(
          ({ url }) => url === '/evp_proxy/v2/api/v2/ci/tests/skippable'
        )
        const coverageRequestPromise = receiver.payloadReceived(({ url }) => url === '/evp_proxy/v2/api/v2/citestcov')
        const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle')

        Promise.all([
          skippableRequestPromise,
          coverageRequestPromise,
          eventsRequestPromise
        ]).then(([skippableRequest, coverageRequest, eventsRequest]) => {
          assert.notProperty(skippableRequest.headers, 'dd-api-key')
          assert.notProperty(skippableRequest.headers, 'dd-application-key')
          assert.propertyVal(skippableRequest.headers, 'x-datadog-evp-subdomain', 'api')

          const [coveragePayload] = coverageRequest.payload
          assert.notProperty(coverageRequest.headers, 'dd-api-key')
          assert.propertyVal(coverageRequest.headers, 'x-datadog-evp-subdomain', 'citestcov-intake')
          assert.propertyVal(coveragePayload, 'name', 'coverage1')
          assert.propertyVal(coveragePayload, 'filename', 'coverage1.msgpack')
          assert.propertyVal(coveragePayload, 'type', 'application/msgpack')

          assert.notProperty(eventsRequest.headers, 'dd-api-key')
          assert.propertyVal(eventsRequest.headers, 'x-datadog-evp-subdomain', 'citestcycle-intake')
          const eventTypes = eventsRequest.payload.events.map(event => event.type)
          const skippedSuite = eventsRequest.payload.events.find(event =>
            event.content.resource === 'test_suite.ci-visibility/test/ci-visibility-test.js'
          ).content
          assert.propertyVal(skippedSuite.meta, TEST_STATUS, 'skip')
          assert.propertyVal(skippedSuite.meta, TEST_SKIPPED_BY_ITR, 'true')

          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
          done()
        }).catch(done)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisEvpProxyConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
      it('does not skip tests if git metadata upload fails', (done) => {
        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request skippable')
          done(error)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/ci/tests/skippable').catch(() => {})

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.notProperty(headers, 'dd-api-key')
          assert.propertyVal(headers, 'x-datadog-evp-subdomain', 'citestcycle-intake')
          const eventTypes = payload.events.map(event => event.type)
          // because they are not skipped
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle').then(() => done()).catch(done)

        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])

        receiver.setGitUploadStatus(404)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisEvpProxyConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
      it('does not skip tests if test skipping is disabled by the API', (done) => {
        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request skippable')
          done(error)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/ci/tests/skippable').catch(() => {})

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.notProperty(headers, 'dd-api-key')
          assert.propertyVal(headers, 'x-datadog-evp-subdomain', 'citestcycle-intake')
          const eventTypes = payload.events.map(event => event.type)
          // because they are not skipped
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle').then(() => done()).catch(done)

        receiver.setSettings({
          code_coverage: true,
          tests_skipping: false
        })

        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisEvpProxyConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
      it('sets _dd.ci.itr.tests_skipped to false if the received suite is not skipped', (done) => {
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/not-existing-test.js'
          }
        }])
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'false')
            assert.propertyVal(testSession.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
            assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
            const testModule = events.find(event => event.type === 'test_module_end').content
            assert.propertyVal(testModule.meta, TEST_ITR_TESTS_SKIPPED, 'false')
            assert.propertyVal(testModule.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
            assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
          }, 25000)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisEvpProxyConfig(receiver.port),
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
  })
})
