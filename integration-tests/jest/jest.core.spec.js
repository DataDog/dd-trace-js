'use strict'

const assert = require('node:assert/strict')

const { once } = require('node:events')
const { fork, exec } = require('child_process')
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
  TEST_ITR_TESTS_SKIPPED,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_SUITE,
  TEST_STATUS,
  TEST_SKIPPED_BY_ITR,
  TEST_ITR_SKIPPING_TYPE,
  TEST_ITR_SKIPPING_COUNT,
  TEST_SOURCE_FILE,
  TEST_IS_RETRY,
  TEST_NAME,
  JEST_DISPLAY_NAME,
  TEST_RETRY_REASON,
  TEST_SOURCE_START,
  TEST_CODE_OWNERS,
  TEST_SESSION_NAME,
  DI_ERROR_DEBUG_INFO_CAPTURED,
  DI_DEBUG_ERROR_PREFIX,
  DI_DEBUG_ERROR_FILE_SUFFIX,
  DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX,
  DI_DEBUG_ERROR_LINE_SUFFIX,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_RETRY_REASON_TYPES,
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
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { ERROR_MESSAGE, ERROR_TYPE, ORIGIN_KEY, COMPONENT } = require('../../packages/dd-trace/src/constants')
const { DD_MAJOR } = require('../../version')
const { version: ddTraceVersion } = require('../../package.json')

const testFile = 'ci-visibility/run-jest.js'
const expectedStdout = 'Test Suites: 2 passed'
const runTestsCommand = 'node ./ci-visibility/run-jest.js'

const requestedJestVersion = process.env.JEST_VERSION || 'latest'
const oldestJestVersion = DD_MAJOR >= 6 ? '28.0.0' : '24.8.0'
const JEST_VERSION = requestedJestVersion === 'oldest' ? oldestJestVersion : requestedJestVersion
const onlyLatestIt = JEST_VERSION === 'latest' ? it : it.skip
const shouldInstallJestEnvironmentJsdom = JEST_VERSION === 'latest' || Number(JEST_VERSION.split('.')[0]) >= 28

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
    `babel-jest@${JEST_VERSION}`,
    // jest-environment-jsdom is included in older versions of jest
    shouldInstallJestEnvironmentJsdom ? `jest-environment-jsdom@${JEST_VERSION}` : '',
    // jest-circus is not included in older versions of jest
    JEST_VERSION !== 'latest' ? `jest-circus@${JEST_VERSION}` : '',
    '@babel/core',
    '@babel/preset-typescript',
    '@happy-dom/jest-environment',
    'office-addin-mock',
    'winston',
    'jest-image-snapshot',
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

            assert.match(test.meta[TEST_CODE_OWNERS], /@datadog-dd-trace-js/)

            assertObjectContains(test, {
              type: 'test',
              name: 'jest.test',
              service: 'plugin-tests',
              resource: `ci-visibility/jest-plugin-tests/jest-test.js.${name}`,
              meta: {
                language: 'javascript',
                [ORIGIN_KEY]: CI_APP_ORIGIN,
                [TEST_FRAMEWORK]: 'jest',
                [TEST_NAME]: name,
                [TEST_STATUS]: status,
                [TEST_SUITE]: 'ci-visibility/jest-plugin-tests/jest-test.js',
                [TEST_SOURCE_FILE]: 'ci-visibility/jest-plugin-tests/jest-test.js',
                [TEST_TYPE]: 'test',
                [JEST_TEST_RUNNER]: 'jest-circus',
                [LIBRARY_VERSION]: ddTraceVersion,
                [COMPONENT]: 'jest',
              },
            })

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
              assert.strictEqual(metadata.test_levels[TEST_SESSION_NAME], 'my-test-session')
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
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)
            metadataDicts.forEach(metadata => {
              assert.ok(metadata.test_levels[TEST_COMMAND])
            })

            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            const testModuleEvent = events.find(event => event.type === 'test_module_end').content
            const testSuiteEvent = events.find(event => event.type === 'test_suite_end').content
            const testEvent = events.find(event => event.type === 'test').content

            assert.ok(testSessionEvent)
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'pass')
            assert.ok(testSessionEvent[TEST_SESSION_ID])
            assert.ok(testSessionEvent[TEST_SUITE_ID] == null, `Expected ${testSessionEvent[TEST_SUITE_ID]} == null`)
            assert.ok(testSessionEvent[TEST_MODULE_ID] == null, `Expected ${testSessionEvent[TEST_MODULE_ID]} == null`)

            assert.ok(testModuleEvent)
            assert.strictEqual(testModuleEvent.meta[TEST_STATUS], 'pass')
            assert.ok(testModuleEvent[TEST_SESSION_ID])
            assert.ok(testModuleEvent[TEST_MODULE_ID])
            assert.ok(testModuleEvent[TEST_SUITE_ID] == null, `Expected ${testModuleEvent[TEST_SUITE_ID]} == null`)

            assert.ok(testSuiteEvent)
            assert.strictEqual(testSuiteEvent.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testSuiteEvent.meta[TEST_SUITE], 'ci-visibility/jest-plugin-tests/jest-test-suite.js')
            assert.ok(testSuiteEvent.meta[TEST_MODULE])
            assert.ok(testSuiteEvent[TEST_SUITE_ID])
            assert.ok(testSuiteEvent[TEST_SESSION_ID])
            assert.ok(testSuiteEvent[TEST_MODULE_ID])

            assert.ok(testEvent)
            assert.strictEqual(testEvent.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testEvent.meta[TEST_NAME], 'jest-test-suite-visibility works')
            assert.strictEqual(testEvent.meta[TEST_SUITE], 'ci-visibility/jest-plugin-tests/jest-test-suite.js')
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

      const assertCustomEnvironmentReportsTests = async (customTestEnvironment) => {
        const envVars = reportingOption === 'agentless'
          ? getCiVisAgentlessConfig(receiver.port)
          : getCiVisEvpProxyConfig(receiver.port)
        if (reportingOption === 'evp proxy') {
          receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
        }

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const resourceNames = tests.map(test => test.resource)

            assertObjectContains(resourceNames, [
              'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
            ])
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...envVars,
              CUSTOM_TEST_ENVIRONMENT: customTestEnvironment,
              TESTS_TO_RUN: 'test/ci-visibility-test.js',
            },
          }
        )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
        assert.strictEqual(exitCode, 0)
      }

      it('reports test events when a custom environment does not call super.handleTestEvent', async () => {
        await assertCustomEnvironmentReportsTests('./ci-visibility/jestEnvironmentNoSuper.js')
      })

      it('reports test events when a custom environment defines handleTestEvent as an instance field', async () => {
        await assertCustomEnvironmentReportsTests('./ci-visibility/jestEnvironmentNoSuperInstanceField.js')
      })

      it('reports test events when a custom environment assigns handleTestEvent after setup', async () => {
        await assertCustomEnvironmentReportsTests('./ci-visibility/jestEnvironmentNoSuperAfterSetup.js')
      })

      it('reports test events when a custom environment has an instance field and setup without super', async () => {
        await assertCustomEnvironmentReportsTests('./ci-visibility/jestEnvironmentNoSuperSetupAndInstanceField.js')
      })
    })
  })

  it('propagates test span context to HTTP requests and hooks during test.concurrent execution', async () => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        const spans = events.filter(event => event.type === 'span').map(event => event.content)

        const expectedHttpSpanCountByTestName = new Map([
          ['jest-test-concurrent-hook-http first concurrent body http is linked to first test span', 1],
          ['jest-test-concurrent-hook-http second concurrent body http is linked to second test span', 1],
          ['jest-mixed-concurrent-hook-http serial hook http is linked to serial test span', 3],
          ['jest-mixed-concurrent-hook-http first mixed concurrent body http is linked to first test span', 1],
          ['jest-mixed-concurrent-hook-http second mixed concurrent body http is linked to second test span', 1],
        ])
        for (const [testName, expectedHttpSpanCount] of expectedHttpSpanCountByTestName) {
          const concurrentHookTestSpan = tests.find(test => test.meta[TEST_NAME] === testName)
          assert.ok(concurrentHookTestSpan, `should have concurrent hook test span for ${testName}`)
          assert.strictEqual(concurrentHookTestSpan.meta[TEST_STATUS], 'pass')

          const concurrentHookHttpSpans = spans.filter(span =>
            span.name === 'http.request' &&
            span.trace_id.toString() === concurrentHookTestSpan.trace_id.toString() &&
            span.parent_id.toString() === concurrentHookTestSpan.span_id.toString()
          )
          assert.strictEqual(
            concurrentHookHttpSpans.length,
            expectedHttpSpanCount,
            `should have the expected HTTP spans as children of ${testName}`
          )
        }
      }, 25000)

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_SERVICE: undefined,
          TESTS_TO_RUN: 'test/jest-concurrent-http',
        },
      }
    )

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      eventsPromise,
    ])
    assert.strictEqual(exitCode, 0)
  })

  const envVarSettings = ['DD_TRACE_ENABLED']

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
    receiver.setSettings({
      itr_enabled: true,
      code_coverage: false,
      tests_skipping: true,
    })
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
      }).catch(done)
    }).catch(done)
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
        assert.ok(
          !spanTypes.some(type => ['test_session_end', 'test_suite_end', 'test_module_end'].includes(type)),
          `Got: ${inspect(spanTypes)}`
        )
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
          assert.strictEqual(metadata.test_levels[TEST_SESSION_NAME], 'my-test-session')
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

    onlyLatestIt('does not run Failed Test Replay for files with concurrent tests', async () => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests
          assert.strictEqual(
            retriedTest.meta[TEST_NAME],
            'dynamic instrumentation with concurrent tests serial retry does not use Failed Test Replay'
          )

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

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/concurrent-ftr-disabled',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            RUN_IN_PARALLEL: 'true',
          },
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
        logsPromise,
      ])
      assert.strictEqual(exitCode, 0)
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
          // Must have 2 tests: 1 original + 1 ATR retry
          assert.strictEqual(tests.length, 2)
          const retriedTests = tests.filter(t => t.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, 1)
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: 'jest-flaky/fake-timers-flaky-fails',
          DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
          SHOULD_CHECK_RESULTS: '1',
        },
      })

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
      assert.strictEqual(exitCode, 1)
    })
  })

  context('when jest is using worker threads', () => {
    onlyLatestIt('ignores non-array worker-thread messages', (done) => {
      childProcess = fork(testFile, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: 'jest-plugin-tests/jest-worker-message',
          USE_WORKER_THREADS: 'true',
        },
        stdio: 'pipe',
      })
      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      Promise.all([
        once(childProcess, 'message'),
        receiver.gatherPayloads(({ url }) => url === '/api/v2/citestcycle', 5000),
      ]).then(([, eventsRequests]) => {
        const tests = eventsRequests.map(({ payload }) => payload)
          .flatMap(({ events }) => events)
          .filter(event => event.type === 'test')
          .map(event => event.content)

        assert.strictEqual(tests.length, 1)
        assert.strictEqual(
          tests[0].meta[TEST_NAME],
          'jest-worker-message passes after sending a non-array worker message'
        )
        assert.strictEqual(tests[0].meta[TEST_STATUS], 'pass')
        assert.doesNotMatch(testOutput, /TypeError/)
        done()
      }).catch(done)
    })

    onlyLatestIt('reports tests when using agentless', (done) => {
      childProcess = fork(testFile, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          USE_WORKER_THREADS: 'true',
        },
        stdio: 'pipe',
      })

      receiver.gatherPayloads(({ url }) => url === '/api/v2/citestcycle', 5000).then(eventsRequests => {
        const events = eventsRequests.map(({ payload }) => payload)
          .flatMap(({ events }) => events)
        const eventTypes = events.map(event => event.type)
        assertObjectContains(eventTypes, ['test', 'test_suite_end', 'test_session_end', 'test_module_end'])

        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        assert.ok(tests.length >= 2, `Expected ${tests.length} >= 2`)
        tests.forEach(testEvent => {
          assert.strictEqual(testEvent.meta[TEST_STATUS], 'pass')
        })

        done()
      }).catch(done)
    })

    onlyLatestIt('reports tests when using evp proxy', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v2'] })
      childProcess = fork(testFile, {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          USE_WORKER_THREADS: 'true',
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

  it('keeps default stack formatting when imported modules read error stacks', async () => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const suites = events.filter(event => event.type === 'test_suite_end')
        const stackImportSuites = suites.filter(
          suite => suite.content.meta[TEST_SUITE] ===
            'ci-visibility/jest-stack-on-import/jest-stack-on-import-test.js'
        )

        assert.strictEqual(stackImportSuites.length, 1)
        assert.strictEqual(stackImportSuites[0].content.meta[TEST_STATUS], 'pass')
      })

    childProcess = exec(runTestsCommand, {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        TESTS_TO_RUN: 'jest-stack-on-import/jest-stack-on-import-test',
        SHOULD_CHECK_RESULTS: 'true',
      },
    })
    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })

    const [exitCode] = await once(childProcess, 'exit')

    assert.strictEqual(exitCode, 0, testOutput)
    assert.doesNotMatch(testOutput, /originalPrepareStackTrace is not a function/)
    await eventsPromise
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
            failedTestSuite.content.meta[ERROR_MESSAGE].includes('a file outside of the scope of the test code'),
            `Got: ${inspect(failedTestSuite.content.meta[ERROR_MESSAGE])}`
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
          const errorMessage = badImportTestSuite.content.meta[ERROR_MESSAGE]
          assert.ok(
            errorMessage.includes('a file after the Jest environment has been torn down'),
            `Got: ${inspect(errorMessage)}`
          )
          assert.ok(
            errorMessage.includes('From ci-visibility/jest-bad-import-torn-down/jest-bad-import-test.js'),
            `Got: ${inspect(errorMessage)}`
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

  it('reports total code coverage % when TIA forces coverage collection', (done) => {
    receiver.setSettings({
      itr_enabled: true,
      code_coverage: true,
      coverage_report_upload_enabled: true,
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

  it('flushes test data before Jest bails', async () => {
    receiver.setSettings({
      itr_enabled: false,
      code_coverage: false,
      tests_skipping: false,
    })

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          JEST_BAIL: '1',
          TESTS_TO_RUN: 'test/fail-test.js',
          ENABLE_CODE_COVERAGE: '1',
        },
      }
    )

    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })

    await receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testSession = events.find(event => event.type === 'test_session_end')
        const testModule = events.find(event => event.type === 'test_module_end')
        const testSuite = events.find(event => event.type === 'test_suite_end')
        const test = events.find(event => event.type === 'test')

        assert.ok(testSession)
        assert.ok(testModule)
        assert.ok(testSuite)
        assert.ok(test)
        assert.notStrictEqual(testSession.content.metrics[TEST_CODE_COVERAGE_LINES_PCT], undefined)
        assert.strictEqual(test.content.meta[TEST_SUITE], 'ci-visibility/test/fail-test.js')
        assert.strictEqual(test.content.meta[TEST_NAME], 'fail can report failed tests')
        assert.strictEqual(test.content.meta[TEST_STATUS], 'fail')
      }
    )
    assert.strictEqual(childProcess.exitCode, 1)
  })

  it('flushes suite-level failures when bail is enabled', async () => {
    receiver.setSettings({
      itr_enabled: false,
      code_coverage: false,
      tests_skipping: false,
    })

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          JEST_BAIL: '1',
          SHOULD_CHECK_RESULTS: '1',
          TESTS_TO_RUN: 'test-parsing-error/parsing-error.js',
        },
      }
    )

    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })

    await receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testSession = events.find(event => event.type === 'test_session_end')
        const testModule = events.find(event => event.type === 'test_module_end')
        const testSuite = events.find(event => event.type === 'test_suite_end')
        const tests = events.filter(event => event.type === 'test')

        assert.ok(testSession)
        assert.ok(testModule)
        assert.ok(testSuite)
        assert.strictEqual(tests.length, 0)
        assert.strictEqual(testSuite.content.meta[TEST_SUITE], 'ci-visibility/test-parsing-error/parsing-error.js')
        assert.strictEqual(testSuite.content.meta[TEST_STATUS], 'fail')
        assert.match(testSuite.content.meta[ERROR_MESSAGE], /chao/)
      }
    )
    assert.strictEqual(childProcess.exitCode, 1)
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

  it('preserves custom testEnvironmentOptions for coverage transforms', async function () {
    // This repro exists because one of our hooks modified `testEnvironmentOptions`,
    // which can cause downstream transform errors.
    this.timeout(60_000)

    let outputWithTracer = ''
    const command = 'node ./node_modules/jest/bin/jest --config ./jest/dd-trace-transform-repro.config.js --coverage'
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testEvents = events.filter(event => event.type === 'test')

        assert.ok(testEvents.length > 0, `Expected ${testEvents.length} > 0`)
      })

    childProcess = exec(
      command,
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      }
    )

    childProcess.stdout?.on('data', (chunk) => {
      outputWithTracer += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      outputWithTracer += chunk.toString()
    })

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      eventsPromise,
    ])

    assert.strictEqual(exitCode, 0, outputWithTracer)
    assert.doesNotMatch(outputWithTracer, /testEnvironmentOptions prototype was lost/)
  })
})
