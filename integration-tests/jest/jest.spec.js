'use strict'

const assert = require('node:assert/strict')

const { once } = require('node:events')
const { fork, exec, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { assertObjectContains } = require('../helpers')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
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
  JEST_DISPLAY_NAME,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_RETRY_REASON,
  TEST_SOURCE_START,
  TEST_CODE_OWNERS,
  TEST_SESSION_NAME,
  TEST_LEVEL_EVENT_TYPES,
  DI_ERROR_DEBUG_INFO_CAPTURED,
  DI_DEBUG_ERROR_PREFIX,
  DI_DEBUG_ERROR_FILE_SUFFIX,
  DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX,
  DI_DEBUG_ERROR_LINE_SUFFIX,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
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
  TEST_IS_MODIFIED,
  TEST_RETRY_REASON_TYPES,
  DD_CAPABILITIES_IMPACTED_TESTS,
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_FRAMEWORK_VERSION,
  CI_APP_ORIGIN,
  JEST_TEST_RUNNER,
  TEST_PARAMETERS,
  LIBRARY_VERSION,
  TEST_SUITE_ID,
  TEST_MODULE_ID,
  TEST_SESSION_ID,
  TEST_MODULE,
  TEST_COMMAND,
  TEST_FINAL_STATUS,
  GIT_COMMIT_SHA,
  GIT_REPOSITORY_URL,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { TELEMETRY_COVERAGE_UPLOAD } = require('../../packages/dd-trace/src/ci-visibility/telemetry')
const { ERROR_MESSAGE, ERROR_TYPE, ORIGIN_KEY, COMPONENT } = require('../../packages/dd-trace/src/constants')
const { NODE_MAJOR } = require('../../version')
const { version: ddTraceVersion } = require('../../package.json')

const testFile = 'ci-visibility/run-jest.js'
const expectedStdout = 'Test Suites: 2 passed'
const expectedCoverageFiles = [
  'ci-visibility/test/sum.js',
  'ci-visibility/test/ci-visibility-test.js',
  'ci-visibility/test/ci-visibility-test-2.js',
]
const runTestsCommand = 'node ./ci-visibility/run-jest.js'

const JEST_VERSION = process.env.JEST_VERSION || 'latest'
const onlyLatestIt = JEST_VERSION === 'latest' ? it : it.skip

// TODO: add ESM tests
describe(`jest@${JEST_VERSION} commonJS`, () => {
  let receiver
  let childProcess
  let cwd
  let startupTestFile
  let testOutput = ''

  useSandbox([
    `jest@${JEST_VERSION}`,
    `jest-jasmine2@${JEST_VERSION}`,
    // jest-environment-jsdom is included in older versions of jest
    JEST_VERSION === 'latest' ? `jest-environment-jsdom@${JEST_VERSION}` : '',
    // jest-circus is not included in older versions of jest
    JEST_VERSION !== 'latest' ? `jest-circus@${JEST_VERSION}` : '',
    '@happy-dom/jest-environment',
    'office-addin-mock',
    'winston',
    'jest-image-snapshot',
    '@fast-check/jest',
  ].filter(Boolean), true)

  before(function () {
    cwd = sandboxCwd()
    startupTestFile = path.join(cwd, testFile)
  })

  beforeEach(async function () {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess.kill()
    testOutput = ''
    await receiver.stop()
  })

  context('older versions of the agent (APM protocol)', () => {
    let oldApmProtocolEnvVars = {}

    beforeEach(() => {
      receiver.setInfoResponse({ endpoints: [] })
      oldApmProtocolEnvVars = {
        ...process.env,
        GITHUB_WORKSPACE: '', // so the repository root is not assigned to dd-trace-js
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        DD_TRACE_AGENT_PORT: receiver.port,
        NODE_OPTIONS: '-r dd-trace/ci/init',
        DD_CIVISIBILITY_AGENTLESS_ENABLED: '0',
      }
    })

    it('can run tests and report tests', async () => {
      const payloadPromise = receiver.payloadReceived(({ url }) => url === '/v0.4/traces')

      childProcess = fork(startupTestFile, {
        cwd,
        env: {
          DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
          DD_TRACE_AGENT_PORT: receiver.port,
          NODE_OPTIONS: '-r dd-trace/ci/init',
          DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2',
        },
        stdio: 'pipe',
      })
      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      const { payload } = await payloadPromise

      const testSpans = payload.flatMap(trace => trace)
      const resourceNames = testSpans.map(span => span.resource)

      assertObjectContains(resourceNames,
        [
          'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2',
          'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
        ]
      )

      const areAllTestSpans = testSpans.every(span => span.name === 'jest.test')
      assert.strictEqual(areAllTestSpans, true)

      assert.match(testOutput, new RegExp(expectedStdout))

      // Can read DD_TAGS
      testSpans.forEach(testSpan => {
        assertObjectContains(testSpan.meta, {
          'test.customtag': 'customvalue',
          'test.customtag2': 'customvalue2',
        })
      })

      testSpans.forEach(testSpan => {
        assert.strictEqual(testSpan.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/test/ci-visibility-test'), true)
        assert.ok(testSpan.metrics[TEST_SOURCE_START])
      })
    })

    it('should create test spans for sync, async, integration, parameterized and retried tests', async () => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/v0.4/traces', (payloads) => {
          const spans = payloads.flatMap(({ payload }) => payload.flatMap(trace => trace))

          const expectedTests = [
            {
              name: 'jest-test-suite tracer and active span are available',
              status: 'pass',
              extraTags: { 'test.add.stuff': 'stuff' },
            },
            { name: 'jest-test-suite done', status: 'pass' },
            { name: 'jest-test-suite done fail', status: 'fail' },
            { name: 'jest-test-suite done fail uncaught', status: 'fail' },
            { name: 'jest-test-suite can do integration http', status: 'pass' },
            {
              name: 'jest-test-suite can do parameterized test',
              status: 'pass',
              parameters: { arguments: [1, 2, 3], metadata: {} },
            },
            {
              name: 'jest-test-suite can do parameterized test',
              status: 'pass',
              parameters: { arguments: [2, 3, 5], metadata: {} },
            },
            { name: 'jest-test-suite promise passes', status: 'pass' },
            { name: 'jest-test-suite promise fails', status: 'fail' },
            { name: 'jest-test-suite timeout', status: 'fail', error: 'Exceeded timeout' },
            { name: 'jest-test-suite passes', status: 'pass' },
            { name: 'jest-test-suite fails', status: 'fail' },
            { name: 'jest-test-suite does not crash with missing stack', status: 'fail' },
            { name: 'jest-test-suite skips', status: 'skip' },
            { name: 'jest-test-suite skips todo', status: 'skip' },
            { name: 'jest-circus-test-retry can retry', status: 'fail' },
            { name: 'jest-circus-test-retry can retry', status: 'fail' },
            { name: 'jest-circus-test-retry can retry', status: 'pass' },
          ]

          expectedTests.forEach(({ name, status, error, parameters, extraTags }) => {
            const test = spans.find(test =>
              test.meta[TEST_NAME] === name &&
              test.meta[TEST_STATUS] === status &&
              test.meta[TEST_SUITE] === 'ci-visibility/jest-plugin-tests/jest-test.js' &&
              (!parameters || test.meta[TEST_PARAMETERS] === JSON.stringify(parameters))
            )

            assert.ok(test)

            assert.strictEqual(test.meta.language, 'javascript')
            assert.strictEqual(test.meta.service, 'plugin-tests')
            assert.strictEqual(test.meta[ORIGIN_KEY], CI_APP_ORIGIN)
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'jest')
            assert.strictEqual(test.meta[TEST_NAME], name)
            assert.strictEqual(test.meta[TEST_STATUS], status)
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/jest-plugin-tests/jest-test.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/jest-plugin-tests/jest-test.js')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[JEST_TEST_RUNNER], 'jest-circus')
            assert.strictEqual(test.meta[LIBRARY_VERSION], ddTraceVersion)
            assert.strictEqual(test.meta[COMPONENT], 'jest')
            assert.match(test.meta[TEST_CODE_OWNERS], /@datadog-dd-trace-js/)

            assert.strictEqual(test.type, 'test')
            assert.strictEqual(test.name, 'jest.test')
            assert.strictEqual(test.service, 'plugin-tests')
            assert.strictEqual(test.resource, `ci-visibility/jest-plugin-tests/jest-test.js.${name}`)

            assert.ok(test.metrics[TEST_SOURCE_START])
            assert.ok(test.meta[TEST_FRAMEWORK_VERSION])

            if (extraTags) {
              Object.entries(extraTags).forEach(([key, value]) => {
                assert.strictEqual(test.meta[key], value)
              })
            }

            if (error) {
              assert.match(test.meta[ERROR_MESSAGE], new RegExp(error))
            }

            // TODO: why did this work in jsdom before?
            if (name === 'jest-test-suite can do integration http') {
              const httpSpan = spans.find(span => span.name === 'http.request')
              assert.strictEqual(httpSpan.meta[ORIGIN_KEY], CI_APP_ORIGIN)
              assert.match(httpSpan.meta['http.url'], /\/info/)
              assert.strictEqual(httpSpan.parent_id.toString(), test.span_id.toString())
            }
          })
        }, 25000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...oldApmProtocolEnvVars,
            TESTS_TO_RUN: 'jest-plugin-tests/jest-test.js',
            DD_SERVICE: 'plugin-tests',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    it('should detect an error in hooks', async () => {
      const tests = [
        { name: 'jest-hook-failure will not run', error: 'hey, hook error before' },
        { name: 'jest-hook-failure-after will not run', error: 'hey, hook error after' },
      ]

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/v0.4/traces', (payloads) => {
          const testSpans = payloads.flatMap(({ payload }) => payload.flatMap(trace => trace))

          tests.forEach(({ name, error }) => {
            const testSpan = testSpans.find(span =>
              span.resource === `ci-visibility/jest-plugin-tests/jest-hook-failure.js.${name}`
            )

            assert.ok(testSpan)
            assert.strictEqual(testSpan.meta.language, 'javascript')
            assert.strictEqual(testSpan.meta[ORIGIN_KEY], CI_APP_ORIGIN)
            assert.strictEqual(testSpan.meta[TEST_FRAMEWORK], 'jest')
            assert.strictEqual(testSpan.meta[TEST_NAME], name)
            assert.strictEqual(testSpan.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSpan.meta[TEST_SUITE], 'ci-visibility/jest-plugin-tests/jest-hook-failure.js')
            assert.strictEqual(testSpan.meta[TEST_SOURCE_FILE], 'ci-visibility/jest-plugin-tests/jest-hook-failure.js')
            assert.strictEqual(testSpan.meta[TEST_TYPE], 'test')
            assert.strictEqual(testSpan.meta[JEST_TEST_RUNNER], 'jest-circus')
            assert.strictEqual(testSpan.meta[COMPONENT], 'jest')
            assert.strictEqual(testSpan.meta[ERROR_MESSAGE], error)
            assert.strictEqual(testSpan.type, 'test')
            assert.strictEqual(testSpan.name, 'jest.test')
            assert.strictEqual(testSpan.resource, `ci-visibility/jest-plugin-tests/jest-hook-failure.js.${name}`)
            assert.ok(testSpan.meta[TEST_FRAMEWORK_VERSION])
          })
        }, 25000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...oldApmProtocolEnvVars,
            TESTS_TO_RUN: 'jest-plugin-tests/jest-hook-failure',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    it('should work with focused tests', async () => {
      const tests = [
        { name: 'jest-test-focused will be skipped', status: 'skip' },
        { name: 'jest-test-focused-2 will be skipped too', status: 'skip' },
        { name: 'jest-test-focused can do focused test', status: 'pass' },
      ]

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/v0.4/traces', (payloads) => {
          const testSpans = payloads.flatMap(({ payload }) => payload.flatMap(trace => trace))

          tests.forEach(({ name, status }) => {
            const testSpan = testSpans.find(span =>
              span.resource === `ci-visibility/jest-plugin-tests/jest-focus.js.${name}`
            )

            assert.ok(testSpan)
            assert.strictEqual(testSpan.meta.language, 'javascript')
            assert.strictEqual(testSpan.meta[ORIGIN_KEY], CI_APP_ORIGIN)
            assert.strictEqual(testSpan.meta[TEST_FRAMEWORK], 'jest')
            assert.strictEqual(testSpan.meta[TEST_NAME], name)
            assert.strictEqual(testSpan.meta[TEST_STATUS], status)
            assert.strictEqual(testSpan.meta[TEST_SUITE], 'ci-visibility/jest-plugin-tests/jest-focus.js')
            assert.strictEqual(testSpan.meta[TEST_SOURCE_FILE], 'ci-visibility/jest-plugin-tests/jest-focus.js')
            assert.strictEqual(testSpan.meta[COMPONENT], 'jest')
            assert.strictEqual(testSpan.type, 'test')
            assert.strictEqual(testSpan.name, 'jest.test')
            assert.strictEqual(testSpan.resource, `ci-visibility/jest-plugin-tests/jest-focus.js.${name}`)
            assert.ok(testSpan.meta[TEST_FRAMEWORK_VERSION])
          })
        }, 25000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...oldApmProtocolEnvVars,
            TESTS_TO_RUN: 'jest-plugin-tests/jest-focus',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    // injectGlobals was added in jest@26
    onlyLatestIt('does not crash when injectGlobals is false', async () => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/v0.4/traces', (payloads) => {
          const testSpan = payloads
            .flatMap(({ payload }) => payload.flatMap(trace => trace))
            .find(span => span.type === 'test')
          assert.ok(testSpan)
          assert.strictEqual(testSpan.meta[TEST_NAME], 'jest-inject-globals will be run')
          assert.strictEqual(testSpan.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testSpan.meta[TEST_SUITE], 'ci-visibility/jest-plugin-tests/jest-inject-globals.js')
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...oldApmProtocolEnvVars,
            TESTS_TO_RUN: 'jest-plugin-tests/jest-inject-globals',
            DO_NOT_INJECT_GLOBALS: 'true',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })
  })

  const nonLegacyReportingOptions = ['agentless', 'evp proxy']

  nonLegacyReportingOptions.forEach((reportingOption) => {
    context(`reporting via (${reportingOption})`, () => {
      it('can run and report tests', (done) => {
        const envVars = reportingOption === 'agentless'
          ? getCiVisAgentlessConfig(receiver.port)
          : getCiVisEvpProxyConfig(receiver.port)
        if (reportingOption === 'evp proxy') {
          receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
        }

        receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), (payloads) => {
          try {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            metadataDicts.forEach(metadata => {
              for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
                assert.strictEqual(metadata[testLevel][TEST_SESSION_NAME], 'my-test-session')
              }
            })

            const events = payloads.flatMap(({ payload }) => payload.events)
            const sessionEventContent = events.find(event => event.type === 'test_session_end').content
            const moduleEventContent = events.find(event => event.type === 'test_module_end').content
            const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const resourceNames = tests.map(span => span.resource)

            assertObjectContains(resourceNames,
              [
                'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2',
                'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
              ]
            )
            assert.strictEqual(suites.length, 2)
            assert.ok(sessionEventContent)
            assert.ok(moduleEventContent)

            assert.match(testOutput, new RegExp(expectedStdout))

            tests.forEach(testEvent => {
              assert.strictEqual(
                testEvent.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/test/ci-visibility-test'),
                true
              )
              assert.ok(testEvent.metrics[TEST_SOURCE_START])
              assert.strictEqual(testEvent.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'false')
              // Can read DD_TAGS
              assert.strictEqual(testEvent.meta['test.customtag'], 'customvalue')
              assert.strictEqual(testEvent.meta['test.customtag2'], 'customvalue2')
              assert.ok(testEvent.metrics[DD_HOST_CPU_COUNT])
            })

            suites.forEach(testSuite => {
              assert.strictEqual(
                testSuite.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/test/ci-visibility-test'),
                true
              )
              assert.strictEqual(testSuite.metrics[TEST_SOURCE_START], 1)
              assert.ok(testSuite.metrics[DD_HOST_CPU_COUNT])
            })
            done()
          } catch (error) {
            done(error)
          }
        })

        childProcess = fork(startupTestFile, {
          cwd,
          env: {
            ...envVars,
            DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2',
            DD_TEST_SESSION_NAME: 'my-test-session',
            DD_SERVICE: undefined,
          },
          stdio: 'pipe',
        })
        childProcess.stdout?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
      })

      // TODO: This should also run in agentless mode
      const maybeSkippped = reportingOption === 'evp proxy' ? it : it.skip
      maybeSkippped('sends telemetry with test_session metric when telemetry is enabled', async () => {
        const envVars = getCiVisEvpProxyConfig(receiver.port)
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
              ...envVars,
              DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
              TESTS_TO_RUN: 'test/ci-visibility-test',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          telemetryPromise,
        ])
      })

      it('should create events for session, suite and test', async () => {
        const envVars = reportingOption === 'agentless'
          ? getCiVisAgentlessConfig(receiver.port)
          : getCiVisEvpProxyConfig(receiver.port)
        if (reportingOption === 'evp proxy') {
          receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
        }

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            const testModuleEvent = events.find(event => event.type === 'test_module_end').content
            const testSuiteEvent = events.find(event => event.type === 'test_suite_end').content
            const testEvent = events.find(event => event.type === 'test').content

            assert.ok(testSessionEvent)
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'pass')
            assert.ok(testSessionEvent[TEST_SESSION_ID])
            assert.ok(testSessionEvent.meta[TEST_COMMAND])
            assert.ok(testSessionEvent[TEST_SUITE_ID] == null)
            assert.ok(testSessionEvent[TEST_MODULE_ID] == null)

            assert.ok(testModuleEvent)
            assert.strictEqual(testModuleEvent.meta[TEST_STATUS], 'pass')
            assert.ok(testModuleEvent[TEST_SESSION_ID])
            assert.ok(testModuleEvent[TEST_MODULE_ID])
            assert.ok(testModuleEvent.meta[TEST_COMMAND])
            assert.ok(testModuleEvent[TEST_SUITE_ID] == null)

            assert.ok(testSuiteEvent)
            assert.strictEqual(testSuiteEvent.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testSuiteEvent.meta[TEST_SUITE], 'ci-visibility/jest-plugin-tests/jest-test-suite.js')
            assert.ok(testSuiteEvent.meta[TEST_COMMAND])
            assert.ok(testSuiteEvent.meta[TEST_MODULE])
            assert.ok(testSuiteEvent[TEST_SUITE_ID])
            assert.ok(testSuiteEvent[TEST_SESSION_ID])
            assert.ok(testSuiteEvent[TEST_MODULE_ID])

            assert.ok(testEvent)
            assert.strictEqual(testEvent.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testEvent.meta[TEST_NAME], 'jest-test-suite-visibility works')
            assert.strictEqual(testEvent.meta[TEST_SUITE], 'ci-visibility/jest-plugin-tests/jest-test-suite.js')
            assert.ok(testEvent.meta[TEST_COMMAND])
            assert.ok(testEvent.meta[TEST_MODULE])
            assert.ok(testEvent[TEST_SUITE_ID])
            assert.ok(testEvent[TEST_SESSION_ID])
            assert.ok(testEvent[TEST_MODULE_ID])
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...envVars,
              TESTS_TO_RUN: 'jest-plugin-tests/jest-test-suite',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
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
            [envVar]: 'false',
          },
          stdio: 'pipe',
        })
        childProcess.stdout?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('message', () => {
          assert.match(testOutput, new RegExp(expectedStdout))
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
          NODE_OPTIONS: '-r dd-trace/init',
        },
        stdio: 'pipe',
      })
      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.on('message', () => {
        assert.doesNotMatch(testOutput, /TypeError/)
        assert.doesNotMatch(testOutput, /Uncaught error outside test suite/)
        assert.match(testOutput, new RegExp(expectedStdout))
        done()
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
      'node ./node_modules/jest/bin/jest --config config-jest.js --rootDir ci-visibility/subproject',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          PROJECTS: JSON.stringify([{
            testMatch: ['**/subproject-test*'],
            testRunner: 'jest-circus/runner',
          }]),
        },
      }
    )

    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
  })

  // --shard was added in jest@28
  onlyLatestIt('works when sharding', (done) => {
    receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle').then(events => {
      const testSuiteEvents = events.payload.events.filter(event => event.type === 'test_suite_end')
      assert.strictEqual(testSuiteEvents.length, 3)
      const testSuites = testSuiteEvents.map(span => span.content.meta[TEST_SUITE])

      assertObjectContains(testSuites,
        [
          'ci-visibility/sharding-test/sharding-test-5.js',
          'ci-visibility/sharding-test/sharding-test-4.js',
          'ci-visibility/sharding-test/sharding-test-1.js',
        ]
      )

      const testSession = events.payload.events.find(event => event.type === 'test_session_end').content
      assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')

      // We run the second shard
      receiver.setSuitesToSkip([
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/sharding-test/sharding-test-2.js',
          },
        },
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/sharding-test/sharding-test-3.js',
          },
        },
      ])
      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'sharding-test/sharding-test',
            TEST_SHARD: '2/2',
          },
        }
      )

      receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle').then(secondShardEvents => {
        const testSuiteEvents = secondShardEvents.payload.events.filter(event => event.type === 'test_suite_end')

        // The suites for this shard are to be skipped
        assert.strictEqual(testSuiteEvents.length, 2)

        testSuiteEvents.forEach(testSuite => {
          assert.strictEqual(testSuite.content.meta[TEST_STATUS], 'skip')
          assert.strictEqual(testSuite.content.meta[TEST_SKIPPED_BY_ITR], 'true')
        })

        const testSession = secondShardEvents
          .payload
          .events
          .find(event => event.type === 'test_session_end').content

        assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
        assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
        assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 2)

        done()
      })
    })
    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: 'sharding-test/sharding-test',
          TEST_SHARD: '1/2',
        },
      }
    )
  })

  it('does not crash when jest is badly initialized', (done) => {
    childProcess = fork('ci-visibility/run-jest-bad-init.js', {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: receiver.port,
      },
      stdio: 'pipe',
    })
    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.on('message', () => {
      assert.doesNotMatch(testOutput, /TypeError/)
      assert.match(testOutput, new RegExp(expectedStdout))
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
        RUN_IN_PARALLEL: 'true',
      },
      stdio: 'pipe',
    })
    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.on('message', () => {
      assert.doesNotMatch(testOutput, /TypeError/)
      done()
    })
  })

  context('when jest is using workers to run tests in parallel', () => {
    it('reports tests when using the old agents', (done) => {
      receiver.setInfoResponse({ endpoints: [] })
      childProcess = fork(testFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: receiver.port,
          NODE_OPTIONS: '-r dd-trace/ci/init',
          RUN_IN_PARALLEL: 'true',
        },
        stdio: 'pipe',
      })

      receiver.gatherPayloads(({ url }) => url === '/v0.4/traces', 5000).then(tracesRequests => {
        const testSpans = tracesRequests.flatMap(trace => trace.payload).flatMap(request => request)
        assert.strictEqual(testSpans.length, 2)
        const spanTypes = testSpans.map(span => span.type)
        assertObjectContains(spanTypes, ['test'])
        assert.ok(!spanTypes.some(type => ['test_session_end', 'test_suite_end', 'test_module_end'].includes(type)))
        receiver.setInfoResponse({ endpoints: ['/evp_proxy/v2'] })
        done()
      }).catch(done)
    })

    it('reports tests when using agentless', (done) => {
      childProcess = fork(testFile, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          RUN_IN_PARALLEL: 'true',
          DD_TEST_SESSION_NAME: 'my-test-session',
        },
        stdio: 'pipe',
      })

      receiver.gatherPayloads(({ url }) => url === '/api/v2/citestcycle', 5000).then(eventsRequests => {
        const metadataDicts = eventsRequests.flatMap(({ payload }) => payload.metadata)

        // it propagates test session name to the test and test suite events in parallel mode
        metadataDicts.forEach(metadata => {
          for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
            assert.strictEqual(metadata[testLevel][TEST_SESSION_NAME], 'my-test-session')
          }
        })

        const events = eventsRequests.map(({ payload }) => payload)
          .flatMap(({ events }) => events)
        const eventTypes = events.map(event => event.type)
        assertObjectContains(eventTypes, ['test', 'test_suite_end', 'test_session_end', 'test_module_end'])

        done()
      }).catch(done)
    })

    it('reports tests when using evp proxy', (done) => {
      childProcess = fork(testFile, {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          RUN_IN_PARALLEL: 'true',
        },
        stdio: 'pipe',
      })

      receiver.gatherPayloads(({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle', 5000)
        .then(eventsRequests => {
          const eventTypes = eventsRequests.map(({ payload }) => payload)
            .flatMap(({ events }) => events)
            .map(event => event.type)

          assertObjectContains(eventTypes, ['test', 'test_suite_end', 'test_session_end', 'test_module_end'])
          done()
        }).catch(done)
    })

    // older versions handle retries differently
    onlyLatestIt('can work with Failed Test Replay', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })
      let snapshotIdByTest, snapshotIdByLog
      let spanIdByTest, spanIdByLog, traceIdByTest, traceIdByLog
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 2)
          const retriedTest = retriedTests.find(test => test.meta[TEST_SUITE].includes('test-hit-breakpoint.js'))

          assert.strictEqual(retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED], 'true')

          assert.strictEqual(retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
            .endsWith('ci-visibility/dynamic-instrumentation/dependency.js'), true)
          assert.strictEqual(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 6)

          const snapshotIdKey = `${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX}`
          assert.ok(retriedTest.meta[snapshotIdKey])

          snapshotIdByTest = retriedTest.meta[snapshotIdKey]
          spanIdByTest = retriedTest.span_id.toString()
          traceIdByTest = retriedTest.trace_id.toString()

          const notRetriedTest = tests.find(test => test.meta[TEST_NAME].includes('is not retried'))

          assert.ok(!('DI_ERROR_DEBUG_INFO_CAPTURED' in notRetriedTest.meta))
        })

      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          const [{ logMessage: [diLog] }] = payloads
          assertObjectContains(diLog, {
            ddsource: 'dd_debugger',
            level: 'error',
          })
          assert.strictEqual(diLog.debugger.snapshot.language, 'javascript')
          spanIdByLog = diLog.dd.span_id
          traceIdByLog = diLog.dd.trace_id
          snapshotIdByLog = diLog.debugger.snapshot.id
        })

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            RUN_IN_PARALLEL: 'true',
          },
        }
      )

      childProcess.on('exit', () => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.strictEqual(snapshotIdByTest, snapshotIdByLog)
          assert.strictEqual(spanIdByTest, spanIdByLog)
          assert.strictEqual(traceIdByTest, traceIdByLog)
          done()
        }).catch(done)
      })
    })
  })

  it('reports timeout error message', (done) => {
    childProcess = fork(testFile, {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        NODE_OPTIONS: '-r dd-trace/ci/init',
        RUN_IN_PARALLEL: 'true',
        TESTS_TO_RUN: 'timeout-test/timeout-test.js',
      },
      stdio: 'pipe',
    })
    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.on('message', () => {
      // it's "100ms" or "100 ms" depending on the jest version
      assert.match(testOutput, /Exceeded timeout of 100\s?ms for a test/)
      done()
    })
  })

  it('reports parsing errors in the test file', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const suites = events.filter(event => event.type === 'test_suite_end')
        assert.strictEqual(suites.length, 2)

        const resourceNames = suites.map(suite => suite.content.resource)

        assertObjectContains(resourceNames, [
          'test_suite.ci-visibility/test-parsing-error/parsing-error-2.js',
          'test_suite.ci-visibility/test-parsing-error/parsing-error.js',
        ])
        suites.forEach(suite => {
          assert.strictEqual(suite.content.meta[TEST_STATUS], 'fail')
          assert.match(suite.content.meta[ERROR_MESSAGE], /chao/)
        })
      })
    childProcess = fork(testFile, {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        TESTS_TO_RUN: 'test-parsing-error/parsing-error',
      },
      stdio: 'pipe',
    })
    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
  })

  context('when using off timing imports', () => {
    onlyLatestIt('reports test suite errors when waitForUnhandledRejections=true', async () => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const suites = events.filter(event => event.type === 'test_suite_end')
          assert.strictEqual(suites.length, 3)

          const failedTestSuites = suites.filter(
            suite => suite.content.meta[TEST_SUITE] === 'ci-visibility/jest-bad-import/jest-bad-import-test.js'
          )
          assert.strictEqual(failedTestSuites.length, 1)
          const [failedTestSuite] = failedTestSuites

          assert.strictEqual(failedTestSuite.content.meta[TEST_STATUS], 'fail')
          assert.ok(
            failedTestSuite.content.meta[ERROR_MESSAGE].includes('a file outside of the scope of the test code')
          )
          assert.strictEqual(failedTestSuite.content.meta[ERROR_TYPE], 'Error')

          const passedTestSuites = suites.filter(
            suite => suite.content.meta[TEST_STATUS] === 'pass'
          )
          assert.strictEqual(passedTestSuites.length, 2)
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: 'jest-bad-import/jest-bad-import-test',
          RUN_IN_PARALLEL: 'true',
          WAIT_FOR_UNHANDLED_REJECTIONS: 'true',
        },
      })

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    onlyLatestIt('reports test suite errors when importing after environment is torn down', async () => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const suites = events.filter(event => event.type === 'test_suite_end')
          // this is not retried by the jest worker, so it's just 3 suites
          assert.strictEqual(suites.length, 3)
          const badImportTestSuites = suites.filter(
            suite => suite.content.meta[TEST_SUITE] ===
              'ci-visibility/jest-bad-import-torn-down/jest-bad-import-test.js'
          )
          assert.strictEqual(badImportTestSuites.length, 1)
          const [badImportTestSuite] = badImportTestSuites

          // jest still reports the test suite as passing
          assert.strictEqual(badImportTestSuite.content.meta[TEST_STATUS], 'pass')
          assert.ok(
            badImportTestSuite.content.meta[ERROR_MESSAGE]
              .includes('a file after the Jest environment has been torn down')
          )
          assert.ok(
            badImportTestSuite.content.meta[ERROR_MESSAGE]
              .includes('From ci-visibility/jest-bad-import-torn-down/jest-bad-import-test.js')
          )
          // This is the error message that jest should show. We check that we don't mess it up.
          assert.match(badImportTestSuite.content.meta[ERROR_MESSAGE], /off-timing-import/)
          assert.match(badImportTestSuite.content.meta[ERROR_MESSAGE], /afterAll/)
          assert.match(badImportTestSuite.content.meta[ERROR_MESSAGE], /nextTick/)

          const passedTestSuites = suites.filter(
            suite => suite.content.meta[TEST_STATUS] === 'pass'
          )
          assert.strictEqual(passedTestSuites.length, 3)
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: 'jest-bad-import-torn-down/jest-bad-import-test',
          RUN_IN_PARALLEL: 'true',
        },
      })

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })
  })

  it('does not report total code coverage % if user has not configured coverage manually', (done) => {
    receiver.setSettings({
      itr_enabled: true,
      code_coverage: true,
      tests_skipping: false,
    })

    receiver.assertPayloadReceived(({ payload }) => {
      const testSession = payload.events.find(event => event.type === 'test_session_end').content
      assert.ok(!(TEST_CODE_COVERAGE_LINES_PCT in testSession.metrics))
    }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      }
    )
  })

  it('reports total code coverage % even when ITR is disabled', (done) => {
    receiver.setSettings({
      itr_enabled: false,
      code_coverage: false,
      tests_skipping: false,
    })

    receiver.assertPayloadReceived(({ payload }) => {
      const testSession = payload.events.find(event => event.type === 'test_session_end').content
      assert.ok(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])
    }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: { ...getCiVisAgentlessConfig(receiver.port), ENABLE_CODE_COVERAGE: '1' },
      }
    )
  })

  it('works with --forceExit and logs a warning', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        assert.match(testOutput, /Jest's '--forceExit' flag has been passed/)
        const events = payloads.flatMap(({ payload }) => payload.events)

        const testSession = events.find(event => event.type === 'test_session_end')
        const testModule = events.find(event => event.type === 'test_module_end')
        const testSuites = events.filter(event => event.type === 'test_suite_end')
        const tests = events.filter(event => event.type === 'test')

        assert.ok(testSession)
        assert.ok(testModule)
        assert.strictEqual(testSuites.length, 2)
        assert.strictEqual(tests.length, 2)
      })
    // Needs to run with the CLI if we want --forceExit to work
    childProcess = exec(
      'node ./node_modules/jest/bin/jest --config config-jest.js --forceExit',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_TRACE_DEBUG: '1',
          DD_TRACE_LOG_LEVEL: 'warn',
        },
      }
    )
    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
  })

  it('does not hang if server is not available and logs an error', (done) => {
    // Very slow intake
    receiver.setWaitingTime(30000)
    // Needs to run with the CLI if we want --forceExit to work
    childProcess = exec(
      'node ./node_modules/jest/bin/jest --config config-jest.js --forceExit',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_TRACE_DEBUG: '1',
          DD_TRACE_LOG_LEVEL: 'warn',
        },
      }
    )
    childProcess.on('exit', () => {
      assert.match(testOutput, /Jest's '--forceExit' flag has been passed/)
      assert.match(testOutput, /Timeout waiting for the tracer to flush/)
      done()
    })
    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
  })

  it('grabs the jest displayName config and sets tag in tests and suites', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        assert.strictEqual(tests.length, 4) // two per display name
        const nodeTests = tests.filter(test => test.meta[JEST_DISPLAY_NAME] === 'node')
        assert.strictEqual(nodeTests.length, 2)

        const standardTests = tests.filter(test => test.meta[JEST_DISPLAY_NAME] === 'standard')
        assert.strictEqual(standardTests.length, 2)

        const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
        assert.strictEqual(suites.length, 4)

        const nodeSuites = suites.filter(suite => suite.meta[JEST_DISPLAY_NAME] === 'node')
        assert.strictEqual(nodeSuites.length, 2)

        const standardSuites = suites.filter(suite => suite.meta[JEST_DISPLAY_NAME] === 'standard')
        assert.strictEqual(standardSuites.length, 2)
      })
    childProcess = exec(
      'node ./node_modules/jest/bin/jest --config config-jest-multiproject.js',
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

  it('reports errors in test sessions', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testSession = events.find(event => event.type === 'test_session_end').content
        assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
        assert.match(testSession.meta[ERROR_MESSAGE], /Failed test suites: 1. Failed tests: 1/)
      })

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: 'test/fail-test',
        },
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
        DD_CIVISIBILITY_AGENTLESS_ENABLED: '1',
        NODE_OPTIONS: '-r dd-trace/ci/init',
      },
      stdio: 'pipe',
    })
    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.on('message', () => {
      assert.match(testOutput, new RegExp(expectedStdout))
      assert.match(
        testOutput,
        /DD_CIVISIBILITY_AGENTLESS_ENABLED is set, but neither DD_API_KEY nor DATADOG_API_KEY are set in your environment, so dd-trace will not be initialized./
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
      eventsRequestPromise,
    ]).then(([searchCommitRequest, packfileRequest, eventsRequest]) => {
      assert.strictEqual(searchCommitRequest.headers['dd-api-key'], '1')
      assert.strictEqual(packfileRequest.headers['dd-api-key'], '1')

      const eventTypes = eventsRequest.payload.events.map(event => event.type)
      assertObjectContains(eventTypes, ['test', 'test_suite_end', 'test_session_end', 'test_module_end'])
      const numSuites = eventTypes.reduce(
        (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
      )
      assert.strictEqual(numSuites, 2)

      done()
    }).catch(done)

    childProcess = fork(startupTestFile, {
      cwd,
      env: getCiVisAgentlessConfig(receiver.port),
      stdio: 'pipe',
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

          assertObjectContains(resourceNames,
            [
              'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2',
              'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
            ]
          )
        }, ({ url }) => url === '/v0.4/traces').then(() => done()).catch(done)

        childProcess = fork(startupTestFile, {
          cwd,
          env: getCiVisEvpProxyConfig(receiver.port),
          stdio: 'pipe',
        })
      })
    })

    it('can report code coverage', async () => {
      const libraryConfigRequestPromise = receiver.payloadReceived(
        ({ url }) => url === '/api/v2/libraries/tests/services/setting'
      )
      const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')
      const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

      const requestsPromises = Promise.all([
        libraryConfigRequestPromise,
        codeCovRequestPromise,
        eventsRequestPromise,
      ]).then(([libraryConfigRequest, codeCovRequest, eventsRequest]) => {
        assert.strictEqual(libraryConfigRequest.headers['dd-api-key'], '1')

        assertObjectContains(codeCovRequest, {
          headers: {
            'dd-api-key': '1',
          },
          payload: [{
            name: 'coverage1',
            filename: 'coverage1.msgpack',
            type: 'application/msgpack',
            content: {
              version: 2,
            },
          }],
        })
        const allCoverageFiles = codeCovRequest.payload
          .flatMap(coverage => coverage.content.coverages)
          .flatMap(file => file.files)
          .map(file => file.filename)

        assertObjectContains(allCoverageFiles.sort(), expectedCoverageFiles.sort())

        const [coveragePayload] = codeCovRequest.payload
        assert.ok(coveragePayload.content.coverages[0].test_session_id)
        assert.ok(coveragePayload.content.coverages[0].test_suite_id)

        const testSession = eventsRequest.payload.events.find(event => event.type === 'test_session_end').content
        assert.ok(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])

        const eventTypes = eventsRequest.payload.events.map(event => event.type)
        assertObjectContains(eventTypes, ['test', 'test_suite_end', 'test_session_end', 'test_module_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.strictEqual(numSuites, 2)
      })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            ENABLE_CODE_COVERAGE: '1',
          },
        }
      )
      await Promise.all([
        requestsPromises,
        once(childProcess, 'exit'),
      ])
    })

    it('does not report per test code coverage if disabled by the API', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
      })

      receiver.assertPayloadReceived(() => {
        const error = new Error('it should not report code coverage')
        done(error)
      }, ({ url }) => url === '/api/v2/citestcov').catch(() => {})

      receiver.assertPayloadReceived(({ headers, payload }) => {
        assert.strictEqual(headers['dd-api-key'], '1')
        const eventTypes = payload.events.map(event => event.type)
        assertObjectContains(eventTypes, ['test', 'test_suite_end', 'test_session_end', 'test_module_end'])
        const testSession = payload.events.find(event => event.type === 'test_session_end').content
        assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
        assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
        assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
        assert.ok(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])
        const testModule = payload.events.find(event => event.type === 'test_module_end').content
        assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
        assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
        assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
      }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            ENABLE_CODE_COVERAGE: '1',
          },
        }
      )
    })

    it('can skip suites received by the intelligent test runner API and still reports code coverage', (done) => {
      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js',
        },
      }])

      const skippableRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/ci/tests/skippable')
      const coverageRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')
      const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

      Promise.all([
        skippableRequestPromise,
        coverageRequestPromise,
        eventsRequestPromise,
      ]).then(([skippableRequest, coverageRequest, eventsRequest]) => {
        assert.strictEqual(skippableRequest.headers['dd-api-key'], '1')
        const [coveragePayload] = coverageRequest.payload
        assert.strictEqual(coverageRequest.headers['dd-api-key'], '1')
        assert.strictEqual(coveragePayload.name, 'coverage1')
        assert.strictEqual(coveragePayload.filename, 'coverage1.msgpack')
        assert.strictEqual(coveragePayload.type, 'application/msgpack')

        assert.strictEqual(eventsRequest.headers['dd-api-key'], '1')
        const eventTypes = eventsRequest.payload.events.map(event => event.type)
        const skippedSuite = eventsRequest.payload.events.find(event =>
          event.content.resource === 'test_suite.ci-visibility/test/ci-visibility-test.js'
        ).content
        assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
        assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')

        assertObjectContains(eventTypes, ['test', 'test_suite_end', 'test_session_end', 'test_module_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.strictEqual(numSuites, 2)
        const testSession = eventsRequest.payload.events.find(event => event.type === 'test_session_end').content
        assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
        assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
        assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
        assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
        assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
        const testModule = eventsRequest.payload.events.find(event => event.type === 'test_module_end').content
        assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'true')
        assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
        assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
        assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
        assert.strictEqual(testModule.metrics[TEST_ITR_SKIPPING_COUNT], 1)
        done()
      }).catch(done)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
    })

    it('marks the test session as skipped if every suite is skipped', (done) => {
      receiver.setSuitesToSkip(
        [
          {
            type: 'suite',
            attributes: {
              suite: 'ci-visibility/test/ci-visibility-test.js',
            },
          },
          {
            type: 'suite',
            attributes: {
              suite: 'ci-visibility/test/ci-visibility-test-2.js',
            },
          },
        ]
      )

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_STATUS], 'skip')
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

    it('does not skip tests if git metadata upload fails', (done) => {
      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js',
        },
      }])

      receiver.setGitUploadStatus(404)

      receiver.assertPayloadReceived(() => {
        const error = new Error('should not request skippable')
        done(error)
      }, ({ url }) => url === '/api/v2/ci/tests/skippable').catch(() => {})

      receiver.assertPayloadReceived(({ headers, payload }) => {
        assert.strictEqual(headers['dd-api-key'], '1')
        const eventTypes = payload.events.map(event => event.type)
        // because they are not skipped
        assertObjectContains(eventTypes, ['test', 'test_suite_end', 'test_session_end', 'test_module_end'])
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
      }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
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
          suite: 'ci-visibility/test/ci-visibility-test.js',
        },
      }])

      receiver.assertPayloadReceived(() => {
        const error = new Error('should not request skippable')
        done(error)
      }, ({ url }) => url === '/api/v2/ci/tests/skippable').catch(() => {})

      receiver.assertPayloadReceived(({ headers, payload }) => {
        assert.strictEqual(headers['dd-api-key'], '1')
        const eventTypes = payload.events.map(event => event.type)
        // because they are not skipped
        assertObjectContains(eventTypes, ['test', 'test_suite_end', 'test_session_end', 'test_module_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.strictEqual(numSuites, 2)
      }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
    })

    it('does not skip suites if suite is marked as unskippable', (done) => {
      receiver.setSuitesToSkip([
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/unskippable-test/test-to-skip.js',
          },
        },
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/unskippable-test/test-unskippable.js',
          },
        },
      ])

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const suites = events.filter(event => event.type === 'test_suite_end')

          assert.strictEqual(suites.length, 3)

          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content
          assert.strictEqual(testSession.meta[TEST_ITR_FORCED_RUN], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.strictEqual(testModule.meta[TEST_ITR_FORCED_RUN], 'true')
          assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')

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
          assert.strictEqual(passedSuite.content.meta[TEST_STATUS], 'pass')
          assert.ok(!(TEST_ITR_UNSKIPPABLE in passedSuite.content.meta))
          assert.ok(!(TEST_ITR_FORCED_RUN in passedSuite.content.meta))

          assert.strictEqual(skippedSuite.content.meta[TEST_STATUS], 'skip')
          assert.ok(!(TEST_ITR_UNSKIPPABLE in skippedSuite.content.meta))
          assert.ok(!(TEST_ITR_FORCED_RUN in skippedSuite.content.meta))

          assert.strictEqual(forcedToRunSuite.content.meta[TEST_STATUS], 'pass')
          assert.strictEqual(forcedToRunSuite.content.meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.strictEqual(forcedToRunSuite.content.meta[TEST_ITR_FORCED_RUN], 'true')
        }, 25000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'unskippable-test/test-',
          },
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
            suite: 'ci-visibility/unskippable-test/test-to-skip.js',
          },
        },
      ])

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const suites = events.filter(event => event.type === 'test_suite_end')

          assert.strictEqual(suites.length, 3)

          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content
          assert.ok(!(TEST_ITR_FORCED_RUN in testSession.meta))
          assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.ok(!(TEST_ITR_FORCED_RUN in testModule.meta))
          assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')

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
          assert.strictEqual(passedSuite.content.meta[TEST_STATUS], 'pass')
          assert.ok(!(TEST_ITR_UNSKIPPABLE in passedSuite.content.meta))
          assert.ok(!(TEST_ITR_FORCED_RUN in passedSuite.content.meta))

          assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')

          assert.strictEqual(nonSkippedSuite.meta[TEST_STATUS], 'pass')
          assert.strictEqual(nonSkippedSuite.meta[TEST_ITR_UNSKIPPABLE], 'true')
          // it was not forced to run because it wasn't going to be skipped
          assert.ok(!(TEST_ITR_FORCED_RUN in nonSkippedSuite.meta))
        }, 25000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'unskippable-test/test-',
          },
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
          suite: 'ci-visibility/test/not-existing-test.js',
        },
      }])
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
          assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
          const testModule = events.find(event => event.type === 'test_module_end').content
          assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
          assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
          assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
        }, 25000)

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

    it('works with multi project setup and test skipping', (done) => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        tests_skipping: true,
      })

      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js',
        },
      }])

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          // suites for both projects in the multi-project config are reported as skipped
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)

          const skippedSuites = testSuites.filter(
            suite => suite.resource === 'test_suite.ci-visibility/test/ci-visibility-test.js'
          )
          assert.strictEqual(skippedSuites.length, 2)

          skippedSuites.forEach(skippedSuite => {
            assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
            assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')
          })
        })

      childProcess = exec(
        'node ./node_modules/jest/bin/jest --config config-jest-multiproject.js',
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

    it('calculates executable lines even if there have been skipped suites', (done) => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        tests_skipping: true,
      })

      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test-total-code-coverage/test-skipped.js',
        },
      }])

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content

          // Before https://github.com/DataDog/dd-trace-js/pull/4336, this would've been 100%
          // The reason is that skipping jest's `addUntestedFiles`, we would not see unexecuted lines.
          // In this cause, these would be from the `unused-dependency.js` file.
          // It is 50% now because we only cover 1 out of 2 files (`used-dependency.js`).
          assert.strictEqual(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT], 50)
        })

      childProcess = exec(
        runTestsCommand, // Requirement: the user must've opted in to code coverage
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'ci-visibility/test-total-code-coverage/test-',
            COLLECT_COVERAGE_FROM: '**/test-total-code-coverage/**',
            ENABLE_CODE_COVERAGE: '1',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(done).catch(done)
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
            'ci-visibility/subproject/dependency.js',
            'ci-visibility/subproject/subproject-test.js',
          ])
        }, 5000)

      childProcess = exec(
        'node ./node_modules/jest/bin/jest --config config-jest.js --rootDir ci-visibility/subproject',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PROJECTS: JSON.stringify([{
              testMatch: ['**/subproject-test*'],
              testEnvironment: 'node',
              testRunner: 'jest-circus/runner',
            }]),
          },
        }
      )

      childProcess.on('exit', () => {
        codeCoveragesPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('report code coverage with all mocked files', (done) => {
      const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')

      codeCovRequestPromise.then((codeCovRequest) => {
        const allCoverageFiles = codeCovRequest.payload
          .flatMap(coverage => coverage.content.coverages)
          .flatMap(file => file.files)
          .map(file => file.filename)

        assertObjectContains(allCoverageFiles, [
          'ci-visibility/test/sum.js',
          'ci-visibility/jest/mocked-test.js',
        ])
      }).catch(done)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'jest/mocked-test.js',
          },
        }
      )
      childProcess.on('exit', () => {
        done()
      })
    })
  })

  it('sets final_status tag to test status on regular tests without retry features', async () => {
    receiver.setSettings({
      itr_enabled: false,
      code_coverage: false,
      tests_skipping: false,
      flaky_test_retries_enabled: false,
      early_flake_detection: {
        enabled: false,
      },
    })

    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        tests.forEach(test => {
          const testName = test.meta[TEST_NAME]
          const testStatus = test.meta[TEST_STATUS]
          const finalStatus = test.meta[TEST_FINAL_STATUS]

          assert.ok(
            finalStatus,
            `Expected TEST_FINAL_STATUS to be set for test "${testName}" with status "${testStatus}"`
          )
          assert.strictEqual(
            finalStatus,
            testStatus,
            `Expected TEST_FINAL_STATUS "${finalStatus}" to match TEST_STATUS "${testStatus}" for test "${testName}"`
          )
        })
      })

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: 'test/ci-visibility-test',
        },
        stdio: 'inherit',
      }
    )

    await Promise.all([
      once(childProcess, 'exit'),
      eventsPromise,
    ])
  })

  context('early flake detection', () => {
    it('takes precedence over flaky test retries for new tests', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // All tests are considered new
      receiver.setKnownTests({ jest: {} })
      const NUM_RETRIES_EFD = 2
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
        flaky_test_retries_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 3)
          const efdRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd)
          const atrRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)
          assert.strictEqual(efdRetries.length, NUM_RETRIES_EFD)
          assert.strictEqual(atrRetries.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisAgentlessConfig(receiver.port), TESTS_TO_RUN: 'jest-flaky/flaky-fails.js' },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    it('preserves test errors when ATR retry suppression is active due to EFD', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // All tests are considered new, so EFD will be active
      receiver.setKnownTests({ jest: {} })
      const NUM_RETRIES_EFD = 2
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
        flaky_test_retries_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')

          // Verify that all failing tests have error messages preserved
          // even though ATR retry suppression is active (due to EFD)
          failingTests.forEach(test => {
            assert.ok(
              ERROR_MESSAGE in test.meta,
              'Test error message should be preserved when ATR retry suppression is active'
            )
            assert.ok(test.meta[ERROR_MESSAGE].length > 0, 'Test error message should not be empty')
            // The error should contain information about the assertion failure
            assert.match(test.meta[ERROR_MESSAGE], /deepStrictEqual|Expected|actual/i)
          })

          // Verify EFD is active (ATR should be suppressed)
          const efdRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd)
          const atrRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)
          assert.strictEqual(efdRetries.length, NUM_RETRIES_EFD)
          assert.strictEqual(atrRetries.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisAgentlessConfig(receiver.port), TESTS_TO_RUN: 'jest-flaky/flaky-fails.js' },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    it(
      'sets final_status tag only on last ATR retry when EFD is enabled but not active and ATR is active',
      async () => {
        receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

        // All tests are known, so EFD will not be active
        receiver.setKnownTests({
          jest: {
            'ci-visibility/jest-flaky/flaky-passes.js': [
              'test-flaky-test-retries can retry flaky tests',
              'test-flaky-test-retries will not retry passed tests',
            ],
          },
        })

        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 2,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
          flaky_test_retries_enabled: true,
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events
              .filter(event => event.type === 'test')
              .map(event => event.content)
              .filter(test => test.meta[TEST_NAME] === 'test-flaky-test-retries can retry flaky tests')

            // We expect 2 executions: the failed (retry) and the passed (last one)
            assert.strictEqual(tests.length, 3)

            // Only the last execution (the one with status 'pass') should have TEST_FINAL_STATUS tag
            tests.sort((a, b) => a.meta.start - b.meta.start).forEach((test, idx) => {
              if (idx < tests.length - 1) {
                assert.ok(!(TEST_FINAL_STATUS in test.meta),
                  'TEST_FINAL_STATUS should not be set on previous runs'
                )
              } else {
                assert.strictEqual(test.meta[TEST_FINAL_STATUS], test.meta[TEST_STATUS])
                assert.strictEqual(test.meta[TEST_STATUS], 'pass')
              }
            })
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'jest-flaky/flaky-passes.js',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '5',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

    it('sets final_status tag to test status reported to test framework on last retry', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      const knownTestFile = 'ci-visibility/test/ci-visibility-test.js'
      receiver.setKnownTests({
        jest: {
          [knownTestFile]: ['ci visibility can report tests'],
        },
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          // no other tests are considered new
          const knownTests = tests.filter(test =>
            test.meta[TEST_SUITE] === knownTestFile
          )
          knownTests.forEach(test => {
            // all tests executions are the final executions
            assert.strictEqual(test.meta[TEST_FINAL_STATUS], test.meta[TEST_STATUS])
          })

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.sort((a, b) => a.meta.start - b.meta.start).forEach((test, index) => {
            if (index < newTests.length - 1) {
              assert.ok(!(TEST_FINAL_STATUS in test.meta))
            } else {
              // only the last execution should have the final status
              assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
            }
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test/ci-visibility-test',
            DD_TRACE_DEBUG: '1',
          },
          stdio: 'inherit',
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })
    it('retries new tests', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // no other tests are considered new
          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(oldTests.length, 1)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
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
            assert.strictEqual(test.meta[TEST_NAME], 'ci visibility 2 can report tests 2')
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'test/ci-visibility-test' },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('sets TEST_HAS_FAILED_ALL_RETRIES when all EFD attempts fail', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // fail-test.js will be considered new and will always fail
      receiver.setKnownTests({
        jest: {},
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const failTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/fail-test.js'
          )

          // Should have 1 initial attempt + NUM_RETRIES_EFD retries
          assert.strictEqual(failTests.length, NUM_RETRIES_EFD + 1)

          // All attempts should be marked as new
          failTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
          })

          // Check retries
          const retriedTests = failTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          })

          // Only the last retry should have TEST_HAS_FAILED_ALL_RETRIES set
          const lastRetry = failTests[failTests.length - 1]
          assert.strictEqual(lastRetry.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')

          // Earlier attempts should not have the flag
          for (let i = 0; i < failTests.length - 1; i++) {
            assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in failTests[i].meta))
          }
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'test/fail-test' },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('resets mock state between early flake detection retries', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Test is considered new (not in known tests)
      receiver.setKnownTests({ jest: {} })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      let stdout = ''
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // Should have 1 original + NUM_RETRIES_EFD retry attempts
          const mockTests = tests.filter(
            test => test.meta[TEST_NAME] === 'early flake detection tests with mock resets mock state between retries'
          )
          assert.strictEqual(mockTests.length, NUM_RETRIES_EFD + 1)

          // All tests should pass because mock state is reset between retries
          for (const test of mockTests) {
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
          }

          // All should be marked as new
          for (const test of mockTests) {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          }
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test-early-flake-detection/test-efd-with-mock',
          },
        }
      )

      childProcess.stdout?.on('data', (chunk) => {
        stdout += chunk.toString()
      })

      childProcess.stderr?.on('data', (chunk) => {
        stdout += chunk.toString()
      })

      const [exitCode] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      // Verify the test actually ran
      assert.match(stdout, /I am running EFD with mock/)

      // All retries should pass, so exit code should be 0
      assert.strictEqual(exitCode[0], 0)
    })

    it('handles parameterized tests as a single unit', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test-early-flake-detection/test-parameterized.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test-early-flake-detection/test.js': ['ci visibility can report tests'],
        },
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const parameterizedTestFile = 'test-parameterized.js'

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === `ci-visibility/test-early-flake-detection/${parameterizedTestFile}`
          )
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          // Each parameter is repeated independently
          const testsForFirstParameter = tests.filter(test => test.resource ===
            `ci-visibility/test-early-flake-detection/${parameterizedTestFile}.parameterized test parameter 1`
          )

          const testsForSecondParameter = tests.filter(test => test.resource ===
            `ci-visibility/test-early-flake-detection/${parameterizedTestFile}.parameterized test parameter 2`
          )

          assert.strictEqual(testsForFirstParameter.length, testsForSecondParameter.length)

          // all but one have been retried
          assert.strictEqual(
            testsForFirstParameter.length - 1,
            testsForFirstParameter.filter(test => test.meta[TEST_IS_RETRY] === 'true').length
          )

          assert.strictEqual(
            testsForSecondParameter.length - 1,
            testsForSecondParameter.filter(test => test.meta[TEST_IS_RETRY] === 'true').length
          )
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'test-early-flake-detection/test' },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
          },
          faulty_session_threshold: 100,
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

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test/ci-visibility-test',
            DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false',
          },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('retries flaky tests', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/occasionally-failing-test will be considered new
      receiver.setKnownTests({ jest: {} })

      const NUM_RETRIES_EFD = 5
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.strictEqual(tests.length - 1, retriedTests.length)
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          // Out of NUM_RETRIES_EFD + 1 total runs, half will be passing and half will be failing,
          // based on the global counter in the test file
          const passingTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(passingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          assert.strictEqual(failingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          // Test name does not change
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_NAME], 'fail occasionally fails')
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test-early-flake-detection/occasionally-failing-test',
          },
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
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/skipped-and-todo-test will be considered new
      receiver.setKnownTests({ jest: {} })

      const NUM_RETRIES_EFD = 5
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const newSkippedTests = tests.filter(
            test => test.meta[TEST_NAME] === 'ci visibility skip will not be retried'
          )
          assert.strictEqual(newSkippedTests.length, 1)
          assert.strictEqual(newSkippedTests[0].meta[TEST_FINAL_STATUS], 'skip')
          assert.ok(!(TEST_IS_RETRY in newSkippedTests[0].meta))

          const newTodoTests = tests.filter(
            test => test.meta[TEST_NAME] === 'ci visibility todo will not be retried'
          )
          assert.strictEqual(newTodoTests.length, 1)
          assert.ok(!(TEST_IS_RETRY in newTodoTests[0].meta))
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test-early-flake-detection/skipped-and-todo-test',
          },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('handles spaces in test names', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      // Tests from ci-visibility/test/skipped-and-todo-test will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test-early-flake-detection/weird-test-names.js': [
            'no describe can do stuff',
            'describe  trailing space ',
          ],
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 2)

          const resourceNames = tests.map(test => test.resource)

          assertObjectContains(resourceNames,
            [
              'ci-visibility/test-early-flake-detection/weird-test-names.js.no describe can do stuff',
              'ci-visibility/test-early-flake-detection/weird-test-names.js.describe  trailing space ',
            ]
          )

          const newTests = tests.filter(
            test => test.meta[TEST_IS_NEW] === 'true'
          )
          // no new tests
          assert.strictEqual(newTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test-early-flake-detection/weird-test-names',
          },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('does not run EFD if the known tests request fails', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      receiver.setKnownTestsResponseCode(500)

      const NUM_RETRIES_EFD = 5
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 2)
          const newTests = tests.filter(
            test => test.meta[TEST_IS_NEW] === 'true'
          )
          assert.strictEqual(newTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test/ci-visibility-test',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })

    it('retries flaky tests and sets exit code to 0 as long as one attempt passes', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/occasionally-failing-test will be considered new
      receiver.setKnownTests({ jest: {} })

      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
          // Session is passed because at least one retry of the new flaky test passes
          assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.strictEqual(tests.length - 1, retriedTests.length)
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          // Out of NUM_RETRIES_EFD + 1 total runs, half will be passing and half will be failing,
          // based on the global counter in the test file
          const passingTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(passingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          assert.strictEqual(failingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          // Test name does not change
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_NAME], 'fail occasionally fails')
          })
        })

      let testOutput = ''
      childProcess = exec(
        'node ./node_modules/jest/bin/jest --config config-jest.js',
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: '**/ci-visibility/test-early-flake-detection/occasionally-failing-test*',
            SHOULD_CHECK_RESULTS: '1',
          },
        }
      )

      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])

      assert.match(testOutput, /2 failed, 2 passed/)
      // Exit code is 0 because at least one retry of the new flaky test passes
      assert.strictEqual(exitCode, 0)

      // Verify Datadog Test Optimization message is shown when exit code is flipped
      assert.match(testOutput, /Datadog Test Optimization/)
      assert.match(testOutput, /\d+ test failure\(s\) were ignored\. Exit code set to 0\./)
      assert.match(testOutput, /Early Flake Detection/)
      assert.match(testOutput, /occasionally-failing-test.*›.*fail occasionally fails/)
    })

    // resetting snapshot state logic only works in latest versions
    onlyLatestIt('works with snapshot tests', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

      receiver.setKnownTests({
        jest: {
          'ci-visibility/test-early-flake-detection/jest-snapshot.js': [
            'test is not new',
            'test has snapshot and is known',
          ],
        },
      })

      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
          // Session is passed because at least one retry of each new flaky test passes
          assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          // 6 tests, 4 of which are new: 4*(1 test + 3 retries) + 2*(1 test) = 18
          assert.strictEqual(tests.length, 18)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // 4*(3 retries)
          assert.strictEqual(retriedTests.length, 12)

          const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
          // 4*(1 test + 3 retries)
          assert.strictEqual(newTests.length, 16)

          const flakyTests = tests.filter(test => test.meta[TEST_NAME] === 'test is flaky')
          assert.strictEqual(flakyTests.length, 4)
          const failedFlakyTests = flakyTests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(failedFlakyTests.length, 2)
          const passedFlakyTests = flakyTests.filter(test => test.meta[TEST_STATUS] === 'pass')
          assert.strictEqual(passedFlakyTests.length, 2)
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          TESTS_TO_RUN: 'ci-visibility/test-early-flake-detection/jest-snapshot',
          CI: '1', // needs to be run as CI so snapshots are not written
          SHOULD_CHECK_RESULTS: '1',
        },
      })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      // Exit code is 0 because at least one retry of each new flaky test passes
      assert.strictEqual(exitCode, 0)
    })

    // resetting snapshot state logic only works in latest versions
    onlyLatestIt('works with jest-image-snapshot', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

      receiver.setKnownTests({
        jest: {},
      })

      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
          // Session is passed because at least one retry of the new flaky test passes
          assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          // 1 new test
          assert.strictEqual(tests.length, 4)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, 3)

          const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
          assert.strictEqual(newTests.length, 4)

          const failedFlakyTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(failedFlakyTests.length, 2)
          const passedFlakyTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          assert.strictEqual(passedFlakyTests.length, 2)
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          TESTS_TO_RUN: 'ci-visibility/test-early-flake-detection/jest-image-snapshot',
          CI: '1',
          SHOULD_CHECK_RESULTS: '1',
        },
      })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      // Exit code is 0 because at least one retry of the new flaky test passes
      assert.strictEqual(exitCode, 0)
    })

    it('bails out of EFD if the percentage of new tests is too high', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test* will be considered new
      receiver.setKnownTests({ jest: {} })

      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 1,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 2)

          const newTests = tests.filter(
            test => test.meta[TEST_IS_NEW] === 'true'
          )
          // no new tests
          assert.strictEqual(newTests.length, 0)
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          TESTS_TO_RUN: 'test/ci-visibility-test',
        },
      })

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })

    it('works with jsdom', (done) => {
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // no other tests are considered new
          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(oldTests.length, 1)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.strictEqual(newTests.length - 1, retriedTests.length)
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          // Test name does not change
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_NAME], 'ci visibility 2 can report tests 2')
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port), // use agentless for this test, just for variety
            TESTS_TO_RUN: 'test/ci-visibility-test',
            ENABLE_JSDOM: 'true',
            DD_TRACE_DEBUG: '1',
            DD_TRACE_LOG_LEVEL: 'warn',
          },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })
    // happy-dom>=19 can only be used with CJS from node 20 and above
    const happyDomTest = NODE_MAJOR < 20 ? it.skip : onlyLatestIt
    happyDomTest('works with happy-dom', async () => {
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // no other tests are considered new
          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(oldTests.length, 1)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.strictEqual(newTests.length - 1, retriedTests.length)
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          // Test name does not change
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_NAME], 'ci visibility 2 can report tests 2')
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port), // use agentless for this test, just for variety
            TESTS_TO_RUN: 'test/ci-visibility-test',
            ENABLE_HAPPY_DOM: 'true',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    it('disables early flake detection if known tests should not be requested', (done) => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
          },
        },
        known_tests_enabled: false,
      })

      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(oldTests.length, 1)
          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'test/ci-visibility-test' },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    // it.failing was added in jest@29
    onlyLatestIt('does not retry when it.failing is used', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/jest/failing-test.js'
          )
          newTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(newTests.length, 2)

          const passingTests = tests.filter(test =>
            test.meta[TEST_NAME] === 'failing can report failed tests'
          )
          const failingTests = tests.filter(test =>
            test.meta[TEST_NAME] === 'failing can report failing tests as failures'
          )
          passingTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
          })
          failingTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
          })

          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'jest/failing-test' },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    context('parallel mode', () => {
      it('retries new tests', async () => {
        receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
        // Tests from ci-visibility/test/ci-visibility-test-4.js will be considered new
        receiver.setKnownTests({
          jest: {
            'ci-visibility/test/efd-parallel/ci-visibility-test.js': ['ci visibility can report tests'],
            'ci-visibility/test/efd-parallel/ci-visibility-test-2.js': ['ci visibility 2 can report tests 2'],
            'ci-visibility/test/efd-parallel/ci-visibility-test-3.js': ['ci visibility 3 can report tests 3'],
          },
        })

        const NUM_RETRIES_EFD = 3
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // no other tests are considered new
            const oldTests = tests.filter(test =>
              test.meta[TEST_SUITE] !== 'ci-visibility/test/efd-parallel/ci-visibility-test-4.js'
            )
            oldTests.forEach(test => {
              assert.ok(!(TEST_IS_NEW in test.meta))
            })

            assert.strictEqual(oldTests.length, 3)

            const newTests = tests.filter(test =>
              test.meta[TEST_SUITE] === 'ci-visibility/test/efd-parallel/ci-visibility-test-4.js'
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
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisEvpProxyConfig(receiver.port),
              TESTS_TO_RUN: 'test/efd-parallel/ci-visibility-test',
              RUN_IN_PARALLEL: 'true',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('does not detect new tests if known tests are faulty', async () => {
        receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
        receiver.setKnownTests({
          // invalid known tests
          'no-jest': {},
        })

        const NUM_RETRIES_EFD = 3
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, 4)
            const newTests = tests.filter(
              test => test.meta[TEST_IS_NEW] === 'true'
            )
            assert.strictEqual(newTests.length, 0)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisEvpProxyConfig(receiver.port),
              TESTS_TO_RUN: 'test/efd-parallel/ci-visibility-test',
              RUN_IN_PARALLEL: 'true',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      onlyLatestIt('works with snapshot tests', async () => {
        receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

        receiver.setKnownTests({
          jest: {
            'ci-visibility/test-early-flake-detection/jest-parallel-snapshot-1.js': [
              'parallel snapshot is not new',
              'parallel snapshot has snapshot and is known',
            ],
            'ci-visibility/test-early-flake-detection/jest-parallel-snapshot-2.js': [
              'parallel snapshot 2 is not new',
              'parallel snapshot 2 has snapshot and is known',
            ],
          },
        })

        const NUM_RETRIES_EFD = 3
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

            // 12 tests (6 per file): 8 new, 4 known
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            // 8*(1 test + 3 retries) + 4*(1 test) = 36
            assert.strictEqual(tests.length, 36)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            // 8*(3 retries)
            assert.strictEqual(retriedTests.length, 24)

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // 8*(1 test + 3 retries)
            assert.strictEqual(newTests.length, 32)

            const flakyTests = tests.filter(test => test.meta[TEST_NAME].includes('is flaky'))
            assert.strictEqual(flakyTests.length, 8)
            const failedFlakyTests = flakyTests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedFlakyTests.length, 4)
            const passedFlakyTests = flakyTests.filter(test => test.meta[TEST_STATUS] === 'pass')
            assert.strictEqual(passedFlakyTests.length, 4)
          })

        childProcess = exec(runTestsCommand, {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'ci-visibility/test-early-flake-detection/jest-parallel-snapshot',
            RUN_IN_PARALLEL: 'true',
            CI: '1', // needs to be run as CI so snapshots are not written
          },
        })

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })
    })

    it('does not flip exit code to 0 when a test suite fails to parse', async () => {
      receiver.setKnownTests({ jest: {} })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: { '5s': 3 },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      // Scenario: (1) test-suite-failed-to-run-parse.js fails to parse,
      // (2) occasionally-failing-test is new, flaky (pass/fail alternates), EFD would ignore its failures.
      const testAssertionsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end')?.content
          assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true', 'EFD should be running')

          // TODO: parsing errors do not report test suite
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const occasionallyFailingTests = tests.filter(t => t.resource?.includes('occasionally-failing-test'))
          const numRetries = 3 // slow_test_retries: { '5s': 3 }
          assert.strictEqual(occasionallyFailingTests.length, 1 + numRetries, '1 original + 3 EFD retries')
          const efdRetried = occasionallyFailingTests.filter(t =>
            t.meta?.[TEST_IS_RETRY] === 'true' && t.meta?.[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd
          )
          assert.strictEqual(efdRetried.length, numRetries, 'all but 1 should have EFD retry tag and reason')
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: '(test-management/test-suite-failed-to-run-parse|' +
              'test-early-flake-detection/occasionally-failing-test)',
            SHOULD_CHECK_RESULTS: '1',
          },
        }
      )

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), testAssertionsPromise])
      assert.strictEqual(exitCode, 1, 'exit code 1 when test suite fails to parse')
    })

    it('does not flip exit code to 0 when a test suite fails due to module resolution error', async () => {
      receiver.setKnownTests({ jest: {} })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: { '5s': 3 },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      // Scenario: (1) test-suite-failed-to-run-resolution.js fails to load,
      // (2) occasionally-failing-test is new, flaky, EFD would ignore its failures.
      const testAssertionsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end')?.content
          assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true', 'EFD should be running')

          const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
          const failedSuite = suites.find(s => s.meta?.[TEST_SUITE]?.includes('test-suite-failed-to-run-resolution'))
          assert.ok(failedSuite, 'failing test suite should be reported')
          assert.strictEqual(failedSuite.meta[TEST_STATUS], 'fail')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const occasionallyFailingTests = tests.filter(t => t.resource?.includes('occasionally-failing-test'))
          const numRetries = 3 // slow_test_retries: { '5s': 3 }
          assert.strictEqual(occasionallyFailingTests.length, 1 + numRetries, '1 original + 3 EFD retries')
          const efdRetried = occasionallyFailingTests.filter(t =>
            t.meta?.[TEST_IS_RETRY] === 'true' && t.meta?.[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd
          )
          assert.strictEqual(efdRetried.length, numRetries, 'all but 1 should have EFD retry tag and reason')
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: '(test-management/test-suite-failed-to-run-resolution|' +
              'test-early-flake-detection/occasionally-failing-test)',
            SHOULD_CHECK_RESULTS: '1',
          },
        }
      )

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), testAssertionsPromise])
      assert.strictEqual(exitCode, 1, 'exit code 1 when suite fails (resolution error, EFD)')
    })
  })

  context('flaky test retries', () => {
    it('sets final_status tag to test status reported to test framework on last retry', async () => {
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
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // test that passes without retry
          const passedWithoutRetry = tests.filter(test =>
            test.resource ===
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries will not retry passed tests'
          )[0]
          assert.strictEqual(passedWithoutRetry.meta[TEST_FINAL_STATUS], 'pass')

          // test that passes after second retry
          const eventuallyPassingTest = tests.filter(
            test => test.resource ===
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests'
          )
          eventuallyPassingTest.sort((a, b) => a.meta.start - b.meta.start).forEach((test, index) => {
            if (index < eventuallyPassingTest.length - 1) {
              assert.ok(!(TEST_FINAL_STATUS in test.meta))
            } else {
              assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
            }
          })

          // test that fails on every retry
          const neverPassingTest = tests.filter(
            test => test.resource ===
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests'
          )
          neverPassingTest.sort((a, b) => a.meta.start - b.meta.start).forEach((test, index) => {
            if (index < neverPassingTest.length - 1) {
              assert.ok(!(TEST_FINAL_STATUS in test.meta))
            } else {
              assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'fail')
            }
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'jest-flaky/flaky-',
          },
          stdio: 'inherit',
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    it('retries failed tests automatically', (done) => {
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
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 10)
          assertObjectContains(tests.map(test => test.resource), [
            // retries twice and passes
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            // does not retry
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries will not retry passed tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            // retries twice and passes
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            // retries up to 5 times and still fails
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
          ])

          const eventuallyPassingTest = tests.filter(
            test => test.resource ===
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests'
          )
          assert.strictEqual(eventuallyPassingTest.length, 3)
          assert.strictEqual(eventuallyPassingTest.filter(test => test.meta[TEST_STATUS] === 'fail').length, 2)
          assert.strictEqual(eventuallyPassingTest.filter(test => test.meta[TEST_STATUS] === 'pass').length, 1)
          assert.strictEqual(eventuallyPassingTest.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 2)
          assert.strictEqual(eventuallyPassingTest.filter(test =>
            test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 2)

          const neverPassingTest = tests.filter(
            test => test.resource ===
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests'
          )
          assert.strictEqual(neverPassingTest.length, 6)
          assert.strictEqual(neverPassingTest.filter(test => test.meta[TEST_STATUS] === 'fail').length, 6)
          assert.strictEqual(neverPassingTest.filter(test => test.meta[TEST_STATUS] === 'pass').length, 0)
          assert.strictEqual(neverPassingTest.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 5)
          assert.strictEqual(neverPassingTest.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 5)

          const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)

          const passingSuite = testSuites.find(
            suite => suite.resource === 'test_suite.ci-visibility/jest-flaky/flaky-passes.js'
          )
          assert.strictEqual(passingSuite.meta[TEST_STATUS], 'pass')

          const failedSuite = testSuites.find(
            suite => suite.resource === 'test_suite.ci-visibility/jest-flaky/flaky-fails.js'
          )
          assert.strictEqual(failedSuite.meta[TEST_STATUS], 'fail')
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'jest-flaky/flaky-',
          },
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
          enabled: false,
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 3)
          assertObjectContains(tests.map(test => test.resource), [
            // does not retry anything
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries will not retry passed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
          ])

          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'jest-flaky/flaky-',
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

    it('retries DD_CIVISIBILITY_FLAKY_RETRY_COUNT times', (done) => {
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
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 2)
          assert.strictEqual(
            tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr).length,
            2
          )

          assert.strictEqual(tests.length, 5)
          // only one retry
          assertObjectContains(tests.map(test => test.resource), [
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries will not retry passed tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
          ])
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'jest-flaky/flaky-',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })
  })

  context('dynamic instrumentation', () => {
    onlyLatestIt('does not activate DI if DD_TEST_FAILED_TEST_REPLAY_ENABLED is set to false', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          const hasDebugTags = Object.keys(retriedTest.meta)
            .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

          assert.strictEqual(hasDebugTags, false)
        })

      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          if (payloads.length > 0) {
            throw new Error('Unexpected logs')
          }
        }, 5000)

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-hit-breakpoint',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            DD_TEST_FAILED_TEST_REPLAY_ENABLED: 'false',
          },
        }
      )

      childProcess.on('exit', (code) => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.strictEqual(code, 0)
          done()
        }).catch(done)
      })
    })

    onlyLatestIt('does not activate DI if remote settings are disabled', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: false,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          const hasDebugTags = Object.keys(retriedTest.meta)
            .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

          assert.strictEqual(hasDebugTags, false)
        })
      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          if (payloads.length > 0) {
            throw new Error('Unexpected logs')
          }
        }, 5000)

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-hit-breakpoint',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
          },
        }
      )

      childProcess.on('exit', (code) => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.strictEqual(code, 0)
          done()
        }).catch(done)
      })
    })

    onlyLatestIt('runs retries with DI', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })
      let snapshotIdByTest, snapshotIdByLog
      let spanIdByTest, spanIdByLog, traceIdByTest, traceIdByLog
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          assert.strictEqual(retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED], 'true')

          assert.strictEqual(retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
            .endsWith('ci-visibility/dynamic-instrumentation/dependency.js'), true)
          assert.strictEqual(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 6)

          const snapshotIdKey = `${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX}`
          assert.ok(retriedTest.meta[snapshotIdKey])

          snapshotIdByTest = retriedTest.meta[snapshotIdKey]
          spanIdByTest = retriedTest.span_id.toString()
          traceIdByTest = retriedTest.trace_id.toString()

          const notRetriedTest = tests.find(test => test.meta[TEST_NAME].includes('is not retried'))

          assert.ok(!('DI_ERROR_DEBUG_INFO_CAPTURED' in notRetriedTest.meta))
        })

      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
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

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-hit-breakpoint',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
          },
        }
      )

      childProcess.on('exit', () => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.strictEqual(snapshotIdByTest, snapshotIdByLog)
          assert.strictEqual(spanIdByTest, spanIdByLog)
          assert.strictEqual(traceIdByTest, traceIdByLog)
          done()
        }).catch(done)
      })
    })

    onlyLatestIt('runs retries with DI in parallel mode', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })
      let snapshotIdByTest, snapshotIdByLog
      let spanIdByTest, spanIdByLog, traceIdByTest, traceIdByLog
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          assert.strictEqual(retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED], 'true')

          assert.strictEqual(retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
            .endsWith('ci-visibility/dynamic-instrumentation/dependency.js'), true)
          assert.strictEqual(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 6)

          const snapshotIdKey = `${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX}`
          assert.ok(retriedTest.meta[snapshotIdKey])

          snapshotIdByTest = retriedTest.meta[snapshotIdKey]
          spanIdByTest = retriedTest.span_id.toString()
          traceIdByTest = retriedTest.trace_id.toString()

          const notRetriedTest = tests.find(test => test.meta[TEST_NAME].includes('is not retried'))

          assert.ok(!('DI_ERROR_DEBUG_INFO_CAPTURED' in notRetriedTest.meta))
        })

      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          const [{ logMessage: [diLog] }] = payloads
          assertObjectContains(diLog, {
            ddsource: 'dd_debugger',
            level: 'error',
          })
          assert.ok(diLog.ddtags.includes('git.repository_url:'))
          assert.ok(diLog.ddtags.includes('git.commit.sha:'))
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

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/parallel-test-hit-breakpoint-',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            RUN_IN_PARALLEL: 'true',
          },
        }
      )

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
          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          const hasDebugTags = Object.keys(retriedTest.meta)
            .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

          assert.strictEqual(hasDebugTags, false)
        })
      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          if (payloads.length > 0) {
            throw new Error('Unexpected logs')
          }
        }, 5000)

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-not-hit-breakpoint',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
          },
        }
      )

      childProcess.on('exit', (code) => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.strictEqual(code, 0)
          done()
        }).catch(done)
      })
    })

    onlyLatestIt('does not wait for breakpoint for a passed test', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests
          // Duration is in nanoseconds, so 200 * 1e6 is 200ms
          assert.strictEqual(retriedTest.duration < 200 * 1e6, true)
        })

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-hit-breakpoint',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            TEST_SHOULD_PASS_AFTER_RETRY: '1',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })
  })

  // This happens when using office-addin-mock
  context('a test imports a file whose name includes a library we should bypass jest require cache for', () => {
    it('does not crash', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: false,
        early_flake_detection: {
          enabled: false,
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 1)
        })

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'office-addin-mock/test',
          },
        }
      )

      childProcess.on('exit', (code) => {
        eventsPromise.then(() => {
          assert.strictEqual(code, 0)
          done()
        }).catch(done)
      })
    })
  })

  context('known tests without early flake detection', () => {
    it('detects new tests without retrying them', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: false,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // no other tests are considered new
          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(oldTests.length, 1)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // no test has been retried
          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'test/ci-visibility-test' },
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
          ...getCiVisEvpProxyConfig(receiver.port),
          TESTS_TO_RUN: 'test/ci-visibility-test',
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
          jest: {
            suites: {
              'ci-visibility/test-management/test-attempt-to-fix-1.js': {
                tests: {
                  'attempt to fix tests can attempt to fix a test': {
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
        isParallel,
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
              assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
            }

            const resourceNames = tests.map(span => span.resource)

            assertObjectContains(resourceNames,
              [
                'ci-visibility/test-management/test-attempt-to-fix-1.js.attempt to fix tests can attempt to fix a test',
              ]
            )

            if (isParallel) {
              // Parallel mode in jest requires more than a single test suite
              // Here we check that the second test suite is actually running,
              // so we can be sure that parallel mode is on
              const parallelTestName = 'ci-visibility/test-management/test-attempt-to-fix-2.js.' +
                'attempt to fix tests 2 can attempt to fix a test'
              assertObjectContains(resourceNames, [parallelTestName])
            }

            const retriedTests = tests.filter(
              test => test.meta[TEST_NAME] === 'attempt to fix tests can attempt to fix a test'
            )

            for (let i = 0; i < retriedTests.length; i++) {
              const test = retriedTests[i]
              if (!isAttemptToFix) {
                assert.ok(!(TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX in test.meta))
                assert.ok(!(TEST_IS_RETRY in test.meta))
                assert.ok(!(TEST_RETRY_REASON in test.meta))
                continue
              }

              if (isQuarantined) {
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              }

              if (isDisabled) {
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
              }

              const isFirstAttempt = i === 0
              const isLastAttempt = i === retriedTests.length - 1
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')

              if (isFirstAttempt) {
                assert.ok(!(TEST_IS_RETRY in test.meta))
                assert.ok(!(TEST_RETRY_REASON in test.meta))
              } else {
                assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
              }

              if (isLastAttempt) {
                if (shouldAlwaysPass) {
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
                  assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
                } else if (shouldFailSometimes) {
                  assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                  assert.strictEqual(test.meta[TEST_FINAL_STATUS], isQuarantined ? 'skip' : 'fail')
                } else {
                  assert.strictEqual(test.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                  assert.strictEqual(test.meta[TEST_FINAL_STATUS], isQuarantined ? 'skip' : 'fail')
                }
              } else {
                assert.ok(!(TEST_FINAL_STATUS in test.meta))
              }
            }
          })

      /**
       * @param {() => void} done
       * @param {{
       *   isAttemptToFix?: boolean,
       *   isQuarantined?: boolean,
       *   isDisabled?: boolean,
       *   shouldAlwaysPass?: boolean,
       *   shouldFailSometimes?: boolean,
       *   extraEnvVars?: Record<string, string>,
       *   isParallel?: boolean
       * }} [options]
       */
      const runAttemptToFixTest = (done, {
        isAttemptToFix,
        isQuarantined,
        isDisabled,
        shouldAlwaysPass,
        shouldFailSometimes,
        extraEnvVars = {},
        isParallel = false,
      } = {}) => {
        let stdout = ''
        const testAssertionsPromise = getTestAssertions({
          isAttemptToFix,
          isParallel,
          isQuarantined,
          isDisabled,
          shouldAlwaysPass,
          shouldFailSometimes,
        })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-attempt-to-fix-1',
              SHOULD_CHECK_RESULTS: '1',
              ...(shouldAlwaysPass ? { SHOULD_ALWAYS_PASS: '1' } : {}),
              ...(shouldFailSometimes ? { SHOULD_FAIL_SOMETIMES: '1' } : {}),
              ...extraEnvVars,
            },
          }
        )

        childProcess.stderr?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        childProcess.stdout?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        childProcess.on('exit', exitCode => {
          testAssertionsPromise.then(() => {
            assert.match(stdout, /I am running when attempt to fix/)
            if (isQuarantined || shouldAlwaysPass || isDisabled) {
              // even though a test fails, the exit code is 0 because the test is quarantined
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

      it('attempt to fix takes precedence over ATR', async () => {
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: 2 },
          flaky_test_retries_enabled: true,
        })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/jest-flaky/flaky-fails.js': {
                tests: {
                  'test-flaky-test-retries can retry failed tests': {
                    properties: {
                      attempt_to_fix: true,
                    },
                  },
                },
              },
            },
          },
        })
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 3)
            const atfRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atf)
            const atrRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)
            assert.strictEqual(atfRetries.length, 2)
            assert.strictEqual(atrRetries.length, 0)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'jest-flaky/flaky-fails.js',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('preserves test errors when ATR retry suppression is active due to attempt to fix', async () => {
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: 2 },
          flaky_test_retries_enabled: true,
        })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/jest-flaky/flaky-fails.js': {
                tests: {
                  'test-flaky-test-retries can retry failed tests': {
                    properties: {
                      attempt_to_fix: true,
                    },
                  },
                },
              },
            },
          },
        })
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')

            // Verify that all failing tests have error messages preserved
            // even though ATR retry suppression is active (due to attempt to fix)
            failingTests.forEach(test => {
              assert.ok(
                ERROR_MESSAGE in test.meta,
                'Test error message should be preserved when ATR retry suppression is active due to attempt to fix'
              )
              assert.ok(test.meta[ERROR_MESSAGE].length > 0, 'Test error message should not be empty')
              // The error should contain information about the assertion failure
              assert.match(test.meta[ERROR_MESSAGE], /deepStrictEqual|Expected|actual/i)
            })

            // Verify attempt to fix is active (ATR should be suppressed)
            const atfRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atf)
            const atrRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)
            assert.strictEqual(atfRetries.length, 2)
            assert.strictEqual(atrRetries.length, 0)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'jest-flaky/flaky-fails.js',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('attempt to fix takes precedence over EFD for new tests', async () => {
        const NUM_RETRIES_EFD = 2
        receiver.setKnownTests({ jest: {} })
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: 2 },
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/jest-flaky/flaky-fails.js': {
                tests: {
                  'test-flaky-test-retries can retry failed tests': {
                    properties: {
                      attempt_to_fix: true,
                    },
                  },
                },
              },
            },
          },
        })
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 3)
            const atfRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atf)
            const efdRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd)
            assert.strictEqual(atfRetries.length, 2)
            assert.strictEqual(efdRetries.length, 0)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'jest-flaky/flaky-fails.js',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('resets mock state between attempt to fix retries', async () => {
        const NUM_RETRIES = 3
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: NUM_RETRIES } })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-attempt-to-fix-with-mock.js': {
                tests: {
                  'attempt to fix tests with mock resets mock state between retries': {
                    properties: {
                      attempt_to_fix: true,
                    },
                  },
                },
              },
            },
          },
        })

        let stdout = ''
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // Should have 1 original + NUM_RETRIES retry attempts
            const mockTests = tests.filter(
              test => test.meta[TEST_NAME] === 'attempt to fix tests with mock resets mock state between retries'
            )
            assert.strictEqual(mockTests.length, NUM_RETRIES + 1)

            // All tests should pass because mock state is reset between retries
            for (const test of mockTests) {
              assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            }

            // Last attempt should be marked as attempt_to_fix_passed
            const lastTest = mockTests[mockTests.length - 1]
            assert.strictEqual(lastTest.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-attempt-to-fix-with-mock',
            },
          }
        )

        childProcess.stdout?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        childProcess.stderr?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        const [exitCode] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])

        // Verify the test actually ran
        assert.match(stdout, /I am running attempt to fix with mock/)

        // All retries should pass, so exit code should be 0
        assert.strictEqual(exitCode[0], 0)
      })

      it('does not fail retry if a test is quarantined', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-attempt-to-fix-1.js': {
                tests: {
                  'attempt to fix tests can attempt to fix a test': {
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

        runAttemptToFixTest(done, { isAttemptToFix: true, isQuarantined: true })
      })

      it('does not fail retry if a test is disabled', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-attempt-to-fix-1.js': {
                tests: {
                  'attempt to fix tests can attempt to fix a test': {
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

        runAttemptToFixTest(done, { isAttemptToFix: true, isDisabled: true })
      })

      onlyLatestIt('works with snapshot tests', async () => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-snapshot-attempt-to-fix-1.js': {
                tests: {
                  'attempt to fix snapshot is flaky': {
                    properties: {
                      attempt_to_fix: true,
                    },
                  },
                },
              },
            },
          },
        })
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')

            assert.strictEqual(tests.length, 4)
            const retriedTests = tests.filter(
              test => test.meta[TEST_IS_RETRY] === 'true'
            )

            assert.strictEqual(retriedTests.length, 3)
            const failedTests = tests.filter(
              test => test.meta[TEST_STATUS] === 'fail'
            )
            assert.strictEqual(failedTests.length, 2)

            const passedTests = tests.filter(
              test => test.meta[TEST_STATUS] === 'pass'
            )
            assert.strictEqual(passedTests.length, 2)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-snapshot-attempt-to-fix-1',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      onlyLatestIt('works with snapshot tests when every attempt passes', async () => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-snapshot-attempt-to-fix-1.js': {
                tests: {
                  'attempt to fix snapshot is flaky': {
                    properties: {
                      attempt_to_fix: true,
                    },
                  },
                },
              },
            },
          },
        })
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')

            assert.strictEqual(tests.length, 4)

            const passedTests = tests.filter(
              test => test.meta[TEST_STATUS] === 'pass'
            )
            assert.strictEqual(passedTests.length, 4)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-snapshot-attempt-to-fix-1',
              SHOULD_PASS_ALWAYS: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
        assert.strictEqual(exitCode, 0)
      })

      onlyLatestIt('works with image snapshot tests', async () => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-snapshot-image.js': {
                tests: {
                  'snapshot can match': {
                    properties: {
                      attempt_to_fix: true,
                    },
                  },
                },
              },
            },
          },
        })
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')

            assert.strictEqual(tests.length, 4)
            const retriedTests = tests.filter(
              test => test.meta[TEST_IS_RETRY] === 'true'
            )

            assert.strictEqual(retriedTests.length, 3)
            const failedTests = tests.filter(
              test => test.meta[TEST_STATUS] === 'fail'
            )
            assert.strictEqual(failedTests.length, 2)

            const passedTests = tests.filter(
              test => test.meta[TEST_STATUS] === 'pass'
            )
            assert.strictEqual(passedTests.length, 2)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-snapshot-image',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      context('parallel mode', () => {
        it('can attempt to fix in parallel mode', (done) => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

          runAttemptToFixTest(
            done,
            {
              isAttemptToFix: true,
              isParallel: true,
              extraEnvVars: {
                // we need to run more than 1 suite for parallel mode to kick in
                TESTS_TO_RUN: 'test-management/test-attempt-to-fix',
                RUN_IN_PARALLEL: 'true',
              },
            }
          )
        })

        onlyLatestIt('works with snapshot tests', async () => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

          receiver.setTestManagementTests({
            jest: {
              suites: {
                'ci-visibility/test-management/test-snapshot-attempt-to-fix-1.js': {
                  tests: {
                    'attempt to fix snapshot is flaky': {
                      properties: {
                        attempt_to_fix: true,
                      },
                    },
                  },
                },
                'ci-visibility/test-management/test-snapshot-attempt-to-fix-2.js': {
                  tests: {
                    'attempt to fix snapshot 2 is flaky': {
                      properties: {
                        attempt_to_fix: true,
                      },
                    },
                  },
                },
              },
            },
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const testSession = events.find(event => event.type === 'test_session_end').content

              assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')

              assert.strictEqual(tests.length, 8)
              const retriedTests = tests.filter(
                test => test.meta[TEST_IS_RETRY] === 'true'
              )

              assert.strictEqual(retriedTests.length, 6)
              const failedTests = tests.filter(
                test => test.meta[TEST_STATUS] === 'fail'
              )
              assert.strictEqual(failedTests.length, 4)

              const passedTests = tests.filter(
                test => test.meta[TEST_STATUS] === 'pass'
              )
              assert.strictEqual(passedTests.length, 4)
            })

          childProcess = exec(
            runTestsCommand,
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TESTS_TO_RUN: 'test-management/test-snapshot-attempt-to-fix-',
                RUN_IN_PARALLEL: 'true',
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
          ])
        })
      })
    })

    context('disabled', () => {
      beforeEach(() => {
        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-disabled-1.js': {
                tests: {
                  'disable tests can disable a test': {
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

      const getTestAssertions = (isDisabling, isParallel) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isDisabling) {
              assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
            } else {
              assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
            }

            const resourceNames = tests.map(span => span.resource)

            assertObjectContains(resourceNames,
              [
                'ci-visibility/test-management/test-disabled-1.js.disable tests can disable a test',
              ]
            )

            if (isParallel) {
              // Parallel mode in jest requires more than a single test suite
              // Here we check that the second test suite is actually running,
              // so we can be sure that parallel mode is on
              assertObjectContains(resourceNames, [
                'ci-visibility/test-management/test-disabled-2.js.disable tests 2 can disable a test',
              ])
            }

            const skippedTest = tests.find(
              test => test.meta[TEST_NAME] === 'disable tests can disable a test'
            )

            if (isDisabling) {
              assert.strictEqual(skippedTest.meta[TEST_STATUS], 'skip')
              assert.strictEqual(skippedTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
            } else {
              assert.strictEqual(skippedTest.meta[TEST_STATUS], 'fail')
              assert.ok(!(TEST_MANAGEMENT_IS_DISABLED in skippedTest.meta))
            }
          })

      const runDisableTest = (done, isDisabling, extraEnvVars = {}, isParallel = false) => {
        let stdout = ''
        const testAssertionsPromise = getTestAssertions(isDisabling, isParallel)

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-disabled-1',
              SHOULD_CHECK_RESULTS: '1',
              ...extraEnvVars,
            },
          }
        )

        // jest uses stderr to output logs
        childProcess.stderr?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        childProcess.on('exit', exitCode => {
          testAssertionsPromise.then(() => {
            if (isDisabling) {
              assert.doesNotMatch(stdout, /I am running/)
              // even though a test fails, the exit code is 0 because the test is disabled
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

        runDisableTest(done, true)
      })

      it('pass if disable is not enabled', (done) => {
        receiver.setSettings({ test_management: { enabled: false } })

        runDisableTest(done, false)
      })

      it('does not enable disable tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runDisableTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
      })

      it('can disable in parallel mode', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runDisableTest(
          done,
          true,
          {
            // we need to run more than 1 suite for parallel mode to kick in
            TESTS_TO_RUN: 'test-management/test-disabled',
            RUN_IN_PARALLEL: 'true',
          },
          true
        )
      })

      it('sets final_status tag to skip for disabled tests', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const disabledTest = tests.find(
              test => test.meta[TEST_NAME] === 'disable tests can disable a test'
            )

            assert.strictEqual(disabledTest.meta[TEST_STATUS], 'skip')
            assert.strictEqual(disabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
            assert.strictEqual(disabledTest.meta[TEST_FINAL_STATUS], 'skip')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-disabled-1',
            },
            stdio: 'inherit',
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })
    })

    context('quarantine', () => {
      beforeEach(() => {
        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-quarantine-1.js': {
                tests: {
                  'quarantine tests can quarantine a test': {
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

      const getTestAssertions = (isQuarantining, isParallel) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isQuarantining) {
              assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
              // test session is passed even though a test fails because the test is quarantined
              assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
            } else {
              assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
              assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
            }

            const resourceNames = tests.map(span => span.resource)

            assertObjectContains(resourceNames,
              [
                'ci-visibility/test-management/test-quarantine-1.js.quarantine tests can quarantine a test',
                'ci-visibility/test-management/test-quarantine-1.js.quarantine tests can pass normally',
              ]
            )

            if (isParallel) {
              // Parallel mode in jest requires more than a single test suite
              // Here we check that the second test suite is actually running,
              // so we can be sure that parallel mode is on
              assertObjectContains(resourceNames, [
                'ci-visibility/test-management/test-quarantine-2.js.quarantine tests 2 can quarantine a test',
                'ci-visibility/test-management/test-quarantine-2.js.quarantine tests 2 can pass normally',
              ])
            }

            const failedTest = tests.find(
              test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
            )
            assert.strictEqual(failedTest.meta[TEST_STATUS], 'fail')

            if (isQuarantining) {
              assert.strictEqual(failedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            } else {
              assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in failedTest.meta))
            }
          })

      const runQuarantineTest = async (isQuarantining, extraEnvVars = {}, isParallel = false) => {
        let stdout = ''
        const testAssertionsPromise = getTestAssertions(isQuarantining, isParallel)

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-quarantine-1',
              SHOULD_CHECK_RESULTS: '1',
              ...extraEnvVars,
            },
          }
        )

        // jest uses stderr to output logs
        childProcess.stderr?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), testAssertionsPromise])

        // it runs regardless of quarantine status
        assert.match(stdout, /I am running when quarantined/)
        if (isQuarantining) {
          // even though a test fails, the exit code is 0 because the test is quarantined
          assert.strictEqual(exitCode, 0)
          // Verify Datadog Test Optimization message is shown when exit code is flipped
          assert.match(stdout, /Datadog Test Optimization/)
          assert.match(stdout, /\d+ test failure\(s\) were ignored\. Exit code set to 0\./)
          assert.match(stdout, /Quarantine/)
          assert.match(stdout, /test-quarantine-1.*›.*quarantine tests can quarantine a test/)
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

      it('can quarantine in parallel mode', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        await runQuarantineTest(
          true,
          {
            // we need to run more than 1 suite for parallel mode to kick in
            TESTS_TO_RUN: 'test-management/test-quarantine',
            RUN_IN_PARALLEL: 'true',
          },
          true
        )
      })

      it('fails if a non-quarantined test fails even when a quarantined test also fails', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        // Only quarantine one of the failing tests, leaving another failing test non-quarantined
        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-partial-quarantine.js': {
                tests: {
                  'partial quarantine tests quarantined failing test': {
                    properties: {
                      quarantined: true,
                    },
                  },
                  // Note: 'partial quarantine tests non-quarantined failing test' is NOT quarantined
                },
              },
            },
          },
        })

        const testAssertionsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            // Session should be marked as failed because a non-quarantined test failed
            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
            assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')

            // Verify the quarantined test has the quarantine tag
            const quarantinedTest = tests.find(
              test => test.meta[TEST_NAME] === 'partial quarantine tests quarantined failing test'
            )
            assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
            assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

            // Verify the non-quarantined test does NOT have the quarantine tag
            const nonQuarantinedTest = tests.find(
              test => test.meta[TEST_NAME] === 'partial quarantine tests non-quarantined failing test'
            )
            assert.strictEqual(nonQuarantinedTest.meta[TEST_STATUS], 'fail')
            assert.ok(
              !(TEST_MANAGEMENT_IS_QUARANTINED in nonQuarantinedTest.meta),
              'Non-quarantined test should not have quarantine tag'
            )
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-partial-quarantine',
              SHOULD_CHECK_RESULTS: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), testAssertionsPromise])

        // Exit code should be 1 because a non-quarantined test failed
        assert.strictEqual(exitCode, 1)
      })

      it('sets final_status tag to skip for quarantined tests', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const quarantinedTest = tests.find(
              test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
            )
            // Quarantined tests still run and report their actual status
            assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
            assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')

            const passingTest = tests.find(
              test => test.meta[TEST_NAME] === 'quarantine tests can pass normally'
            )
            assert.strictEqual(passingTest.meta[TEST_STATUS], 'pass')
            assert.strictEqual(passingTest.meta[TEST_FINAL_STATUS], 'pass')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-quarantine-1',
            },
            stdio: 'inherit',
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('quarantine prevents session failure when ATR is also enabled', async () => {
        receiver.setSettings({
          test_management: { enabled: true },
          flaky_test_retries_enabled: true,
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            // Session should pass because the only failing test is quarantined
            assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')

            // All executions of the quarantined test should be tagged as quarantined
            const quarantinedTests = tests.filter(
              test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
            )
            assert.ok(quarantinedTests.length > 1, 'quarantined test should have been retried by ATR')
            for (const test of quarantinedTests) {
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            }

            // The last execution should have final_status = skip
            const lastExecution = quarantinedTests[quarantinedTests.length - 1]
            assert.strictEqual(lastExecution.meta[TEST_FINAL_STATUS], 'skip')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-quarantine-1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])

        // Exit code should be 0 because the failing test is quarantined
        assert.strictEqual(exitCode, 0)
      })

      it('session passes when EFD flaky retries and quarantine failures are combined', async () => {
        const NUM_RETRIES_EFD = 3

        // The new flaky test is NOT in known tests so EFD will retry it
        receiver.setKnownTests({ jest: {} })

        receiver.setSettings({
          test_management: { enabled: true },
          early_flake_detection: {
            enabled: true,
            slow_test_retries: { '5s': NUM_RETRIES_EFD },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        // Only quarantine the always-failing test
        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-efd-and-quarantine.js': {
                tests: {
                  'efd and quarantine is a quarantined failing test': {
                    properties: {
                      quarantined: true,
                    },
                  },
                },
              },
            },
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            // Session should pass:
            // - The new flaky test has at least one passing EFD retry (so EFD can ignore its failures)
            // - The quarantined test is quarantined (so quarantine can ignore its failure)
            assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')

            // Verify the quarantined test is tagged
            const quarantinedTests = tests.filter(
              test => test.meta[TEST_NAME] === 'efd and quarantine is a quarantined failing test'
            )
            assert.ok(quarantinedTests.length >= 1)
            for (const test of quarantinedTests) {
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            }

            // Verify the new flaky test has EFD retries (at least original + retries)
            const flakyTests = tests.filter(
              test => test.meta[TEST_NAME] === 'efd and quarantine is a new flaky test'
            )
            assert.ok(flakyTests.length > 1, 'flaky test should have been retried by EFD')

            // At least one EFD retry should have passed
            const passingFlakyTests = flakyTests.filter(t => t.meta[TEST_STATUS] === 'pass')
            assert.ok(passingFlakyTests.length > 0, 'at least one EFD retry should pass')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/test-efd-and-quarantine',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])

        // Exit code should be 0 because:
        // - The flaky test has at least one passing retry (EFD considers it OK)
        // - The always-failing test is quarantined
        assert.strictEqual(exitCode, 0)
      })

      it('does not flip exit code to 0 when a test suite fails to parse', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        // Scenario: (1) test-suite-failed-to-run-parse.js fails to parse so no tests run,
        // (2) test-quarantine-1.js parses and runs, its only failing test is quarantined.
        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-quarantine-1.js': {
                tests: {
                  'quarantine tests can quarantine a test': {
                    properties: {
                      quarantined: true,
                    },
                  },
                },
              },
            },
          },
        })

        const testAssertionsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end')?.content
            assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true', 'test management should be running')

            // TODO: parsing errors do not report test suite
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const quarantine1Tests = tests.filter(t => t.resource?.includes('test-quarantine-1'))
            const withQuarantineTag = quarantine1Tests.filter(t => t.meta?.[TEST_MANAGEMENT_IS_QUARANTINED] === 'true')
            assert.strictEqual(withQuarantineTag.length, 1, 'only one test from test-quarantine-1 has quarantine tag')
            assert.strictEqual(withQuarantineTag[0].meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/(test-suite-failed-to-run-parse|test-quarantine-1)',
              SHOULD_CHECK_RESULTS: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), testAssertionsPromise])
        assert.strictEqual(exitCode, 1, 'exit code should be 1 when a test suite fails to parse')
      })

      it('does not flip exit code to 0 when a test suite fails due to module resolution error', async () => {
        receiver.setSettings({ test_management: { enabled: true } })

        // Scenario: (1) test-suite-failed-to-run-resolution.js fails to load (invalid require),
        // (2) test-quarantine-1.js parses and runs, its only failing test is quarantined.
        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-management/test-quarantine-1.js': {
                tests: {
                  'quarantine tests can quarantine a test': {
                    properties: {
                      quarantined: true,
                    },
                  },
                },
              },
            },
          },
        })

        const testAssertionsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end')?.content
            assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true', 'test management should be running')

            const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
            const failedSuite = suites.find(s => s.meta?.[TEST_SUITE]?.includes('test-suite-failed-to-run-resolution'))
            assert.ok(failedSuite, 'failing test suite should be reported')
            assert.strictEqual(failedSuite.meta[TEST_STATUS], 'fail')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const quarantine1Tests = tests.filter(t => t.resource?.includes('test-quarantine-1'))
            const withQuarantineTag = quarantine1Tests.filter(t => t.meta?.[TEST_MANAGEMENT_IS_QUARANTINED] === 'true')
            assert.strictEqual(withQuarantineTag.length, 1, 'only one test from test-quarantine-1 has quarantine tag')
            assert.strictEqual(withQuarantineTag[0].meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-management/(test-suite-failed-to-run-resolution|test-quarantine-1)',
              SHOULD_CHECK_RESULTS: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), testAssertionsPromise])
        assert.strictEqual(exitCode, 1, 'exit code 1 when suite fails (resolution error)')
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
          assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          // it is not retried
          assert.strictEqual(tests.length, 1)
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: 'test-management/test-attempt-to-fix-1',
          DD_TRACE_DEBUG: '1',
        },
      })

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
    it('adds capabilities to tests', (done) => {
      const eventsPromise = receiver
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
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_TEST_SESSION_NAME: 'my-test-session-name',
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

  context('custom tagging', () => {
    it('does detect custom tags in the tests', (done) => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const test = events.find(event => event.type === 'test').content

          assertObjectContains(test, {
            meta: {
              'custom_tag.beforeEach': 'true',
              'custom_tag.it': 'true',
              'custom_tag.afterEach': 'true',
            },
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'ci-visibility/test-custom-tags',
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

  context('impacted tests', () => {
    const NUM_RETRIES = 3

    beforeEach(() => {
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test-impacted-test/test-impacted-1.js': [
            'impacted tests can pass normally',
          ],
          'ci-visibility/test-impacted-test/test-impacted-2.js': [
            'impacted tests 2 can pass normally',
          ],
        },
      })
    })

    // Modify test file to mark it as impacted
    before(() => {
      execSync('git checkout -b feature-branch', { cwd, stdio: 'ignore' })

      fs.writeFileSync(
        path.join(cwd, 'ci-visibility/test-impacted-test/test-impacted-1.js'),
        `const assert = require('assert')

         describe('impacted tests', () => {
          it('can pass normally', () => {
            assert.strictEqual(1 + 2, 4)
          })
          it('can fail', () => {
            assert.strictEqual(1 + 2, 4)
          })
         })`
      )
      execSync('git add ci-visibility/test-impacted-test/test-impacted-1.js', { cwd, stdio: 'ignore' })

      // Also modify test file with mock for mock state reset test
      fs.writeFileSync(
        path.join(cwd, 'ci-visibility/test-impacted-test/test-impacted-with-mock.js'),
        `'use strict'

         const mockFn = jest.fn()

         describe('impacted tests with mock', () => {
           it('resets mock state between retries', () => {
             console.log('I am running impacted test with mock')
             mockFn()
             expect(mockFn).toHaveBeenCalledTimes(1)
           })
         })`
      )
      execSync('git add ci-visibility/test-impacted-test/test-impacted-with-mock.js', { cwd, stdio: 'ignore' })

      execSync('git commit -m "modify test-impacted-1.js"', { cwd, stdio: 'ignore' })
    })

    after(() => {
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
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
          }

          const resourceNames = tests.map(span => span.resource)

          assertObjectContains(resourceNames,
            [
              'ci-visibility/test-impacted-test/test-impacted-1.js.impacted tests can pass normally',
              'ci-visibility/test-impacted-test/test-impacted-1.js.impacted tests can fail',
            ]
          )

          if (isParallel) {
            // Parallel mode in jest requires more than a single test suite
            // Here we check that the second test suite is actually running,
            // so we can be sure that parallel mode is on
            assertObjectContains(resourceNames, [
              'ci-visibility/test-impacted-test/test-impacted-2.js.impacted tests 2 can pass normally',
              'ci-visibility/test-impacted-test/test-impacted-2.js.impacted tests 2 can fail',
            ])
          }

          const impactedTests = tests.filter(test =>
            test.meta[TEST_SOURCE_FILE] === 'ci-visibility/test-impacted-test/test-impacted-1.js' &&
            test.meta[TEST_NAME] === 'impacted tests can pass normally')

          if (isEfd) {
            assert.strictEqual(impactedTests.length, NUM_RETRIES + 1) // Retries + original test
          } else {
            assert.strictEqual(impactedTests.length, 1)
          }

          for (const impactedTest of impactedTests) {
            if (isModified) {
              assert.strictEqual(impactedTest.meta[TEST_IS_MODIFIED], 'true')
            } else {
              assert.ok(!(TEST_IS_MODIFIED in impactedTest.meta))
            }
            if (isNew) {
              assert.strictEqual(impactedTest.meta[TEST_IS_NEW], 'true')
            } else {
              assert.ok(!(TEST_IS_NEW in impactedTest.meta))
            }
          }

          if (isEfd) {
            const retriedTests = tests.filter(test =>
              test.meta[TEST_IS_RETRY] === 'true' &&
              test.meta[TEST_NAME] !== 'impacted tests can pass normally'
            )
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

    const runImpactedTest = (
      done,
      { isModified, isEfd = false, isParallel = false, isNew = false },
      extraEnvVars = {}
    ) => {
      const testAssertionsPromise = getTestAssertions({ isModified, isEfd, isParallel, isNew })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'test-impacted-test/test-impacted-1',
            GITHUB_BASE_REF: '',
            ...extraEnvVars,
          },
        }
      )

      childProcess.on('exit', () => {
        testAssertionsPromise.then(done).catch(done)
      })
    }

    context('test is not new', () => {
      it('should be detected as impacted', (done) => {
        receiver.setSettings({ impacted_tests_enabled: true })

        runImpactedTest(done, { isModified: true })
      })

      it('attempt to fix takes precedence over EFD for impacted tests', async () => {
        const NUM_RETRIES_EFD = 2
        receiver.setSettings({
          impacted_tests_enabled: true,
          test_management: { enabled: true, attempt_to_fix_retries: 2 },
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })
        receiver.setTestManagementTests({
          jest: {
            suites: {
              'ci-visibility/test-impacted-test/test-impacted-1.js': {
                tests: {
                  'impacted tests can pass normally': {
                    properties: {
                      attempt_to_fix: true,
                    },
                  },
                },
              },
            },
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const impactedAtfTests = tests.filter(test =>
              test.meta[TEST_SOURCE_FILE] === 'ci-visibility/test-impacted-test/test-impacted-1.js' &&
              test.meta[TEST_NAME] === 'impacted tests can pass normally'
            )

            assert.strictEqual(impactedAtfTests.length, 3)
            const atfRetries = impactedAtfTests.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atf
            )
            const efdRetries = impactedAtfTests.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd
            )
            assert.strictEqual(atfRetries.length, 2)
            assert.strictEqual(efdRetries.length, 0)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-impacted-test/test-impacted-1',
              GITHUB_BASE_REF: '',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
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

      it('should be detected as impacted in parallel mode', (done) => {
        receiver.setSettings({ impacted_tests_enabled: true })

        runImpactedTest(done, { isModified: true, isParallel: true }, {
          TESTS_TO_RUN: 'test-impacted-test/test-impacted',
          RUN_IN_PARALLEL: 'true',
        })
      })
    })

    context('test is new', () => {
      it('should be retried and marked both as new and modified', (done) => {
        receiver.setKnownTests({ jest: {} })
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
        runImpactedTest(done, { isModified: true, isEfd: true, isNew: true })
      })

      it('resets mock state between impacted test retries', async () => {
        // Test is considered new (not in known tests)
        receiver.setKnownTests({ jest: {} })
        receiver.setSettings({
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        let stdout = ''
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // Should have 1 original + NUM_RETRIES retry attempts
            const mockTests = tests.filter(
              test => test.meta[TEST_NAME] === 'impacted tests with mock resets mock state between retries'
            )
            assert.strictEqual(mockTests.length, NUM_RETRIES + 1)

            // All tests should pass because mock state is reset between retries
            for (const test of mockTests) {
              assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            }

            // All should be marked as modified (impacted)
            for (const test of mockTests) {
              assert.strictEqual(test.meta[TEST_IS_MODIFIED], 'true')
            }
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'test-impacted-test/test-impacted-with-mock',
              GITHUB_BASE_REF: '',
            },
          }
        )

        childProcess.stdout?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        childProcess.stderr?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        const [exitCode] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])

        // Verify the test actually ran
        assert.match(stdout, /I am running impacted test with mock/)

        // All retries should pass, so exit code should be 0
        assert.strictEqual(exitCode[0], 0)
      })
    })
  })

  context('winston mocking', () => {
    it('should allow winston to be mocked and verify createLogger is called', async () => {
      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'jest-mock-bypass-require/winston-mock-test',
            SHOULD_CHECK_RESULTS: '1',
          },
        }
      )

      const [code] = await once(childProcess, 'exit')
      assert.strictEqual(code, 0, `Jest should pass but failed with code ${code}`)
    })
  })

  context('fast-check', () => {
    onlyLatestIt('should remove seed from the test name if @fast-check/jest is used in the test', async () => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 1)
          assert.strictEqual(tests[0].meta[TEST_NAME], 'fast check will not include seed')
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'jest-fast-check/jest-fast-check',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    onlyLatestIt('should not remove seed if @fast-check/jest is not used', async () => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 1)
          assert.strictEqual(tests[0].meta[TEST_NAME], 'fast check with seed should include seed (with seed=12)')
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'jest-fast-check/jest-no-fast-check',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })
  })

  it('does not crash with mocks that are not dependencies', async () => {
    let testOutput = ''

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: 'jest-package-mock/non-dependency-mock-test',
          SETUP_FILES_AFTER_ENV: '<rootDir>/ci-visibility/jest-setup-files-after-env.js',
          RUN_IN_PARALLEL: 'true',
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
      receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
          assert.strictEqual(tests.length, 6)
          assert.strictEqual(testSuites.length, 6)
          assert.strictEqual(testSuites.every(suite => suite.meta[TEST_STATUS] === 'pass'), true)
          assert.strictEqual(tests.every(test => test.meta[TEST_STATUS] === 'pass'), true)
        }),
    ])
    assert.doesNotMatch(testOutput, /Cannot find module/)
    assert.match(testOutput, /6 passed/)
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

          assert.strictEqual(coverageReport.coverageFile.name, 'coverage')
          assert.ok(coverageReport.coverageFile.content.includes('SF:')) // LCOV format

          assert.strictEqual(coverageReport.eventFile.name, 'event')
          assert.strictEqual(coverageReport.eventFile.content.type, 'coverage_report')
          assert.strictEqual(coverageReport.eventFile.content.format, 'lcov')
          assert.strictEqual(coverageReport.eventFile.content[GIT_COMMIT_SHA], gitCommitSha)
          assert.strictEqual(coverageReport.eventFile.content[GIT_REPOSITORY_URL], gitRepositoryUrl)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            ENABLE_CODE_COVERAGE: 'true',
            COVERAGE_REPORTERS: 'lcov',
            COLLECT_COVERAGE_FROM: 'ci-visibility/test/*.js',
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

    it('sends coverage_upload.request telemetry metric when coverage is uploaded', async () => {
      receiver.setSettings({
        coverage_report_upload_enabled: true,
      })
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

      const telemetryPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/apmtelemetry'), (payloads) => {
          const telemetryMetrics = payloads.flatMap(({ payload }) => payload.payload.series)

          const coverageUploadMetric = telemetryMetrics.find(
            ({ metric }) => metric === TELEMETRY_COVERAGE_UPLOAD
          )

          assert.ok(coverageUploadMetric, 'coverage_upload.request telemetry metric should be sent')
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
            ENABLE_CODE_COVERAGE: 'true',
            COVERAGE_REPORTERS: 'lcov',
            COLLECT_COVERAGE_FROM: 'ci-visibility/test/*.js',
            DD_GIT_COMMIT_SHA: gitCommitSha,
            DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        telemetryPromise,
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

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            ENABLE_CODE_COVERAGE: 'true',
            COVERAGE_REPORTERS: 'lcov',
            COLLECT_COVERAGE_FROM: 'ci-visibility/test/*.js',
            DD_GIT_COMMIT_SHA: gitCommitSha,
            DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
          },
        }
      )

      await once(childProcess, 'exit')

      assert.strictEqual(coverageReportUploaded, false, 'coverage report should not be uploaded')
    })
  })
})
