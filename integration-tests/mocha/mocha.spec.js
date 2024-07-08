'use strict'

const { fork, exec } = require('child_process')
const path = require('path')

const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_CODE_COVERAGE_ENABLED,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_ITR_TESTS_SKIPPED,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_SUITE,
  TEST_STATUS,
  TEST_SKIPPED_BY_ITR,
  TEST_ITR_SKIPPING_TYPE,
  TEST_ITR_SKIPPING_COUNT,
  TEST_ITR_UNSKIPPABLE,
  TEST_ITR_FORCED_RUN,
  TEST_SOURCE_FILE,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_NAME,
  TEST_COMMAND,
  TEST_MODULE,
  MOCHA_IS_PARALLEL,
  TEST_SOURCE_START
} = require('../../packages/dd-trace/src/plugins/util/test')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')

const runTestsWithCoverageCommand = './node_modules/nyc/bin/nyc.js -r=text-summary node ./ci-visibility/run-mocha.js'
const testFile = 'ci-visibility/run-mocha.js'
const expectedStdout = '2 passing'
const extraStdout = 'end event: can add event listeners to mocha'

describe('mocha CommonJS', function () {
  let receiver
  let childProcess
  let sandbox
  let cwd
  let startupTestFile
  let testOutput = ''

  before(async function () {
    sandbox = await createSandbox(['mocha', 'chai@v4', 'nyc', 'mocha-each', 'workerpool'], true)
    cwd = sandbox.folder
    startupTestFile = path.join(cwd, testFile)
  })

  after(async function () {
    await sandbox.remove()
  })

  beforeEach(async function () {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess.kill()
    testOutput = ''
    await receiver.stop()
  })

  it('can run tests and report tests with the APM protocol (old agents)', (done) => {
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

      const areAllTestSpans = testSpans.every(span => span.name === 'mocha.test')
      assert.isTrue(areAllTestSpans)

      assert.include(testOutput, expectedStdout)

      if (extraStdout) {
        assert.include(testOutput, extraStdout)
      }
      // Can read DD_TAGS
      testSpans.forEach(testSpan => {
        assert.propertyVal(testSpan.meta, 'test.customtag', 'customvalue')
        assert.propertyVal(testSpan.meta, 'test.customtag2', 'customvalue2')
      })

      testSpans.forEach(testSpan => {
        assert.equal(testSpan.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/test/ci-visibility-test'), true)
        assert.exists(testSpan.metrics[TEST_SOURCE_START])
      })

      done()
    })

    childProcess = fork(startupTestFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: receiver.port,
        NODE_OPTIONS: '-r dd-trace/ci/init',
        DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2'
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

  const nonLegacyReportingOptions = ['agentless', 'evp proxy']

  nonLegacyReportingOptions.forEach((reportingOption) => {
    it(`can run and report tests with ${reportingOption}`, (done) => {
      const envVars = reportingOption === 'agentless'
        ? getCiVisAgentlessConfig(receiver.port)
        : getCiVisEvpProxyConfig(receiver.port)
      if (reportingOption === 'evp proxy') {
        receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      }
      receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const sessionEventContent = events.find(event => event.type === 'test_session_end').content
        const moduleEventContent = events.find(event => event.type === 'test_module_end').content
        const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        const resourceNames = tests.map(span => span.resource)

        assert.includeMembers(resourceNames,
          [
            'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
            'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2'
          ]
        )
        assert.equal(suites.length, 2)
        assert.exists(sessionEventContent)
        assert.exists(moduleEventContent)

        assert.include(testOutput, expectedStdout)
        assert.include(testOutput, extraStdout)

        // Can read DD_TAGS
        tests.forEach(testEvent => {
          assert.propertyVal(testEvent.meta, 'test.customtag', 'customvalue')
          assert.propertyVal(testEvent.meta, 'test.customtag2', 'customvalue2')
        })

        tests.forEach(testEvent => {
          assert.equal(testEvent.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/test/ci-visibility-test'), true)
          assert.exists(testEvent.metrics[TEST_SOURCE_START])
        })

        done()
      })

      childProcess = fork(startupTestFile, {
        cwd,
        env: {
          ...envVars,
          DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2'
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

  it('works with parallel mode', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const sessionEventContent = events.find(event => event.type === 'test_session_end').content
        const moduleEventContent = events.find(event => event.type === 'test_module_end').content
        const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        assert.equal(sessionEventContent.meta[MOCHA_IS_PARALLEL], 'true')
        assert.equal(
          sessionEventContent.test_session_id.toString(10),
          moduleEventContent.test_session_id.toString(10)
        )
        suites.forEach(({
          meta,
          test_suite_id: testSuiteId,
          test_module_id: testModuleId,
          test_session_id: testSessionId
        }) => {
          assert.exists(meta[TEST_COMMAND])
          assert.exists(meta[TEST_MODULE])
          assert.exists(testSuiteId)
          assert.equal(testModuleId.toString(10), moduleEventContent.test_module_id.toString(10))
          assert.equal(testSessionId.toString(10), moduleEventContent.test_session_id.toString(10))
        })

        tests.forEach(({
          meta,
          metrics,
          test_suite_id: testSuiteId,
          test_module_id: testModuleId,
          test_session_id: testSessionId
        }) => {
          assert.exists(meta[TEST_COMMAND])
          assert.exists(meta[TEST_MODULE])
          assert.exists(testSuiteId)
          assert.equal(testModuleId.toString(10), moduleEventContent.test_module_id.toString(10))
          assert.equal(testSessionId.toString(10), moduleEventContent.test_session_id.toString(10))
          assert.propertyVal(meta, MOCHA_IS_PARALLEL, 'true')
          assert.exists(metrics[TEST_SOURCE_START])
        })
      })

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
      eventsPromise.then(() => {
        assert.notInclude(testOutput, 'TypeError')
        assert.notInclude(
          testOutput, 'Unable to initialize CI Visibility because Mocha is running in parallel mode.'
        )
        done()
      }).catch(done)
    })
  })

  it('works with parallel mode when run with the cli', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const sessionEventContent = events.find(event => event.type === 'test_session_end').content
        const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        assert.equal(sessionEventContent.meta[MOCHA_IS_PARALLEL], 'true')
        assert.equal(suites.length, 2)
        assert.equal(tests.length, 2)
      })

    childProcess = exec('mocha --parallel --jobs 2 ./ci-visibility/test/ci-visibility-test*', {
      cwd,
      env: getCiVisAgentlessConfig(receiver.port),
      stdio: 'pipe'
    })
    childProcess.stdout.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        assert.notInclude(testOutput, 'TypeError')
        assert.notInclude(
          testOutput, 'Unable to initialize CI Visibility because Mocha is running in parallel mode.'
        )
        done()
      }).catch(done)
    })
  })

  it('does not blow up when workerpool is used outside of a test', (done) => {
    childProcess = exec('node ./ci-visibility/run-workerpool.js', {
      cwd,
      env: getCiVisAgentlessConfig(receiver.port),
      stdio: 'pipe'
    })
    childProcess.stdout.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.on('exit', (code) => {
      assert.include(testOutput, 'result 7')
      assert.equal(code, 0)
      done()
    })
  })

  it('reports errors in test sessions', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testSession = events.find(event => event.type === 'test_session_end').content
        assert.propertyVal(testSession.meta, TEST_STATUS, 'fail')
        const errorMessage = 'Failed tests: 1'
        assert.include(testSession.meta[ERROR_MESSAGE], errorMessage)
      })

    childProcess = exec(
      runTestsWithCoverageCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: JSON.stringify([
            './test/fail-test.js'
          ])
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

  context('intelligent test runner', () => {
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
    it('can report code coverage', (done) => {
      let testOutput
      const libraryConfigRequestPromise = receiver.payloadReceived(
        ({ url }) => url === '/api/v2/libraries/tests/services/setting'
      )
      const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')
      const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

      Promise.all([
        libraryConfigRequestPromise,
        codeCovRequestPromise,
        eventsRequestPromise
      ]).then(([libraryConfigRequest, codeCovRequest, eventsRequest]) => {
        assert.propertyVal(libraryConfigRequest.headers, 'dd-api-key', '1')

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

        assert.includeMembers(allCoverageFiles,
          [
            'ci-visibility/test/sum.js',
            'ci-visibility/test/ci-visibility-test.js',
            'ci-visibility/test/ci-visibility-test-2.js'
          ]
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
          env: getCiVisAgentlessConfig(receiver.port),
          stdio: 'pipe'
        }
      )
      childProcess.stdout.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.on('exit', () => {
        // coverage report
        assert.include(testOutput, 'Lines        ')
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
      }, ({ url }) => url === '/api/v2/citestcov').catch(() => {})

      receiver.assertPayloadReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'dd-api-key', '1')
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

    it('marks the test session as skipped if every suite is skipped', (done) => {
      receiver.setSuitesToSkip(
        [
          {
            type: 'suite',
            attributes: {
              suite: 'ci-visibility/test/ci-visibility-test.js'
            }
          },
          {
            type: 'suite',
            attributes: {
              suite: 'ci-visibility/test/ci-visibility-test-2.js'
            }
          }
        ]
      )

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_STATUS, 'skip')
        })
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
        itr_enabled: true,
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

    it('does not skip suites if suite is marked as unskippable', (done) => {
      receiver.setSuitesToSkip([
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/unskippable-test/test-to-skip.js'
          }
        },
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/unskippable-test/test-unskippable.js'
          }
        }
      ])

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const suites = events.filter(event => event.type === 'test_suite_end')

          assert.equal(suites.length, 3)

          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content
          assert.propertyVal(testSession.meta, TEST_ITR_FORCED_RUN, 'true')
          assert.propertyVal(testSession.meta, TEST_ITR_UNSKIPPABLE, 'true')
          assert.propertyVal(testModule.meta, TEST_ITR_FORCED_RUN, 'true')
          assert.propertyVal(testModule.meta, TEST_ITR_UNSKIPPABLE, 'true')

          const passedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-to-run.js'
          )
          const skippedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-to-skip.js'
          )
          const forcedToRunSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-unskippable.js'
          )
          // It does not mark as unskippable if there is no docblock
          assert.propertyVal(passedSuite.content.meta, TEST_STATUS, 'pass')
          assert.notProperty(passedSuite.content.meta, TEST_ITR_UNSKIPPABLE)
          assert.notProperty(passedSuite.content.meta, TEST_ITR_FORCED_RUN)

          assert.propertyVal(skippedSuite.content.meta, TEST_STATUS, 'skip')
          assert.notProperty(skippedSuite.content.meta, TEST_ITR_UNSKIPPABLE)
          assert.notProperty(skippedSuite.content.meta, TEST_ITR_FORCED_RUN)

          assert.propertyVal(forcedToRunSuite.content.meta, TEST_STATUS, 'pass')
          assert.propertyVal(forcedToRunSuite.content.meta, TEST_ITR_UNSKIPPABLE, 'true')
          assert.propertyVal(forcedToRunSuite.content.meta, TEST_ITR_FORCED_RUN, 'true')
        }, 25000)

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './unskippable-test/test-to-run.js',
              './unskippable-test/test-to-skip.js',
              './unskippable-test/test-unskippable.js'
            ])
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

    it('only sets forced to run if suite was going to be skipped by ITR', (done) => {
      receiver.setSuitesToSkip([
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/unskippable-test/test-to-skip.js'
          }
        }
      ])

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const suites = events.filter(event => event.type === 'test_suite_end')

          assert.equal(suites.length, 3)

          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content
          assert.notProperty(testSession.meta, TEST_ITR_FORCED_RUN)
          assert.propertyVal(testSession.meta, TEST_ITR_UNSKIPPABLE, 'true')
          assert.notProperty(testModule.meta, TEST_ITR_FORCED_RUN)
          assert.propertyVal(testModule.meta, TEST_ITR_UNSKIPPABLE, 'true')

          const passedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-to-run.js'
          )
          const skippedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-to-skip.js'
          ).content
          const nonSkippedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-unskippable.js'
          ).content

          // It does not mark as unskippable if there is no docblock
          assert.propertyVal(passedSuite.content.meta, TEST_STATUS, 'pass')
          assert.notProperty(passedSuite.content.meta, TEST_ITR_UNSKIPPABLE)
          assert.notProperty(passedSuite.content.meta, TEST_ITR_FORCED_RUN)

          assert.propertyVal(skippedSuite.meta, TEST_STATUS, 'skip')

          assert.propertyVal(nonSkippedSuite.meta, TEST_STATUS, 'pass')
          assert.propertyVal(nonSkippedSuite.meta, TEST_ITR_UNSKIPPABLE, 'true')
          // it was not forced to run because it wasn't going to be skipped
          assert.notProperty(nonSkippedSuite.meta, TEST_ITR_FORCED_RUN)
        }, 25000)

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './unskippable-test/test-to-run.js',
              './unskippable-test/test-to-skip.js',
              './unskippable-test/test-unskippable.js'
            ])
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

  context('early flake detection', () => {
    it('retries new tests', (done) => {
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests']
        }
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD
          },
          faulty_session_threshold: 100
        }
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          // TODO: maybe check in stdout for the "Retried by Datadog"
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // no other tests are considered new
          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.notProperty(test.meta, TEST_IS_NEW)
          })
          assert.equal(oldTests.length, 1)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
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
          // Test name does not change
          newTests.forEach(test => {
            assert.equal(test.meta[TEST_NAME], 'ci visibility 2 can report tests 2')
          })
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js'
            ])
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
    it('handles parameterized tests as a single unit', (done) => {
      // Tests from ci-visibility/test-early-flake-detection/test-parameterized.js will be considered new
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test-early-flake-detection/test.js': ['ci visibility can report tests']
        }
      })
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3
          },
          faulty_session_threshold: 100
        }
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test-early-flake-detection/mocha-parameterized.js'
          )
          newTests.forEach(test => {
            assert.propertyVal(test.meta, TEST_IS_NEW, 'true')
          })
          // Each parameter is repeated independently
          const testsForFirstParameter = tests.filter(test => test.resource ===
            'ci-visibility/test-early-flake-detection/mocha-parameterized.js.parameterized test parameter 1'
          )

          const testsForSecondParameter = tests.filter(test => test.resource ===
            'ci-visibility/test-early-flake-detection/mocha-parameterized.js.parameterized test parameter 2'
          )

          assert.equal(testsForFirstParameter.length, testsForSecondParameter.length)

          // all but one have been retried
          assert.equal(
            testsForFirstParameter.length - 1,
            testsForFirstParameter.filter(test => test.meta[TEST_IS_RETRY] === 'true').length
          )

          assert.equal(
            testsForSecondParameter.length - 1,
            testsForSecondParameter.filter(test => test.meta[TEST_IS_RETRY] === 'true').length
          )
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/test.js',
              './test-early-flake-detection/mocha-parameterized.js'
            ])
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
    it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', (done) => {
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests']
        }
      })
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3
          },
          faulty_session_threshold: 100
        }
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
          // new tests are not detected
          assert.equal(newTests.length, 0)
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js'
            ]),
            DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false'
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
    it('retries flaky tests', (done) => {
      // Tests from ci-visibility/test/occasionally-failing-test will be considered new
      receiver.setKnownTests({})

      const NUM_RETRIES_EFD = 5
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD
          },
          faulty_session_threshold: 100
        }
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.equal(
            tests.length - 1,
            retriedTests.length
          )
          assert.equal(retriedTests.length, NUM_RETRIES_EFD)
          // Out of NUM_RETRIES_EFD + 1 total runs, half will be passing and half will be failing,
          // based on the global counter in the test file
          const passingTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.equal(passingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          assert.equal(failingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          // Test name does not change
          retriedTests.forEach(test => {
            assert.equal(test.meta[TEST_NAME], 'fail occasionally fails')
          })
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/occasionally-failing-test.js'
            ])
          },
          stdio: 'inherit'
        }
      )
      childProcess.on('exit', () => {
        // TODO: check exit code: if a new, retried test fails, the exit code should remain 0
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })
    it('does not retry new tests that are skipped', (done) => {
      // Tests from ci-visibility/test/skipped-and-todo-test will be considered new
      receiver.setKnownTests({})

      const NUM_RETRIES_EFD = 5
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD
          },
          faulty_session_threshold: 100
        }
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const newSkippedTests = tests.filter(
            test => test.meta[TEST_NAME] === 'ci visibility skip will not be retried'
          )
          assert.equal(newSkippedTests.length, 1)
          assert.notProperty(newSkippedTests[0].meta, TEST_IS_RETRY)
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/skipped-and-todo-test.js'
            ])
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
    it('handles spaces in test names', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3
          },
          faulty_session_threshold: 100
        }
      })
      // Tests from ci-visibility/test/skipped-and-todo-test will be considered new
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test-early-flake-detection/weird-test-names.js': [
            'no describe can do stuff',
            'describe  trailing space '
          ]
        }
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.equal(tests.length, 2)

          const resourceNames = tests.map(test => test.resource)

          assert.includeMembers(resourceNames,
            [
              'ci-visibility/test-early-flake-detection/weird-test-names.js.no describe can do stuff',
              'ci-visibility/test-early-flake-detection/weird-test-names.js.describe  trailing space '
            ]
          )

          const newTests = tests.filter(
            test => test.meta[TEST_IS_NEW] === 'true'
          )
          // no new tests
          assert.equal(newTests.length, 0)
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/weird-test-names.js'
            ])
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
    it('does not run EFD if the known tests request fails', (done) => {
      receiver.setKnownTestsResponseCode(500)

      const NUM_RETRIES_EFD = 5
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD
          },
          faulty_session_threshold: 100
        }
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.equal(tests.length, 2)
          const newTests = tests.filter(
            test => test.meta[TEST_IS_NEW] === 'true'
          )
          assert.equal(newTests.length, 0)
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js'
            ])
          },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })
    it('retries flaky tests and sets exit code to 0 as long as one attempt passes', (done) => {
      // Tests from ci-visibility/test/occasionally-failing-test will be considered new
      receiver.setKnownTests({})

      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD
          },
          faulty_session_threshold: 100
        }
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.equal(
            tests.length - 1,
            retriedTests.length
          )
          assert.equal(retriedTests.length, NUM_RETRIES_EFD)
          // Out of NUM_RETRIES_EFD + 1 total runs, half will be passing and half will be failing,
          // based on the global counter in the test file
          const passingTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.equal(passingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          assert.equal(failingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          // Test name does not change
          retriedTests.forEach(test => {
            assert.equal(test.meta[TEST_NAME], 'fail occasionally fails')
          })
        })

      childProcess = exec(
        'node ./node_modules/mocha/bin/mocha ci-visibility/test-early-flake-detection/occasionally-failing-test*',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: '**/ci-visibility/test-early-flake-detection/occasionally-failing-test*'
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

      childProcess.on('exit', (exitCode) => {
        assert.include(testOutput, '2 passing')
        assert.include(testOutput, '2 failing')
        assert.equal(exitCode, 0)
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })
  })

  context('flaky test retries', () => {
    it('retries failed tests automatically', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: {
          enabled: false
        }
      })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-flaky-test-retries/eventually-passing-test.js'
            ])
          },
          stdio: 'inherit'
        }
      )

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.equal(tests.length, 3) // two failed retries and then the pass

          const failedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.equal(failedAttempts.length, 2)

          // TODO: maybe the passed should have retry and the first attempt (if failed), should not
        })

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })
  })
})
