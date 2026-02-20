'use strict'

const { fork, exec, execSync } = require('child_process')
const fs = require('fs')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('path')
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
  TEST_TYPE,
  TEST_FRAMEWORK,
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
  TEST_SOURCE_START,
  TEST_CODE_OWNERS,
  TEST_SESSION_NAME,
  TEST_LEVEL_EVENT_TYPES,
  TEST_EARLY_FLAKE_ABORT_REASON,
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
  CI_APP_ORIGIN,
  TEST_FRAMEWORK_VERSION,
  LIBRARY_VERSION,
  TEST_PARAMETERS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const {
  ERROR_MESSAGE,
  ORIGIN_KEY,
  COMPONENT,
  ERROR_STACK,
  ERROR_TYPE,
} = require('../../packages/dd-trace/src/constants')
const { VERSION: ddTraceVersion } = require('../../version')

const runTestsCommand = 'node ./ci-visibility/run-mocha.js'
const runTestsWithCoverageCommand = `./node_modules/nyc/bin/nyc.js -r=text-summary ${runTestsCommand}`
const testFile = 'ci-visibility/run-mocha.js'
const expectedStdout = '2 passing'
const extraStdout = 'end event: can add event listeners to mocha'

const MOCHA_VERSION = process.env.MOCHA_VERSION || 'latest'
const onlyLatestIt = MOCHA_VERSION === 'latest' ? it : it.skip

describe(`mocha@${MOCHA_VERSION}`, function () {
  let receiver
  let childProcess
  let cwd
  let startupTestFile
  let testOutput = ''

  useSandbox(
    [
      `mocha@${MOCHA_VERSION}`,
      'nyc',
      'mocha-each',
      'workerpool',
    ],
    true
  )

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

  it('can run tests and report tests with the APM protocol (old agents)', (done) => {
    receiver.setInfoResponse({ endpoints: [] })
    receiver.payloadReceived(({ url }) => url === '/v0.4/traces').then(({ payload }) => {
      const testSpans = payload.flatMap(trace => trace)
      const resourceNames = testSpans.map(span => span.resource)

      assertObjectContains(resourceNames,
        [
          'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
          'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2',
        ]
      )

      const areAllTestSpans = testSpans.every(span => span.name === 'mocha.test')
      assert.strictEqual(areAllTestSpans, true)

      assert.match(testOutput, new RegExp(expectedStdout))

      if (extraStdout) {
        assert.match(testOutput, new RegExp(extraStdout))
      }
      // Can read DD_TAGS
      testSpans.forEach(testSpan => {
        assert.strictEqual(testSpan.meta['test.customtag'], 'customvalue')
        assert.strictEqual(testSpan.meta['test.customtag2'], 'customvalue2')
      })

      testSpans.forEach(testSpan => {
        assert.strictEqual(testSpan.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/test/ci-visibility-test'), true)
        assert.ok(testSpan.metrics[TEST_SOURCE_START])
      })

      done()
    })

    childProcess = fork(startupTestFile, {
      cwd,
      env: {
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
  })

  // TODO: This should also run in agentless mode
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

  const nonLegacyReportingOptions = ['evp proxy', 'agentless']

  nonLegacyReportingOptions.forEach((reportingOption) => {
    let envVars = /** @type {NodeJS.ProcessEnv} */ ({})
    context(`(${reportingOption}) can run and report`, () => {
      beforeEach(() => {
        if (reportingOption === 'agentless') {
          envVars = getCiVisAgentlessConfig(receiver.port)
        } else {
          envVars = getCiVisEvpProxyConfig(receiver.port)
          receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
        }
      })

      it('tests with custom tags', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), (payloads) => {
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
                'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
                'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2',
              ]
            )
            assert.strictEqual(suites.length, 2)
            assert.ok(sessionEventContent)
            assert.ok(moduleEventContent)

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

        await Promise.all([
          eventsPromise,
          once(childProcess.stdout, 'end'),
          once(childProcess.stderr, 'end'),
          once(childProcess, 'exit'),
        ])
        assert.match(testOutput, new RegExp(expectedStdout))
        assert.match(testOutput, new RegExp(extraStdout))
      })

      it('passing tests', async () => {
        const testNames = [
          'mocha-test-pass can pass',
          'mocha-test-pass can pass two',
          'mocha-test-pass-two can pass',
          'mocha-test-pass-two can pass two',
        ]
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, 4)
            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), testNames)

            tests.forEach(test => {
              assert.strictEqual(test.parent_id.toString(), '0')
              assert.strictEqual(test.meta[TEST_STATUS], 'pass')
              assert.strictEqual(test.meta[ORIGIN_KEY], CI_APP_ORIGIN)
              assert.ok(test.meta[TEST_FRAMEWORK_VERSION])
              assert.strictEqual(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
              assert.strictEqual(test.meta[LIBRARY_VERSION], ddTraceVersion)
              assert.strictEqual(test.meta[COMPONENT], 'mocha')
            })
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/passing.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('failing tests', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta.language, 'javascript')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-fail can fail')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/failing.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/failing.js')
            assert.strictEqual(test.meta[ERROR_TYPE], 'AssertionError')
            assert.strictEqual(test.meta[ERROR_MESSAGE], 'Expected values to be strictly equal:\n\ntrue !== false\n')
            assert.ok(test.metrics[TEST_SOURCE_START])
            assert.ok(test.meta[ERROR_STACK])
            assert.strictEqual(test.parent_id.toString(), '0')
            assert.strictEqual(test.type, 'test')
            assert.strictEqual(test.name, 'mocha.test')
            assert.strictEqual(test.resource, 'ci-visibility/mocha-plugin-tests/failing.js.mocha-test-fail can fail')
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/failing.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('skipping tests', async () => {
        const testNames = [
          'mocha-test-skip can skip',
          'mocha-test-skip-different can skip too',
          'mocha-test-skip-different can skip twice',
          'mocha-test-programmatic-skip can skip too',
        ]
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 4)
            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), testNames)

            tests.forEach(test => {
              assert.strictEqual(test.parent_id.toString(), '0')
              assert.strictEqual(test.meta[TEST_STATUS], 'skip')
              assert.strictEqual(test.meta[ORIGIN_KEY], CI_APP_ORIGIN)
              assert.strictEqual(test.meta[COMPONENT], 'mocha')
              assert.strictEqual(test.meta[TEST_TYPE], 'test')
              assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
              assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/skipping.js')
              assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/skipping.js')
            })
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/skipping.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('passing tests using done()', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-done-pass can do passed tests with done')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/done-pass.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/done-pass.js')
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/done-pass.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('failing tests using done()', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-done-fail can do failed tests with done')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/done-fail.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/done-fail.js')
            assert.strictEqual(test.meta[ERROR_TYPE], 'AssertionError')
            assert.strictEqual(test.meta[ERROR_MESSAGE], 'Expected values to be strictly equal:\n\ntrue !== false\n')
            assert.ok(test.meta[ERROR_STACK])
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/done-fail.js',
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

      it('passing tests using promises', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-promise-pass can do passed promise tests')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/promise-pass.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/promise-pass.js')
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/promise-pass.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('failing tests using promises', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-promise-fail can do failed promise tests')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/promise-fail.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/promise-fail.js')
            assert.strictEqual(test.meta[ERROR_TYPE], 'AssertionError')
            assert.strictEqual(test.meta[ERROR_MESSAGE], 'Expected values to be strictly equal:\n\ntrue !== false\n')
            assert.ok(test.meta[ERROR_STACK])
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/promise-fail.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('passing tests using async/await', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-async-pass can do passed async tests')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/async-pass.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/async-pass.js')
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/async-pass.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('failing tests using async/await', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-async-fail can do failed async tests')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/async-fail.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/async-fail.js')
            assert.strictEqual(test.meta[ERROR_TYPE], 'AssertionError')
            assert.strictEqual(test.meta[ERROR_MESSAGE], 'Expected values to be strictly equal:\n\ntrue !== false\n')
            assert.ok(test.meta[ERROR_STACK])
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/async-fail.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('tests that time out', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-timeout-fail times out')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/timeout-fail.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/timeout-fail.js')
            assert.strictEqual(test.meta[ERROR_TYPE], 'Error')
            assert.match(test.meta[ERROR_MESSAGE], /Timeout/)
            assert.ok(test.meta[ERROR_STACK])
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/timeout-fail.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('passing tests that use setTimeout', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-timeout-pass does not timeout')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/timeout-pass.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/timeout-pass.js')
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/timeout-pass.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('parameterized tests', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-parameterized can do parameterized')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/parameterized.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/parameterized.js')
            assert.strictEqual(test.meta[TEST_PARAMETERS], JSON.stringify({ arguments: [1, 2, 3], metadata: {} }))
            assert.ok(test.metrics[TEST_SOURCE_START])
            assert.strictEqual(test.parent_id.toString(), '0')
            assert.strictEqual(test.type, 'test')
            assert.strictEqual(test.name, 'mocha.test')
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/parameterized.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('integration tests with http', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const spans = events.filter(event => event.type === 'span').map(event => event.content)

            assert.strictEqual(tests.length, 1)
            const [testSpan] = tests

            const httpSpan = spans.find(span => span.name === 'http.request')
            assert.ok(httpSpan)

            // Test span assertions
            assert.strictEqual(testSpan.meta[COMPONENT], 'mocha')
            assert.strictEqual(testSpan.meta[TEST_NAME], 'mocha-test-integration-http can do integration http')
            assert.strictEqual(testSpan.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testSpan.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(testSpan.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/integration.js')
            assert.strictEqual(testSpan.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/integration.js')
            assert.strictEqual(testSpan.meta[ORIGIN_KEY], CI_APP_ORIGIN)
            assert.ok(testSpan.metrics[TEST_SOURCE_START])
            assert.strictEqual(testSpan.parent_id.toString(), '0')

            // HTTP span assertions
            assert.strictEqual(httpSpan.meta[ORIGIN_KEY], CI_APP_ORIGIN)
            const endpointUrl = envVars.DD_CIVISIBILITY_AGENTLESS_URL ||
              `http://127.0.0.1:${envVars.DD_TRACE_AGENT_PORT}`
            assert.strictEqual(httpSpan.meta['http.url'], `${endpointUrl}/info`)
            assert.strictEqual(httpSpan.parent_id.toString(), testSpan.span_id.toString(),
              'HTTP span should be child of test span')
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/integration.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('tests with sync errors in hooks', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[ERROR_TYPE], 'TypeError')
            assert.ok(
              test.meta[ERROR_MESSAGE]
                .includes('mocha-fail-hook-sync "before each" hook for "will not run but be reported as failed":')
            )
            assert.match(test.meta[ERROR_MESSAGE], /Cannot set /)
            assert.ok(test.meta[ERROR_STACK])
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/hook-sync-error.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('tests using active span in hooks', async () => {
        const testNames = [
          'mocha-active-span-in-hooks first test',
          'mocha-active-span-in-hooks second test',
        ]
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 2)
            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), testNames)

            tests.forEach(test => {
              assert.strictEqual(test.meta[TEST_STATUS], 'pass')
              assert.strictEqual(test.meta[COMPONENT], 'mocha')
            })
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/active-span-hooks.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('tests with async errors in hooks', async () => {
        const testNames = [
          {
            name: 'mocha-fail-hook-async will run but be reported as failed',
            status: 'fail',
            errorMsg: 'mocha-fail-hook-async "after each" hook for "will run but be reported as failed": yeah error',
          },
          {
            name: 'mocha-fail-hook-async-other will run and be reported as passed',
            status: 'pass',
          },
          {
            name: 'mocha-fail-hook-async-other-before will not run and be reported as failed',
            status: 'fail',
            errorMsg: 'mocha-fail-hook-async-other-before ' +
              '"before each" hook for "will not run and be reported as failed": yeah error',
          },
          {
            name: 'mocha-fail-hook-async-other-second-after will run and be reported as failed',
            status: 'fail',
            errorMsg: 'mocha-fail-hook-async-other-second-after ' +
              '"after each" hook for "will run and be reported as failed": yeah error',
          },
          {
            name: 'mocha-fail-test-after-each-passes will fail and be reported as failed',
            status: 'fail',
          },
        ]
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 5)

            testNames.forEach(({ name, status, errorMsg }) => {
              const test = tests.find(t => t.meta[TEST_NAME] === name)
              assert.ok(test)
              assert.strictEqual(test.meta[TEST_STATUS], status)
              assert.strictEqual(test.meta[COMPONENT], 'mocha')
              if (errorMsg) {
                assert.strictEqual(test.meta[ERROR_MESSAGE].startsWith(errorMsg), true)
                assert.strictEqual(test.meta[ERROR_TYPE], 'Error')
                assert.ok(test.meta[ERROR_STACK])
              }
            })
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/hook-async-error.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('tests with done callback fail', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-done-fail can do badly setup failed tests with done')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[ERROR_TYPE], 'AssertionError')
            assert.strictEqual(test.meta[ERROR_MESSAGE], 'Expected values to be strictly equal:\n\ntrue !== false\n')
            assert.ok(test.meta[ERROR_STACK])
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/done-fail-badly.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('tests with retries', async () => {
        // retry handler was released in mocha@6.0.0
        // so the reported data changes between mocha versions
        const isLatestMocha = MOCHA_VERSION === 'latest'

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            if (isLatestMocha) {
              assert.strictEqual(tests.length, 8)
            } else {
              assert.strictEqual(tests.length, 2)
            }

            const eventuallyPassingTests = tests.filter(t =>
              t.meta[TEST_NAME] === 'mocha-test-retries will be retried and pass'
            )
            if (isLatestMocha) {
              assert.strictEqual(eventuallyPassingTests.length, 3)
            } else {
              assert.strictEqual(eventuallyPassingTests.length, 1)
            }

            const failedTests = tests.filter(t =>
              t.meta[TEST_NAME] === 'mocha-test-retries will be retried and fail' &&
              t.meta[TEST_STATUS] === 'fail'
            )
            if (isLatestMocha) {
              assert.strictEqual(failedTests.length, 5)
            } else {
              assert.strictEqual(failedTests.length, 1)
            }
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/retries.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('tests when skipping "describe"', async () => {
        const testNames = [
          { name: 'mocha-test-skip-describe will be skipped', status: 'skip' },
          { name: 'mocha-test-skip-describe-pass will pass', status: 'pass' },
        ]
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 2)

            testNames.forEach(({ name, status }) => {
              const test = tests.find(t => t.meta[TEST_NAME] === name)
              assert.ok(test)
              assert.strictEqual(test.meta[TEST_STATUS], status)
              assert.strictEqual(test.meta[COMPONENT], 'mocha')
            })
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/skip-describe.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('should create events for session, modules, suites and test', async () => {
        const suites = [
          'ci-visibility/mocha-plugin-tests/suite-level-fail-after-each.js',
          'ci-visibility/mocha-plugin-tests/suite-level-fail-skip-describe.js',
          'ci-visibility/mocha-plugin-tests/suite-level-fail-test.js',
          'ci-visibility/mocha-plugin-tests/suite-level-pass.js',
        ]

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), (payloads) => {
            if (reportingOption === 'evp proxy') {
              const headers = payloads.map(({ headers }) => headers)
              headers.forEach(header => {
                assert.strictEqual(header['x-datadog-evp-subdomain'], 'citestcycle-intake')
              })
              const urls = payloads.map(({ url }) => url)
              urls.forEach(url => {
                assert.strictEqual(url, '/evp_proxy/v4/api/v2/citestcycle')
              })
            }

            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')?.content
            const testModuleEvent = events.find(event => event.type === 'test_module_end')?.content
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end').map(e => e.content)

            assert.ok(testSessionEvent)
            assert.ok(testModuleEvent)
            assert.strictEqual(testSuiteEvents.length, 4, 'Should have 4 test suite events')

            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testModuleEvent.meta[TEST_STATUS], 'fail')

            // Check that all suites have the same session ID
            assert.ok(
              testSuiteEvents.every(
                suite => suite.test_session_id.toString() === testSessionEvent.test_session_id.toString()
              ),
              'All suites should have the same test_session_id'
            )

            // Check that all suites have the same module ID
            assert.ok(
              testSuiteEvents.every(
                suite => suite.test_module_id.toString() === testModuleEvent.test_module_id.toString()
              ),
              'All suites should have the same test_module_id'
            )

            // Check that all suites have a test_suite_id
            assert.strictEqual(
              testSuiteEvents.every(suite => suite.test_suite_id !== undefined),
              true,
              'All suites should have a test_suite_id'
            )

            // Check that all suites match expected suite names
            assert.ok(
              testSuiteEvents.every(suite => suites.includes(suite.meta[TEST_SUITE])),
              'All suites should match expected suite names'
            )

            const failedSuites = testSuiteEvents.filter(suite => suite.meta[TEST_STATUS] === 'fail')
            const passedSuites = testSuiteEvents.filter(suite => suite.meta[TEST_STATUS] === 'pass')

            assert.strictEqual(passedSuites.length, 1, 'Should have 1 passing suite')
            assert.strictEqual(failedSuites.length, 3, 'Should have 3 failing suites')
            assert.ok(
              failedSuites.every(suite => suite.meta[ERROR_MESSAGE] !== undefined),
              'All failed suites should have an error message'
            )
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/suite-level-*.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
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

  context('custom tagging', () => {
    it('can add custom tags to the tests', (done) => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
            TESTS_TO_RUN: JSON.stringify([
              './test-custom-tags/custom-tags.js',
            ]),
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
      'node ../../node_modules/mocha/bin/mocha subproject-test.js',
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

  it('does not change mocha config if CI Visibility fails to init', (done) => {
    receiver.assertPayloadReceived(() => {
      const error = new Error('it should not report tests')
      done(error)
    }, ({ url }) => url === '/api/v2/citestcycle', 3000).catch(() => {})

    const { DD_CIVISIBILITY_AGENTLESS_URL, ...restEnvVars } = getCiVisAgentlessConfig(receiver.port)

    // `runMocha` is only executed when using the CLI, which is where we modify mocha config
    // if CI Visibility is init
    childProcess = exec('node node_modules/mocha/bin/mocha ./ci-visibility/test/ci-visibility-test.js', {
      cwd,
      env: {
        ...restEnvVars,
        DD_TRACE_DEBUG: '1',
        DD_TRACE_LOG_LEVEL: 'error',
        DD_SITE: '= invalid = url',
      },
    })

    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.on('exit', () => {
      assert.match(testOutput, /Invalid URL/)
      assert.match(testOutput, /1 passing/) // we only run one file here
      done()
    })
  })

  onlyLatestIt('works with parallel mode', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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

        assert.strictEqual(sessionEventContent.meta[MOCHA_IS_PARALLEL], 'true')
        assert.strictEqual(
          sessionEventContent.test_session_id.toString(10),
          moduleEventContent.test_session_id.toString(10)
        )
        suites.forEach(({
          meta,
          test_suite_id: testSuiteId,
          test_module_id: testModuleId,
          test_session_id: testSessionId,
        }) => {
          assert.ok(meta[TEST_COMMAND])
          assert.ok(meta[TEST_MODULE])
          assert.ok(testSuiteId)
          assert.strictEqual(testModuleId.toString(10), moduleEventContent.test_module_id.toString(10))
          assert.strictEqual(testSessionId.toString(10), moduleEventContent.test_session_id.toString(10))
        })

        tests.forEach(({
          meta,
          metrics,
          test_suite_id: testSuiteId,
          test_module_id: testModuleId,
          test_session_id: testSessionId,
        }) => {
          assert.ok(meta[TEST_COMMAND])
          assert.ok(meta[TEST_MODULE])
          assert.ok(testSuiteId)
          assert.strictEqual(testModuleId.toString(10), moduleEventContent.test_module_id.toString(10))
          assert.strictEqual(testSessionId.toString(10), moduleEventContent.test_session_id.toString(10))
          assert.strictEqual(meta[MOCHA_IS_PARALLEL], 'true')
          assert.ok(metrics[TEST_SOURCE_START])
        })
      })

    childProcess = fork(testFile, {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        RUN_IN_PARALLEL: 'true',
        DD_TRACE_DEBUG: '1',
        DD_TRACE_LOG_LEVEL: 'warn',
        DD_TEST_SESSION_NAME: 'my-test-session',
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
      eventsPromise.then(() => {
        assert.doesNotMatch(testOutput, /TypeError/)
        done()
      }).catch(done)
    })
  })

  onlyLatestIt('works with parallel mode when run with the cli', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const sessionEventContent = events.find(event => event.type === 'test_session_end').content
        const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        assert.strictEqual(sessionEventContent.meta[MOCHA_IS_PARALLEL], 'true')
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
      })

    childProcess = exec(
      'node node_modules/mocha/bin/mocha --parallel --jobs 2 ./ci-visibility/test/ci-visibility-test*', {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      })
    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        assert.doesNotMatch(testOutput, /TypeError/)
        done()
      }).catch(done)
    })
  })

  it('does not blow up when workerpool is used outside of a test', (done) => {
    childProcess = exec('node ./ci-visibility/run-workerpool.js', {
      cwd,
      env: getCiVisAgentlessConfig(receiver.port),
    })
    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.on('exit', (code) => {
      assert.match(testOutput, /result 7/)
      assert.strictEqual(code, 0)
      done()
    })
  })

  it('reports errors in test sessions', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testSession = events.find(event => event.type === 'test_session_end').content
        assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
        const errorMessage = 'Failed tests: 1'
        assert.match(testSession.meta[ERROR_MESSAGE], new RegExp(errorMessage))
      })

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: JSON.stringify([
            './test/fail-test.js',
          ]),
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
      assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
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
              'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
              'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2',
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

    it('tags session and children with _dd.ci.library_configuration_error when settings fails 4xx', (done) => {
      receiver.setSettingsResponseCode(404)
      receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle').then((eventsRequest) => {
        const testSession = eventsRequest.payload.events.find(event => event.type === 'test_session_end').content
        assert.strictEqual(testSession.meta['_dd.ci.library_configuration_error'], '4xx')
        const testEvent = eventsRequest.payload.events.find(event => event.type === 'test')
        assert.ok(testEvent, 'should have test event')
        assert.strictEqual(testEvent.content.meta['_dd.ci.library_configuration_error'], '4xx')
        done()
      }).catch(done)
      childProcess = exec(runTestsCommand, {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      })
    })

    it('can report code coverage', (done) => {
      let testOutput = ''
      const libraryConfigRequestPromise = receiver.payloadReceived(
        ({ url }) => url === '/api/v2/libraries/tests/services/setting'
      )
      const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')
      const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

      Promise.all([
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

        assertObjectContains(allCoverageFiles,
          [
            'ci-visibility/test/sum.js',
            'ci-visibility/test/ci-visibility-test.js',
            'ci-visibility/test/ci-visibility-test-2.js',
          ]
        )

        const [coveragePayload] = codeCovRequest.payload
        assert.ok(coveragePayload.content.coverages[0].test_session_id)
        assert.ok(coveragePayload.content.coverages[0].test_suite_id)

        const testSession = eventsRequest.payload.events.find(event => event.type === 'test_session_end').content
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
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.on('exit', () => {
        // coverage report
        assert.match(testOutput, /Lines {7}/)
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
      }, ({ url }) => url === '/api/v2/citestcov').catch(() => {})

      receiver.assertPayloadReceived(({ headers, payload }) => {
        assert.strictEqual(headers['dd-api-key'], '1')
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
      }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
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

        assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
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
        runTestsWithCoverageCommand,
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
        runTestsWithCoverageCommand,
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
      }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

      childProcess = exec(
        runTestsWithCoverageCommand,
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
        assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.strictEqual(numSuites, 2)
      }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

      childProcess = exec(
        runTestsWithCoverageCommand,
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
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './unskippable-test/test-to-run.js',
              './unskippable-test/test-to-skip.js',
              './unskippable-test/test-unskippable.js',
            ]),
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
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './unskippable-test/test-to-run.js',
              './unskippable-test/test-to-skip.js',
              './unskippable-test/test-unskippable.js',
            ]),
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
        runTestsWithCoverageCommand,
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
        runTestsWithCoverageCommand,
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
        '../../node_modules/nyc/bin/nyc.js node ../../node_modules/mocha/bin/mocha subproject-test.js',
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
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        mocha: {
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
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js',
            ]),
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('sets TEST_HAS_FAILED_ALL_RETRIES when all EFD attempts fail', (done) => {
      // fail-test.js will be considered new and will always fail
      receiver.setKnownTests({
        mocha: {},
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
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/fail-test.js',
            ]),
          },
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

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test-early-flake-detection/mocha-parameterized.js'
          )
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          // Each parameter is repeated independently
          const testsForFirstParameter = tests.filter(test => test.resource ===
            'ci-visibility/test-early-flake-detection/mocha-parameterized.js.parameterized test parameter 1'
          )

          const testsForSecondParameter = tests.filter(test => test.resource ===
            'ci-visibility/test-early-flake-detection/mocha-parameterized.js.parameterized test parameter 2'
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
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/test.js',
              './test-early-flake-detection/mocha-parameterized.js',
            ]),
          },
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
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js',
            ]),
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
      // Tests from ci-visibility/test/occasionally-failing-test will be considered new
      receiver.setKnownTests({
        mocha: {},
      })

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
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/occasionally-failing-test.js',
            ]),
          },
        }
      )

      childProcess.on('exit', (exitCode) => {
        // TODO: check exit code: if a new, retried test fails, the exit code should remain 0
        eventsPromise.then(() => {
          assert.strictEqual(exitCode, 0)
          done()
        }).catch(done)
      })
    })

    it('does not retry new tests that are skipped', (done) => {
      // Tests from ci-visibility/test/skipped-and-todo-test will be considered new
      receiver.setKnownTests({
        mocha: {},
      })

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
          assert.ok(!(TEST_IS_RETRY in newSkippedTests[0].meta))
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/skipped-and-todo-test.js',
            ]),
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
        mocha: {
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
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-early-flake-detection/weird-test-names.js',
            ]),
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
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js',
            ]),
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })

    it('retries flaky tests and sets exit code to 0 as long as one attempt passes', (done) => {
      // Tests from ci-visibility/test/occasionally-failing-test will be considered new
      receiver.setKnownTests({
        mocha: {},
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
        'node ./node_modules/mocha/bin/mocha ci-visibility/test-early-flake-detection/occasionally-failing-test*',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: '**/ci-visibility/test-early-flake-detection/occasionally-failing-test*',
          },
        }
      )

      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      childProcess.on('exit', (exitCode) => {
        assert.match(testOutput, /2 passing/)
        assert.match(testOutput, /2 failing/)
        assert.strictEqual(exitCode, 0)
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('bails out of EFD if the percentage of new tests is too high', (done) => {
      const NUM_RETRIES_EFD = 5

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
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js',
            ]),
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    context('parallel mode', () => {
      onlyLatestIt('retries new tests', (done) => {
        // Tests from ci-visibility/test/occasionally-failing-test will be considered new
        receiver.setKnownTests({
          mocha: {},
        })

        // The total number of executions need to be an odd number, so that we
        // check that the EFD logic of ignoring failed executions is working.
        // Otherwise, a bug could slip in where we ignore the passed executions (like it was happening)
        const NUM_RETRIES_EFD = 4
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
            assert.strictEqual(testSession.meta[MOCHA_IS_PARALLEL], 'true')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            // all but one has been retried
            assert.strictEqual(tests.length - 1, retriedTests.length)
            assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
            // Out of NUM_RETRIES_EFD + 1 (5) total runs, 3 will be passing and 2 will be failing,
            // based on the global counter in the test file
            const passingTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
            const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(passingTests.length, 3)
            assert.strictEqual(failingTests.length, 2)
            // Test name does not change
            retriedTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_NAME], 'fail occasionally fails')
              assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
            })
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ' +
          '--parallel ./ci-visibility/test-early-flake-detection/occasionally-failing-test.js', {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
          })

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 0)
            done()
          }).catch(done)
        })
      })

      onlyLatestIt('retries new tests when using the programmatic API', (done) => {
        // Tests from ci-visibility/test/occasionally-failing-test will be considered new
        receiver.setKnownTests({
          mocha: {},
        })

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
            assert.strictEqual(testSession.meta[MOCHA_IS_PARALLEL], 'true')

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
              ...getCiVisAgentlessConfig(receiver.port),
              RUN_IN_PARALLEL: 'true',
              TESTS_TO_RUN: JSON.stringify([
                './test-early-flake-detection/occasionally-failing-test.js',
              ]),
            },
          }
        )
        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 0)
            done()
          }).catch(done)
        })
      })

      onlyLatestIt('bails out of EFD if the percentage of new tests is too high', (done) => {
        const NUM_RETRIES_EFD = 5

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
        // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
        receiver.setKnownTests({
          mocha: {
            'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              RUN_IN_PARALLEL: 'true',
              TESTS_TO_RUN: JSON.stringify([
                './test/ci-visibility-test.js',
                './test/ci-visibility-test-2.js',
              ]),
            },
          }
        )

        childProcess.on('exit', () => {
          eventsPromise.then(() => {
            done()
          }).catch(done)
        })
      })

      onlyLatestIt('does not detect new tests if the response is invalid', async () => {
        const NUM_RETRIES_EFD = 5

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

        receiver.setKnownTests({
          'not-mocha': {
            'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

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
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              RUN_IN_PARALLEL: 'true',
              TESTS_TO_RUN: JSON.stringify([
                './test/ci-visibility-test.js',
                './test/ci-visibility-test-2.js',
              ]),
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })
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
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        mocha: {
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
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js',
            ]),
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

  context('auto test retries', () => {
    // retry listener was released in mocha@6.0.0
    onlyLatestIt('retries failed tests automatically', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: {
          enabled: false,
        },
      })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-flaky-test-retries/eventually-passing-test.js',
            ]),
          },
        }
      )

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 3) // two failed retries and then the pass

          const failedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(failedAttempts.length, 2)

          failedAttempts.forEach((failedTest, index) => {
            assert.match(
              failedTest.meta[ERROR_MESSAGE],
              new RegExp(`Expected values to be strictly equal:\n\n${index + 1} !== 3`)
            )
          })

          // The first attempt is not marked as a retry
          const retriedFailure = failedAttempts.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          )
          assert.strictEqual(retriedFailure.length, 1)

          const passedAttempt = tests.find(test => test.meta[TEST_STATUS] === 'pass')
          assert.strictEqual(passedAttempt.meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(passedAttempt.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
        })

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
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 1)

          const retries = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)
          assert.strictEqual(retries.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-flaky-test-retries/eventually-passing-test.js',
            ]),
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
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 2) // one retry

          const failedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(failedAttempts.length, 2)

          const retriedFailure = failedAttempts.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          )
          assert.strictEqual(retriedFailure.length, 1)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-flaky-test-retries/eventually-passing-test.js',
            ]),
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })
  })

  it('takes into account untested files if "all" is passed to nyc', (done) => {
    const linePctMatchRegex = /Lines\s*:\s*(\d+(?:\.\d+)?)%/
    let linePctMatch
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
      './node_modules/nyc/bin/nyc.js -r=text-summary --all --nycrc-path ./my-nyc.config.js ' +
      'node node_modules/mocha/bin/mocha ./ci-visibility/test/ci-visibility-test.js',
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      }
    )

    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })

    childProcess.on('exit', () => {
      linePctMatch = testOutput.match(linePctMatchRegex)
      linesPctFromNyc = linePctMatch ? Number(linePctMatch[1]) : -Infinity

      assert.strictEqual(linesPctFromNyc, codeCoverageWithUntestedFiles,
        'nyc --all output does not match the reported coverage')

      // reset test output for next test session
      testOutput = ''
      // we run the same tests without the all flag
      childProcess = exec(
        './node_modules/nyc/bin/nyc.js -r=text-summary --nycrc-path ./my-nyc.config.js ' +
        'node node_modules/mocha/bin/mocha ./ci-visibility/test/ci-visibility-test.js',
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
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
        linePctMatch = testOutput.match(linePctMatchRegex)
        linesPctFromNyc = linePctMatch ? Number(linePctMatch[1]) : -Infinity

        assert.strictEqual(linesPctFromNyc, codeCoverageWithoutUntestedFiles,
          'nyc output does not match the reported coverage (no --all flag)')

        eventsPromise.then(() => {
          assert.ok(codeCoverageWithoutUntestedFiles > codeCoverageWithUntestedFiles)
          done()
        }).catch(done)
      })
    })
  })

  context('dynamic instrumentation', () => {
    // retry listener was released in mocha@6.0.0
    onlyLatestIt('does not activate dynamic instrumentation if DD_TEST_FAILED_TEST_REPLAY_ENABLED is set to false',
      (done) => {
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
              .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

            assert.strictEqual(hasDebugTags, false)
          })

        const logsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
            if (payloads.length > 0) {
              throw new Error('Unexpected logs')
            }
          }, 5000)

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify([
                './dynamic-instrumentation/test-hit-breakpoint',
              ]),
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
            .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

          assert.strictEqual(hasDebugTags, false)
        })

      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          if (payloads.length > 0) {
            throw new Error('Unexpected logs')
          }
        }, 5000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './dynamic-instrumentation/test-hit-breakpoint',
            ]),
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

    onlyLatestIt('runs retries with dynamic instrumentation', (done) => {
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
          const retriedTests = tests.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          )

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
        }, 5000)

      childProcess = exec(
        'node ./ci-visibility/run-mocha.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './dynamic-instrumentation/test-hit-breakpoint',
            ]),
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
            .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

          assert.strictEqual(hasDebugTags, false)
        })
      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          if (payloads.length > 0) {
            throw new Error('Unexpected logs')
          }
        }, 5000)

      childProcess = exec(
        'node ./ci-visibility/run-mocha.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './dynamic-instrumentation/test-not-hit-breakpoint',
            ]),
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
          },
        }
      )

      childProcess.on('exit', () => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
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
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
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
          const retriedTests = newTests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)
          // no test has been retried
          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js',
            ]),
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
          TESTS_TO_RUN: JSON.stringify([
            './test/ci-visibility-test.js',
            './test/ci-visibility-test-2.js',
          ]),
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
          mocha: {
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
        shouldAlwaysPass,
        shouldFailSometimes,
        isQuarantined,
        isDisabled,
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

            const retriedTests = tests.filter(
              test => test.meta[TEST_NAME] === 'attempt to fix tests can attempt to fix a test'
            )

            for (let i = 0; i < retriedTests.length; i++) {
              const test = retriedTests[i]
              const isFirstAttempt = i === 0
              const isLastAttempt = i === retriedTests.length - 1
              if (!isAttemptToFix) {
                assert.ok(!(TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX in test.meta))
                assert.ok(!(TEST_IS_RETRY in test.meta))
                assert.ok(!(TEST_RETRY_REASON in test.meta))
                continue
              }

              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
              if (isFirstAttempt) {
                assert.ok(!(TEST_IS_RETRY in test.meta))
                assert.ok(!(TEST_RETRY_REASON in test.meta))
              } else {
                assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
              }

              if (isQuarantined) {
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              }

              if (isDisabled) {
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
              }

              if (isLastAttempt) {
                if (shouldAlwaysPass) {
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
                  assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                } else if (shouldFailSometimes) {
                  assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                } else {
                  assert.strictEqual(test.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                }
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
       *   extraEnvVars?: Record<string, string>
       * }} [options]
       */
      const runAttemptToFixTest = (done, {
        isAttemptToFix,
        shouldAlwaysPass,
        shouldFailSometimes,
        isQuarantined,
        isDisabled,
        extraEnvVars = {},
      } = {}) => {
        let stdout = ''
        const testAssertionsPromise = getTestAssertions({
          isAttemptToFix,
          shouldAlwaysPass,
          shouldFailSometimes,
          isQuarantined,
          isDisabled,
        })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify([
                './test-management/test-attempt-to-fix-1.js',
              ]),
              SHOULD_CHECK_RESULTS: '1',
              ...extraEnvVars,
              ...(shouldAlwaysPass ? { SHOULD_ALWAYS_PASS: '1' } : {}),
              ...(shouldFailSometimes ? { SHOULD_FAIL_SOMETIMES: '1' } : {}),
            },
          }
        )

        childProcess.stdout?.on('data', (data) => {
          stdout += data
        })

        childProcess.on('exit', exitCode => {
          testAssertionsPromise.then(() => {
            assert.match(stdout, /I am running when attempt to fix/)
            if (shouldAlwaysPass || isQuarantined || isDisabled) {
              // even though a test fails, the exit code is 0 because the test is quarantined or disabled
              assert.strictEqual(exitCode, 0)
            } else {
              assert.strictEqual(exitCode, 1)
            }
            done()
          }).catch(done)
        })
      }

      onlyLatestIt('can attempt to fix and mark last attempt as failed if every attempt fails', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done, { isAttemptToFix: true })
      })

      onlyLatestIt('can attempt to fix and mark last attempt as passed if every attempt passes', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done, { isAttemptToFix: true, shouldAlwaysPass: true })
      })

      onlyLatestIt('can attempt to fix and not mark last attempt if attempts both pass and fail', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done, { isAttemptToFix: true, shouldFailSometimes: true })
      })

      onlyLatestIt('does not attempt to fix tests if test management is not enabled', (done) => {
        receiver.setSettings({ test_management: { enabled: false, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done)
      })

      onlyLatestIt('does not enable attempt to fix tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

        runAttemptToFixTest(done, { extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } })
      })

      onlyLatestIt('does not fail retry if a test is quarantined', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
        receiver.setTestManagementTests({
          mocha: {
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

      onlyLatestIt('does not fail retry if a test is disabled', (done) => {
        receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
        receiver.setTestManagementTests({
          mocha: {
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
    })

    context('disabled', () => {
      beforeEach(() => {
        receiver.setTestManagementTests({
          mocha: {
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

      const getTestAssertions = (isDisabling) =>
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

            const skippedTests = tests.find(
              test => test.meta[TEST_NAME] === 'disable tests can disable a test'
            )

            if (isDisabling) {
              assert.strictEqual(skippedTests.meta[TEST_STATUS], 'skip')
              assert.strictEqual(skippedTests.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
            } else {
              assert.strictEqual(skippedTests.meta[TEST_STATUS], 'fail')
              assert.ok(!(TEST_MANAGEMENT_IS_DISABLED in skippedTests.meta))
            }
          })

      const runDisableTest = (done, isDisabling, extraEnvVars = {}) => {
        let stdout = ''
        const testAssertionsPromise = getTestAssertions(isDisabling)

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify([
                './test-management/test-disabled-1.js',
              ]),
              SHOULD_CHECK_RESULTS: '1',
              ...extraEnvVars,
            },
          }
        )

        childProcess.stdout?.on('data', (data) => {
          stdout += data
        })

        childProcess.on('exit', (exitCode) => {
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

        runDisableTest(done, true)
      })

      onlyLatestIt('can disable tests in parallel mode', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runDisableTest(done, true,
          {
            RUN_IN_PARALLEL: '1',
            TESTS_TO_RUN: JSON.stringify([
              './test-management/test-disabled-1.js',
              './test-management/test-disabled-2.js',
            ]),
          }
        )
      })

      onlyLatestIt('fails if disable is not enabled', (done) => {
        receiver.setSettings({ test_management: { enabled: false } })

        runDisableTest(done, false)
      })

      onlyLatestIt('does not enable disable tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runDisableTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
      })
    })

    context('quarantine', () => {
      beforeEach(() => {
        receiver.setTestManagementTests({
          mocha: {
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

      const getTestAssertions = (isQuarantining) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isQuarantining) {
              assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
              // Session should pass because the only failing test is quarantined
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

            const failedTest = tests.find(
              test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
            )
            // The test fails but the exit code is 0 if it's quarantined
            assert.strictEqual(failedTest.meta[TEST_STATUS], 'fail')

            if (isQuarantining) {
              assert.strictEqual(failedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            } else {
              assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in failedTest.meta))
            }
          })

      const runQuarantineTest = (done, isQuarantining, extraEnvVars = {}) => {
        let stdout = ''
        const testAssertionsPromise = getTestAssertions(isQuarantining)

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: JSON.stringify([
                './test-management/test-quarantine-1.js',
              ]),
              SHOULD_CHECK_RESULTS: '1',
              ...extraEnvVars,
            },
          }
        )

        childProcess.stdout?.on('data', (data) => {
          stdout += data
        })

        childProcess.on('exit', (exitCode) => {
          testAssertionsPromise.then(() => {
            // it runs regardless of the quarantine status
            assert.match(stdout, /I am running when quarantined/)
            if (isQuarantining) {
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

        runQuarantineTest(done, true)
      })

      onlyLatestIt('can disable tests in parallel mode', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runQuarantineTest(done, true,
          {
            RUN_IN_PARALLEL: '1',
            TESTS_TO_RUN: JSON.stringify([
              './test-management/test-quarantine-1.js',
              './test-management/test-quarantine-2.js',
            ]),
          }
        )
      })

      onlyLatestIt('fails if quarantine is not enabled', (done) => {
        receiver.setSettings({ test_management: { enabled: false } })

        runQuarantineTest(done, false)
      })

      onlyLatestIt('does not enable quarantine tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
        receiver.setSettings({ test_management: { enabled: true } })

        runQuarantineTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
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

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-management/test-attempt-to-fix-1.js',
            ]),
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

    onlyLatestIt(
      'works in parallel mode with test management enabled but ITR and suite skipping disabled',
      async () => {
        // This test reproduces the bug from issue #7222 where a missing 'else' keyword
        // caused onFinishRequest() to be called twice when test management is enabled
        // but ITR and suite skipping are disabled, resulting in the error:
        // "invalid state transition: RUNNING => RUNNING"
        let testOutput = ''
        receiver.setSettings({
          test_management: { enabled: true },
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: false,
          known_tests_enabled: true,
        })
        receiver.setTestManagementTests({
          mocha: {
            suites: {},
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
            assert.strictEqual(testSession.meta[MOCHA_IS_PARALLEL], 'true')
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.ok(tests.length > 0)
            const suiteEvents = events.filter(event => event.type === 'test_suite_end')
            assert.strictEqual(suiteEvents.length, 2, 'Expected exactly 2 suites to be reported')
            // Verify that tests have different runtime IDs, confirming parallel execution in different processes
            // Group tests by their suite to get one test from each worker
            const testsBySuite = {}
            for (const test of tests) {
              const suiteName = test.meta[TEST_SUITE]
              if (!testsBySuite[suiteName]) {
                testsBySuite[suiteName] = test
              }
            }
            const testFromEachWorker = Object.values(testsBySuite)
            assert.strictEqual(testFromEachWorker.length, 2, 'Expected tests from 2 different suites')
            const testRuntimeIds = testFromEachWorker.map(test => test.meta['runtime-id'])
            assert.ok(testRuntimeIds[0], 'First test should have a runtime-id')
            assert.ok(testRuntimeIds[1], 'Second test should have a runtime-id')
            // This checks that the two tests come from different workers/processes
            assert.notStrictEqual(
              testRuntimeIds[0],
              testRuntimeIds[1],
              'Tests from different workers should have different runtime-ids'
            )
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha --parallel --jobs 2 ./ci-visibility/test/ci-visibility-test*',
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
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

        // Verify no "invalid state transition" error occurred
        assert.doesNotMatch(testOutput, /invalid state transition/)
      })
  })

  context('libraries capabilities', () => {
    const getTestAssertions = (isParallel) =>
      receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), (payloads) => {
        const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

        assert.ok(metadataDicts.length > 0)
        metadataDicts.forEach(metadata => {
          if (isParallel) {
            assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], undefined)
            assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX], undefined)
          } else {
            assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], '1')
            assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX], '5')
          }
          assert.strictEqual(metadata.test[DD_CAPABILITIES_EARLY_FLAKE_DETECTION], '1')
          assert.strictEqual(metadata.test[DD_CAPABILITIES_AUTO_TEST_RETRIES], '1')
          assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE], '1')
          assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE], '1')
          assert.strictEqual(metadata.test[DD_CAPABILITIES_FAILED_TEST_REPLAY], '1')
          // capabilities logic does not overwrite test session name
          assert.strictEqual(metadata.test[TEST_SESSION_NAME], 'my-test-session-name')
        })
      })

    const runTest = (done, isParallel, extraEnvVars = {}) => {
      const testAssertionsPromise = getTestAssertions(isParallel)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_TEST_SESSION_NAME: 'my-test-session-name',
            ...extraEnvVars,
          },
        }
      )
      childProcess.on('exit', () => {
        testAssertionsPromise.then(() => done()).catch(done)
      })
    }

    it('adds capabilities to tests', (done) => {
      runTest(done, false)
    })

    onlyLatestIt('adds capabilities to tests (parallel)', (done) => {
      runTest(done, true, {
        RUN_IN_PARALLEL: '1',
      })
    })
  })

  context('retry and hooks', () => {
    it('works when tests are not retried', async () => {
      let stdout = ''
      const eventsPromise = receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        assert.strictEqual(tests.length, 2)

        assertObjectContains(tests.map(test => test.meta[TEST_STATUS]), [
          'pass',
          'pass',
        ])

        assertObjectContains(tests.map(test => test.resource), [
          'ci-visibility/test-nested-hooks/test-nested-hooks.js.describe is not nested',
          'ci-visibility/test-nested-hooks/test-nested-hooks.js.describe context nested test with retries',
        ])
      })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-nested-hooks/test-nested-hooks.js',
            ]),
          },
        }
      )

      childProcess.stdout?.on('data', (data) => {
        stdout += data
      })

      await Promise.all([
        once(childProcess, 'exit'),
        once(childProcess.stdout, 'end'),
        eventsPromise,
      ])

      assert.match(stdout, /beforeEach/)
      assert.match(stdout, /beforeEach in context/)
      assert.match(stdout, /test/)
      assert.match(stdout, /afterEach/)
      assert.match(stdout, /afterEach in context/)
    })

    onlyLatestIt('works when tests are retried', async () => {
      let stdout = ''
      const eventsPromise = receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        assert.strictEqual(tests.length, 3)

        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]), [
          'fail',
          'pass',
          'pass',
        ])

        assert.deepStrictEqual(tests.map(test => test.resource), [
          'ci-visibility/test-nested-hooks/test-nested-hooks.js.describe is not nested',
          'ci-visibility/test-nested-hooks/test-nested-hooks.js.describe is not nested',
          'ci-visibility/test-nested-hooks/test-nested-hooks.js.describe context nested test with retries',
        ])

        const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
        assert.strictEqual(retriedTests.length, 1)
        assert.strictEqual(retriedTests[0].meta[TEST_STATUS], 'pass')

        const notNestedTests = tests.filter(test => test.resource ===
          'ci-visibility/test-nested-hooks/test-nested-hooks.js.describe is not nested'
        )

        assert.strictEqual(notNestedTests.length, 2)
        const failedAttempts = notNestedTests.filter(test => test.meta[TEST_STATUS] === 'fail')
        assert.strictEqual(failedAttempts.length, 1)
        const passedAttempts = notNestedTests.filter(test => test.meta[TEST_STATUS] === 'pass')
        assert.strictEqual(passedAttempts.length, 1)
      })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-nested-hooks/test-nested-hooks.js',
            ]),
            SHOULD_FAIL: '1',
          },
        }
      )

      childProcess.stdout?.on('data', (data) => {
        stdout += data
      })

      await Promise.all([
        once(childProcess, 'exit'),
        once(childProcess.stdout, 'end'),
        eventsPromise,
      ])

      assert.match(stdout, /beforeEach/)
      assert.match(stdout, /beforeEach in context/)
      assert.match(stdout, /test/)
      assert.match(stdout, /afterEach/)
      assert.match(stdout, /afterEach in context/)
    })
  })

  context('impacted tests', () => {
    const NUM_RETRIES = 3

    beforeEach(() => {
      receiver.setKnownTests({
        mocha: {
          'ci-visibility/test-impacted-test/test-impacted-1.js': ['impacted tests can pass normally'],
        },
      })
    })

    // Modify `test-impacted-1.js` to mark it as impacted
    before(() => {
      execSync('git checkout -b feature-branch', { cwd, stdio: 'ignore' })
      fs.writeFileSync(
        path.join(cwd, 'ci-visibility/test-impacted-test/test-impacted-1.js'),
        `const assert = require('assert')
         describe('impacted tests', () => {
           it('can pass normally', () => {
             assert.strictEqual(2 + 2, 3)
           })

           it('can fail', () => {
             assert.strictEqual(1 + 2, 4)
           })
         })`
      )
      execSync('git add ci-visibility/test-impacted-test/test-impacted-1.js', { cwd, stdio: 'ignore' })
      execSync('git commit -m "modify test-impacted-1.js"', { cwd, stdio: 'ignore' })
    })

    after(() => {
      // We can't use main here because in CI it might be "master".
      // We just use `-` which goes back to the previous branch
      execSync('git checkout -', { cwd, stdio: 'ignore' })
      execSync('git branch -D feature-branch', { cwd, stdio: 'ignore' })
    })

    const getTestAssertions = ({ isModified, isEfd, isParallel, isNew }) =>
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
            // Parallel mode in mocha requires more than a single test suite
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
            // Need to filter down to 'impacted tests can pass normally' because
            // the other test is also retried. This is because we don't have line visibility:
            // We'll retry all the test in a file as long as any of them is modified.
            const retriedTests = tests.filter(
              test => test.meta[TEST_IS_RETRY] === 'true' &&
              test.meta[TEST_NAME] === 'impacted tests can pass normally'
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

    const runImpactedTest = async (
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
            TESTS_TO_RUN: JSON.stringify([
              './test-impacted-test/test-impacted-1',
            ]),
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
          receiver.setSettings({ impacted_tests_enabled: false })

          await runImpactedTest(
            { isModified: false },
            { DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: '0' }
          )
        })

      onlyLatestIt('should be detected as impacted in parallel mode', async () => {
        receiver.setSettings({ impacted_tests_enabled: true })

        await runImpactedTest(
          { isModified: true, isParallel: true },
          {
            // we need to run more than 1 suite for parallel mode to kick in
            TESTS_TO_RUN: JSON.stringify([
              './test-impacted-test/test-impacted-1',
              './test-impacted-test/test-impacted-2',
            ]),
            RUN_IN_PARALLEL: 'true',
          }
        )
      })

      context('test is new', () => {
        it('should be retried and marked both as new and modified', async () => {
          receiver.setKnownTests({
            mocha: {},
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
          await runImpactedTest(
            { isModified: true, isEfd: true, isNew: true }
          )
        })
      })
    })
  })

  context('preserves test function on retries', () => {
    const getTestAssertions = () =>
      receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        if (MOCHA_VERSION === 'latest') {
          assert.strictEqual(tests.length, 3)
          const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(failedTests.length, 2)
          const passedTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          assert.strictEqual(passedTests.length, 1)
          const [passedTest] = passedTests
          assert.strictEqual(passedTest.meta[TEST_IS_RETRY], 'true')
        } else {
          // there's no `retry` handled so it's just reported as a single passed test event
          // because the test ends up passing after retries
          assert.strictEqual(tests.length, 1)
          const passedTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          assert.strictEqual(passedTests.length, 1)
        }
      })

    it('respects "done" callback', async () => {
      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './mocha-retries-test-fn/mocha-done.js',
            ]),
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        getTestAssertions(),
      ])
    })
    it('respects async/await', async () => {
      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './mocha-retries-test-fn/mocha-async.js',
            ]),
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        getTestAssertions(),
      ])
    })
    it('respects promises', async () => {
      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './mocha-retries-test-fn/mocha-promise.js',
            ]),
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        getTestAssertions(),
      ])
    })
    it('respects sync functions', async () => {
      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './mocha-retries-test-fn/mocha-sync.js',
            ]),
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        getTestAssertions(),
      ])
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

          assert.strictEqual(coverageReport.coverageFile.name, 'coverage')
          assert.ok(coverageReport.coverageFile.content.includes('SF:')) // LCOV format

          assert.strictEqual(coverageReport.eventFile.name, 'event')
          assert.strictEqual(coverageReport.eventFile.content.type, 'coverage_report')
          assert.strictEqual(coverageReport.eventFile.content.format, 'lcov')
          assert.strictEqual(coverageReport.eventFile.content[GIT_COMMIT_SHA], gitCommitSha)
          assert.strictEqual(coverageReport.eventFile.content[GIT_REPOSITORY_URL], gitRepositoryUrl)
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
  })
})
