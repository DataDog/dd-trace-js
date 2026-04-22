'use strict'

const assert = require('node:assert/strict')

const { once } = require('node:events')
const { exec, execSync } = require('child_process')
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
  TEST_STATUS,
  TEST_TYPE,
  TEST_IS_RETRY,
  TEST_CODE_OWNERS,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_SESSION_NAME,
  TEST_COMMAND,
  TEST_LEVEL_EVENT_TYPES,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
  TEST_IS_NEW,
  TEST_NAME,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_SUITE,
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
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  DD_CAPABILITIES_EARLY_FLAKE_DETECTION,
  DD_CAPABILITIES_AUTO_TEST_RETRIES,
  DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE,
  DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE,
  DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX,
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  TEST_RETRY_REASON_TYPES,
  TEST_HAS_DYNAMIC_NAME,
  TEST_IS_MODIFIED,
  DD_CAPABILITIES_IMPACTED_TESTS,
  VITEST_POOL,
  TEST_IS_TEST_FRAMEWORK_WORKER,
  GIT_COMMIT_SHA,
  GIT_REPOSITORY_URL,
  DD_CI_LIBRARY_CONFIGURATION_ERROR,
  TEST_FINAL_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { TELEMETRY_COVERAGE_UPLOAD } = require('../../packages/dd-trace/src/ci-visibility/telemetry')
const { NODE_MAJOR } = require('../../version')

const NUM_RETRIES_EFD = 3

// vitest@4.x requires Node.js >= 20
const versions = NODE_MAJOR <= 18 ? ['1.6.0', '3'] : ['1.6.0', 'latest']

const linePctMatchRegex = /Lines\s+:\s+([\d.]+)%/

versions.forEach((version) => {
  describe(`vitest@${version}`, () => {
    let cwd, receiver, childProcess, testOutput

    useSandbox([
      `vitest@${version}`,
      `@vitest/coverage-istanbul@${version}`,
      `@vitest/coverage-v8@${version}`,
      'tinypool',
    ], true)

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

    const poolConfig = ['forks', 'threads']

    poolConfig.forEach((poolConfig) => {
      it(`can run and report tests with pool=${poolConfig}`, async () => {
        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
              DD_TEST_SESSION_NAME: 'my-test-session',
              POOL_CONFIG: poolConfig,
              DD_SERVICE: undefined,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            metadataDicts.forEach(metadata => {
              for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
                assert.strictEqual(metadata[testLevel][TEST_SESSION_NAME], 'my-test-session')
              }
            })

            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')

            if (poolConfig === 'threads') {
              assert.strictEqual(testSessionEvent.content.meta[VITEST_POOL], 'worker_threads')
            } else {
              assert.strictEqual(testSessionEvent.content.meta[VITEST_POOL], 'child_process')
            }

            const testModuleEvent = events.find(event => event.type === 'test_module_end')
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            assert.ok(testSessionEvent.content.resource.includes('test_session.vitest run'))
            assert.strictEqual(testSessionEvent.content.meta[TEST_STATUS], 'fail')
            assert.ok(testModuleEvent.content.resource.includes('test_module.vitest run'))
            assert.strictEqual(testModuleEvent.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSessionEvent.content.meta[TEST_TYPE], 'test')
            assert.strictEqual(testModuleEvent.content.meta[TEST_TYPE], 'test')

            const passedSuite = testSuiteEvents.find(
              suite =>
                suite.content.resource === 'test_suite.ci-visibility/vitest-tests/test-visibility-passed-suite.mjs'
            )
            assert.strictEqual(passedSuite.content.meta[TEST_STATUS], 'pass')

            const failedSuite = testSuiteEvents.find(
              suite =>
                suite.content.resource === 'test_suite.ci-visibility/vitest-tests/test-visibility-failed-suite.mjs'
            )
            assert.strictEqual(failedSuite.content.meta[TEST_STATUS], 'fail')

            const failedSuiteHooks = testSuiteEvents.find(
              suite =>
                suite.content.resource === 'test_suite.ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs'
            )
            assert.strictEqual(failedSuiteHooks.content.meta[TEST_STATUS], 'fail')

            assert.deepStrictEqual(testEvents.map(test => test.content.resource).sort(),
              [
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report failed test',
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report more',
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report more',
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report passed test',
                'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
                '.test-visibility-failed-suite-first-describe can report failed test',
                'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
                '.test-visibility-failed-suite-first-describe can report more',
                'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
                '.test-visibility-failed-suite-second-describe can report more',
                'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
                '.test-visibility-failed-suite-second-describe can report passed test',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.context can report more',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.context can report passed test',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.no suite',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can programmatic skip',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can report more',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can report passed test',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can skip',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can todo',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.programmatic skip no suite',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.skip no suite',
              ]
            )

            const failedTests = testEvents.filter(test => test.content.meta[TEST_STATUS] === 'fail')

            assertObjectContains(
              failedTests.map(test => test.content.resource).sort(),
              [
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report failed test',
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report more',
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report more',
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report passed test',
                'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
                '.test-visibility-failed-suite-first-describe can report failed test',
              ]
            )

            const skippedTests = testEvents.filter(test => test.content.meta[TEST_STATUS] === 'skip')

            assertObjectContains(
              skippedTests.map(test => test.content.resource),
              [
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can skip',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can todo',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can programmatic skip',
              ]
            )

            testEvents.forEach(test => {
              // `threads` config will report directly. TODO: update this once we're testing vitest@>=4
              if (poolConfig === 'forks') {
                assert.strictEqual(test.content.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
              }
              assert.strictEqual(test.content.meta[TEST_COMMAND], 'vitest run')
              assert.ok(test.content.metrics[DD_HOST_CPU_COUNT])
              assert.strictEqual(test.content.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'false')
            })

            testSuiteEvents.forEach(testSuite => {
              // `threads` config will report directly. TODO: update this once we're testing vitest@>=4
              if (poolConfig === 'forks') {
                assert.strictEqual(testSuite.content.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
              }
              assert.strictEqual(testSuite.content.meta[TEST_COMMAND], 'vitest run')
              assert.strictEqual(
                testSuite.content.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/vitest-tests/test-visibility'),
                true
              )
              assert.strictEqual(testSuite.content.metrics[TEST_SOURCE_START], 1)
              assert.ok(testSuite.content.metrics[DD_HOST_CPU_COUNT])
            })
          }),
        ])
      })
    })

    it('propagates test span context to HTTP requests and hooks during test execution', async () => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const spans = events.filter(event => event.type === 'span').map(event => event.content)

          // --- Test function: HTTP request + custom tag ---
          const httpTestSpan = tests.find(
            test => test.meta[TEST_NAME] === 'vitest-test-integration-http can do integration http'
          )
          assert.ok(httpTestSpan, 'should have http test span')
          assert.strictEqual(httpTestSpan.meta[TEST_STATUS], 'pass')
          assert.strictEqual(httpTestSpan.meta['test.custom_tag'], 'custom_value',
            'custom tag set via active span should be present')

          const testHttpSpans = spans.filter(span =>
            span.name === 'http.request' &&
            span.trace_id.toString() === httpTestSpan.trace_id.toString()
          )
          assert.ok(testHttpSpans.length > 0, 'should have http span with matching trace_id')

          const testHttpSpan = testHttpSpans.find(span =>
            span.parent_id.toString() === httpTestSpan.span_id.toString()
          )
          assert.ok(testHttpSpan, 'HTTP span from test fn should be child of test span')
          assert.match(testHttpSpan.meta['http.url'], /\/info/)

          // --- beforeEach + afterEach hooks: HTTP requests ---
          const hookTestSpan = tests.find(
            test => test.meta[TEST_NAME] === 'vitest-test-hook-http hook http is linked to test span'
          )
          assert.ok(hookTestSpan, 'should have hook test span')
          assert.strictEqual(hookTestSpan.meta[TEST_STATUS], 'pass')

          const hookHttpSpans = spans.filter(span =>
            span.name === 'http.request' &&
            span.trace_id.toString() === hookTestSpan.trace_id.toString() &&
            span.parent_id.toString() === hookTestSpan.span_id.toString()
          )
          assert.strictEqual(hookHttpSpans.length, 2,
            'should have 2 http spans from hooks (beforeEach + afterEach) as children of test span')

          const cleanupHookTestName =
            'vitest-test-before-each-cleanup-http beforeEach cleanup http is linked to test span'
          const cleanupHookTestSpan = tests.find(test => test.meta[TEST_NAME] === cleanupHookTestName)
          assert.ok(cleanupHookTestSpan, 'should have beforeEach cleanup hook test span')
          assert.strictEqual(cleanupHookTestSpan.meta[TEST_STATUS], 'pass')

          const cleanupHookHttpSpans = spans.filter(span =>
            span.name === 'http.request' &&
            span.trace_id.toString() === cleanupHookTestSpan.trace_id.toString() &&
            span.parent_id.toString() === cleanupHookTestSpan.span_id.toString()
          )
          assert.strictEqual(cleanupHookHttpSpans.length, 2,
            'should have 2 http spans from beforeEach and its returned cleanup as children of test span')
        }, 25000)

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/http-integration*',
            DD_SERVICE: undefined,
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    context('error tags', () => {
      it('tags session and children with _dd.ci.library_configuration_error when settings fails', async () => {
        receiver.setSettingsResponseCode(404)
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR], 'true')
            const testEvent = events.find(event => event.type === 'test')
            assert.ok(testEvent, 'should have test event')
            assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR], 'true')
          })
        childProcess = exec('./node_modules/.bin/vitest run', {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
          },
        })
        await Promise.all([eventsPromise, once(childProcess, 'exit')])
      })
    })

    it('sends telemetry with test_session metric when telemetry is enabled', async () => {
      const telemetryPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/apmtelemetry'), (payloads) => {
          const telemetryMetrics = payloads.flatMap(({ payload }) => payload.payload.series)

          const testSessionMetric = telemetryMetrics.find(
            ({ metric }) => metric === 'test_session'
          )

          assert.ok(testSessionMetric, 'test_session telemetry metric should be sent')
        })

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            DD_TRACE_AGENT_PORT: String(receiver.port),
            DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            TEST_DIR: 'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        telemetryPromise,
      ])
    })

    context('flaky test retries', () => {
      it('can retry flaky tests', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          assert.strictEqual(testEvents.length, 11)
          assertObjectContains(testEvents.map(test => test.content.resource), [
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            // passes at the third retry
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            // never passes
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            // passes on the first try
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary',
          ])
          const eventuallyPassingTest = testEvents.filter(
            test => test.content.resource ===
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass'
          )
          assert.strictEqual(eventuallyPassingTest.length, 4)
          assert.strictEqual(eventuallyPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'fail').length, 3)
          assert.strictEqual(eventuallyPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'pass').length, 1)
          assert.strictEqual(
            eventuallyPassingTest.filter(test => test.content.meta[TEST_IS_RETRY] === 'true').length,
            3
          )
          assert.strictEqual(eventuallyPassingTest.filter(test =>
            test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 3)

          const neverPassingTest = testEvents.filter(
            test => test.content.resource ===
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass'
          )
          assert.strictEqual(neverPassingTest.length, 6)
          assert.strictEqual(neverPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'fail').length, 6)
          assert.strictEqual(neverPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'pass').length, 0)
          assert.strictEqual(neverPassingTest.filter(test => test.content.meta[TEST_IS_RETRY] === 'true').length, 5)
          assert.strictEqual(neverPassingTest.filter(test =>
            test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 5)
        }).then(() => done()).catch(done)

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            },
          }
        )
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

        receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          assert.strictEqual(testEvents.length, 3)
          assertObjectContains(testEvents.map(test => test.content.resource), [
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary',
          ])
          assert.strictEqual(testEvents.filter(
            test => test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 0)
        }).then(() => done()).catch(done)

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            },
          }
        )
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

        receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          assert.strictEqual(testEvents.length, 5)
          assertObjectContains(testEvents.map(test => test.content.resource), [
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary',
          ])
          assert.strictEqual(testEvents.filter(
            test => test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 2)
        }).then(() => done()).catch(done)

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            },
          }
        )
      })

      it('sets TEST_HAS_FAILED_ALL_RETRIES when all ATR attempts fail', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          flaky_test_retries_count: 2,
          early_flake_detection: {
            enabled: false,
          },
        })

        const eventsPromise = receiver.gatherPayloadsMaxTimeout(
          ({ url }) => url === '/api/v2/citestcycle',
          payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const neverPassingTest = tests.filter(
              test => test.resource ===
                'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass'
            )
            assert.strictEqual(neverPassingTest.length, 3, '1 initial + 2 ATR retries')
            neverPassingTest.forEach(t => assert.strictEqual(t.meta[TEST_STATUS], 'fail'))

            const lastAttempt = neverPassingTest[neverPassingTest.length - 1]
            assert.strictEqual(lastAttempt.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')

            for (let i = 0; i < neverPassingTest.length - 1; i++) {
              assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in neverPassingTest[i].meta))
            }
          }
        )

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        await Promise.all([once(childProcess, 'exit'), eventsPromise])
      })
    })

    it('correctly calculates test code owners when working directory is not repository root', (done) => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const test = events.find(event => event.type === 'test').content
          const testSuite = events.find(event => event.type === 'test_suite_end').content
          assert.strictEqual(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
          assert.strictEqual(testSuite.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
        }, 25000)

      childProcess = exec(
        '../../node_modules/.bin/vitest run',
        {
          cwd: `${cwd}/ci-visibility/subproject`,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: './vitest-test.mjs',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    // total code coverage only works for >=2.0.0
    // v4 dropped support for Node 18. Every test but this once passes, so we'll leave them
    // for now. The breaking change is in https://github.com/vitest-dev/vitest/commit/9a0bf2254
    // shipped in https://github.com/vitest-dev/vitest/releases/tag/v4.0.0-beta.12
    if (version === 'latest' && NODE_MAJOR >= 20) {
      const coverageProviders = ['v8', 'istanbul']

      coverageProviders.forEach((coverageProvider) => {
        it(`reports code coverage for ${coverageProvider} provider`, async () => {
          let codeCoverageExtracted
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content

              codeCoverageExtracted = testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT]
            })

          childProcess = exec(
            './node_modules/.bin/vitest run --coverage',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                COVERAGE_PROVIDER: coverageProvider,
                TEST_DIR: 'ci-visibility/vitest-tests/coverage-test.mjs',
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
            eventsPromise,
          ])

          const linePctMatch = testOutput.match(linePctMatchRegex)
          const linesPctFromNyc = Number(linePctMatch[1])

          assert.strictEqual(
            linesPctFromNyc,
            codeCoverageExtracted,
            'coverage reported by vitest does not match extracted coverage'
          )
        })
      })

      it('reports zero code coverage for instanbul provider', async () => {
        let codeCoverageExtracted
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content

            codeCoverageExtracted = testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT]
          })

        childProcess = exec(
          './node_modules/.bin/vitest run --coverage',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              COVERAGE_PROVIDER: 'istanbul',
              TEST_DIR: 'ci-visibility/vitest-tests/coverage-test-zero.mjs',
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
          eventsPromise,
        ])

        const linePctMatch = testOutput.match(linePctMatchRegex)
        const linesPctFromNyc = Number(linePctMatch[1])

        assert.strictEqual(
          linesPctFromNyc,
          codeCoverageExtracted,
          'coverage reported by vitest does not match extracted coverage'
        )
        assert.strictEqual(
          linesPctFromNyc,
          0,
          'zero coverage should be reported'
        )
      })
    }

    context('early flake detection', () => {
      it('retries new tests', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection can retry tests that eventually fail', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // skipped so not retried
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 14)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
              'early flake detection can retry tests that eventually fail',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // 4 executions of the 3 new tests + 1 new skipped test (not retried)
            assert.strictEqual(newTests.length, 13)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 9) // 3 retries of the 3 new tests

            retriedTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
            })

            // exit code should be 0 and test session should be reported as passed,
            // even though there are some failing executions
            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 3)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testSessionEvent.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              SHOULD_ADD_EVENTUALLY_FAIL: '1',
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

      it('fails if all the attempts fail', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // skipped so not retried
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 10)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // 4 executions of the 2 new tests + 1 new skipped test (not retried)
            assert.strictEqual(newTests.length, 9)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 6) // 3 retries of the 2 new tests

            // the multiple attempts did not result in a single pass,
            // so the test session should be reported as failed
            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 6)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSessionEvent.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

            // Check that TEST_HAS_FAILED_ALL_RETRIES is set for tests that fail all EFD attempts
            const alwaysFailTests = tests.filter(test =>
              test.meta[TEST_NAME] === 'early flake detection can retry tests that always pass'
            )
            assert.strictEqual(alwaysFailTests.length, 4) // 1 initial + 3 retries
            // The last execution should have TEST_HAS_FAILED_ALL_RETRIES set
            const testsWithFlag = alwaysFailTests.filter(test =>
              test.meta[TEST_HAS_FAILED_ALL_RETRIES] === 'true'
            )
            assert.strictEqual(
              testsWithFlag.length,
              1,
              'Exactly one test should have TEST_HAS_FAILED_ALL_RETRIES set'
            )
            // It should be the last one
            const lastAttempt = alwaysFailTests[alwaysFailTests.length - 1]
            assert.strictEqual(
              lastAttempt.meta[TEST_HAS_FAILED_ALL_RETRIES],
              'true',
              'Last attempt should have the flag'
            )
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              ALWAYS_FAIL: 'true',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('bails out of EFD if the percentage of new tests is too high', (done) => {
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
          vitest: {},
        }) // tests from ci-visibility/vitest-tests/early-flake-detection.mjs will be new

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 4)

            const newTests = tests.filter(
              test => test.meta[TEST_IS_NEW] === 'true'
            )
            // no new tests
            assert.strictEqual(newTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 4)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])

            // new tests are detected but not retried
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 3)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 1)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('does not run EFD if the known tests request fails', (done) => {
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
        receiver.setKnownTests({})

        // Request module waits before retrying — need longer gather timeout
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 4)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 1)
            const testSessionEnd = events.find(event => event.type === 'test_session_end')
            assert.ok(testSessionEnd, 'expected test_session_end event in payloads')
            const testSessionEvent = testSessionEnd.content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
          }, 60000)

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('works when the cwd is not the repository root', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/subproject/vitest-test.mjs': [
              'context can report passed test', // no test will be considered new
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            // no retries
            assert.strictEqual(tests.length, 1)

            assert.strictEqual(tests[0].meta[TEST_SUITE], 'ci-visibility/subproject/vitest-test.mjs')
            // it's not considered new
            assert.ok(!(TEST_IS_NEW in tests[0].meta))
          })

        childProcess = exec(
          '../../node_modules/.bin/vitest run',
          {
            cwd: `${cwd}/ci-visibility/subproject`,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
              TEST_DIR: './vitest-test.mjs',
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

      it('works with repeats config when EFD is disabled', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: false,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection can retry tests that eventually fail', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 8)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that eventually pass', // repeated twice
              'early flake detection can retry tests that always pass', // repeated twice
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // all but one are considered new
            assert.strictEqual(newTests.length, 7)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 4) // 2 repetitions on 2 tests

            // vitest reports the test as failed if any of the repetitions fail, so we'll follow that
            // TODO: we might want to improve this
            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 3)

            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSessionEvent.meta))
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              SHOULD_REPEAT: '1',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('disables early flake detection if known tests should not be requested', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: false,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 4)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])

            // new tests are not detected and not retried
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 1)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('does not detect new tests if the response is invalid', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          'not-vitest': {},
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 4)

            const newTests = tests.filter(
              test => test.meta[TEST_IS_NEW] === 'true'
            )
            // no new tests
            assert.strictEqual(newTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )
        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('tags new tests with dynamic names and logs a warning', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: { '5s': 1 },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })
        receiver.setKnownTests({ vitest: {} })

        const eventsPromise = receiver.gatherPayloadsMaxTimeout(
          ({ url }) => url === '/api/v2/citestcycle',
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const uniqueTests = new Map()
            for (const test of tests) {
              if (!uniqueTests.has(test.meta[TEST_NAME])) {
                uniqueTests.set(test.meta[TEST_NAME], test)
              }
            }

            const dynamicTests = [...uniqueTests.values()]
              .filter(test => test.meta[TEST_HAS_DYNAMIC_NAME] === 'true')
            assert.strictEqual(dynamicTests.length, 8)

            dynamicTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
            })
          }
        )

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/dynamic-name-test*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        let testOutput = ''
        childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
        childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

        await Promise.all([once(childProcess, 'exit'), eventsPromise])

        assert.match(testOutput, /detected as new but their names contain dynamic data/)
      })
    })

    // dynamic instrumentation only supported from >=2.0.0
    if (version === 'latest') {
      context('dynamic instrumentation', () => {
        it('does not activate it if DD_TEST_FAILED_TEST_REPLAY_ENABLED is set to false', (done) => {
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
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/dynamic-instrumentation*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
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

        it('does not activate dynamic instrumentation if remote settings are disabled', (done) => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: false,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

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
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/dynamic-instrumentation*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
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
            di_enabled: true,
          })

          let snapshotIdByTest, snapshotIdByLog
          let spanIdByTest, spanIdByLog, traceIdByTest, traceIdByLog

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

              assert.strictEqual(retriedTests.length, 1)
              const [retriedTest] = retriedTests

              assert.strictEqual(retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED], 'true')

              assert.strictEqual(retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
                .endsWith('ci-visibility/vitest-tests/bad-sum.mjs'), true)
              assert.strictEqual(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 4)

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
              assert.match(diLog.ddtags, /git.repository_url:/)
              assert.match(diLog.ddtags, /git.commit.sha:/)
              assert.strictEqual(diLog.debugger.snapshot.language, 'javascript')
              assertObjectContains(diLog.debugger.snapshot.captures.lines['4'].locals, {
                a: {
                  type: 'number',
                  value: '11',
                },
                b: {
                  type: 'number',
                  value: '2',
                },
                localVar: {
                  type: 'number',
                  value: '10',
                },
              })
              spanIdByLog = diLog.dd.span_id
              traceIdByLog = diLog.dd.trace_id
              snapshotIdByLog = diLog.debugger.snapshot.id
            }, 5000)

          childProcess = exec(
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/dynamic-instrumentation*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
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

        it('does not crash if the retry does not hit the breakpoint', (done) => {
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
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/breakpoint-not-hit*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          childProcess.on('exit', () => {
            Promise.all([eventsPromise, logsPromise]).then(() => {
              done()
            }).catch(done)
          })
        })

        it('does not hang when tests use fake timers and Failed Test Replay is enabled', async () => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              assert.strictEqual(tests.length, 2)
              const retriedTests = tests.filter(t => t.meta[TEST_IS_RETRY] === 'true')
              assert.strictEqual(retriedTests.length, 1)
            })

          childProcess = exec(
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/fake-timers-di*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
          assert.strictEqual(exitCode, 1)
        })
      })
    }

    context('known tests without early flake detection', () => {
      it('detects new tests without retrying them', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: false,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 4)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // all but one are considered new
            assert.strictEqual(newTests.length, 3)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 1)

            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSessionEvent.meta))
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })
    })

    it('sets _dd.test.is_user_provided_service to true if DD_SERVICE is used', (done) => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(test => test.content)
          tests.forEach(test => {
            assert.strictEqual(test.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'true')
          })
        })

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            DD_SERVICE: 'my-service',
          },
        }
      )

      childProcess.on('exit', (exitCode) => {
        eventsPromise.then(() => {
          assert.strictEqual(exitCode, 1)
          done()
        }).catch(done)
      })
    })

    if (version === 'latest') {
      context('test management', () => {
        context('attempt to fix', () => {
          beforeEach(() => {
            receiver.setTestManagementTests({
              vitest: {
                suites: {
                  'ci-visibility/vitest-tests/test-attempt-to-fix.mjs': {
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
            isAttemptingToFix,
            shouldAlwaysPass,
            shouldFailSometimes,
            isQuarantining,
            isDisabling,
          }) =>
            receiver
              .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const testSession = events.find(event => event.type === 'test_session_end').content

                if (isAttemptingToFix) {
                  assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
                } else {
                  assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
                }

                const resourceNames = tests.map(span => span.resource)

                assertObjectContains(resourceNames,
                  [
                    'ci-visibility/vitest-tests/test-attempt-to-fix.mjs.attempt to fix tests can attempt to fix a test',
                  ]
                )

                const attemptedToFixTests = tests.filter(
                  test => test.meta[TEST_NAME] === 'attempt to fix tests can attempt to fix a test'
                )

                for (let i = 0; i < attemptedToFixTests.length; i++) {
                  const isFirstAttempt = i === 0
                  const isLastAttempt = i === attemptedToFixTests.length - 1
                  const test = attemptedToFixTests[i]
                  if (isQuarantining) {
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
                  } else if (isDisabling) {
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
                  }

                  if (isAttemptingToFix) {
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
                    if (isFirstAttempt) {
                      assert.ok(!(TEST_IS_RETRY in test.meta))
                      assert.ok(!(TEST_RETRY_REASON in test.meta))
                      assert.ok(!(TEST_FINAL_STATUS in test.meta))
                      continue
                    }
                    assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                    assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
                    if (isLastAttempt) {
                      if (shouldAlwaysPass) {
                        assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
                      } else if (shouldFailSometimes) {
                        assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                        assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                      } else {
                        assert.strictEqual(test.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
                        assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                      }
                      if (shouldAlwaysPass) {
                        assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
                      } else if (isQuarantining || isDisabling) {
                        assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'skip')
                      } else {
                        assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'fail')
                      }
                    } else {
                      // Intermediate ATF executions must not carry a final status tag
                      assert.ok(!(TEST_FINAL_STATUS in test.meta))
                    }
                  } else {
                    assert.ok(!(TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX in test.meta))
                    assert.ok(!(TEST_IS_RETRY in test.meta))
                    assert.ok(!(TEST_RETRY_REASON in test.meta))
                  }
                }
              })

          /**
           * @param {() => void} done
           * @param {{
           *   isAttemptingToFix?: boolean,
           *   shouldAlwaysPass?: boolean,
           *   isQuarantining?: boolean,
           *   shouldFailSometimes?: boolean,
           *   isDisabling?: boolean,
           *   extraEnvVars?: Record<string, string>
           * }} [options]
           */
          const runAttemptToFixTest = (done, {
            isAttemptingToFix,
            shouldAlwaysPass,
            isQuarantining,
            shouldFailSometimes,
            shouldFailFirstOnly,
            isDisabling,
            extraEnvVars = {},
          } = {}) => {
            let stdout = ''
            const testAssertionsPromise = getTestAssertions({
              isAttemptingToFix,
              shouldAlwaysPass,
              shouldFailSometimes,
              isQuarantining,
              isDisabling,
            })
            childProcess = exec(
              './node_modules/.bin/vitest run',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  TEST_DIR: 'ci-visibility/vitest-tests/test-attempt-to-fix*',
                  NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
                  ...extraEnvVars,
                  ...(shouldAlwaysPass ? { SHOULD_ALWAYS_PASS: '1' } : {}),
                  ...(shouldFailSometimes ? { SHOULD_FAIL_SOMETIMES: '1' } : {}),
                  ...(shouldFailFirstOnly ? { SHOULD_FAIL_FIRST_ONLY: '1' } : {}),
                },
              }
            )

            childProcess.stdout?.on('data', (data) => {
              stdout += data
            })

            childProcess.on('exit', (exitCode) => {
              testAssertionsPromise.then(() => {
                assert.match(stdout, /I am running/)
                if (shouldAlwaysPass || (isAttemptingToFix && isQuarantining) || (isAttemptingToFix && isDisabling)) {
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

            runAttemptToFixTest(done, { isAttemptingToFix: true })
          })

          it('can attempt to fix and mark last attempt as passed if every attempt passes', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done, { isAttemptingToFix: true, shouldAlwaysPass: true })
          })

          it('can attempt to fix and not mark last attempt if attempts both pass and fail', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done, { isAttemptingToFix: true, shouldFailSometimes: true })
          })

          it('does not suppress exit code for plain ATF tests even when last retry passes', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done, { isAttemptingToFix: true, shouldFailFirstOnly: true })
          })

          it('does not attempt to fix tests if test management is not enabled', (done) => {
            receiver.setSettings({ test_management: { enabled: false, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done)
          })

          it('does not enable attempt to fix tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done, { extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } })
          })

          it('does not tag known attempt to fix tests as new', async () => {
            receiver.setKnownTests({
              vitest: {
                'ci-visibility/vitest-tests/test-attempt-to-fix.mjs': [
                  'attempt to fix tests can attempt to fix a test',
                ],
              },
            })
            receiver.setSettings({
              test_management: { enabled: true, attempt_to_fix_retries: 2 },
              early_flake_detection: {
                enabled: true,
                slow_test_retries: { '5s': 2 },
                faulty_session_threshold: 100,
              },
              known_tests_enabled: true,
            })

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const atfTests = tests.filter(
                  t => t.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] === 'true'
                )
                assert.ok(atfTests.length > 0)
                for (const test of atfTests) {
                  assert.ok(
                    !(TEST_IS_NEW in test.meta),
                    'ATF test that is in known tests should not be tagged as new'
                  )
                }
              })

            childProcess = exec(
              './node_modules/.bin/vitest run',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  TEST_DIR: 'ci-visibility/vitest-tests/test-attempt-to-fix*',
                  NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
                },
              }
            )

            await Promise.all([
              once(childProcess, 'exit'),
              eventsPromise,
            ])
          })

          it('does not fail retry if a test is quarantined', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
            receiver.setTestManagementTests({
              vitest: {
                suites: {
                  'ci-visibility/vitest-tests/test-attempt-to-fix.mjs': {
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

            runAttemptToFixTest(done, { isAttemptingToFix: true, isQuarantining: true })
          })

          it('does not fail retry if a test is disabled', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
            receiver.setTestManagementTests({
              vitest: {
                suites: {
                  'ci-visibility/vitest-tests/test-attempt-to-fix.mjs': {
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

            runAttemptToFixTest(done, { isAttemptingToFix: true, isDisabling: true })
          })
        })

        context('disabled', () => {
          beforeEach(() => {
            receiver.setTestManagementTests({
              vitest: {
                suites: {
                  'ci-visibility/vitest-tests/test-disabled.mjs': {
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
              .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                assert.strictEqual(tests.length, 1)

                const testSession = events.find(event => event.type === 'test_session_end').content

                if (isDisabling) {
                  assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
                } else {
                  assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
                }

                const resourceNames = tests.map(span => span.resource)

                assertObjectContains(resourceNames,
                  [
                    'ci-visibility/vitest-tests/test-disabled.mjs.disable tests can disable a test',
                  ]
                )

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

          const runDisableTest = (done, isDisabling, extraEnvVars = {}) => {
            let stdout = ''
            const testAssertionsPromise = getTestAssertions(isDisabling)

            childProcess = exec(
              './node_modules/.bin/vitest run',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  TEST_DIR: 'ci-visibility/vitest-tests/test-disabled*',
                  NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
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

          it('fails if disable is not enabled', (done) => {
            receiver.setSettings({ test_management: { enabled: false } })

            runDisableTest(done, false)
          })

          it('does not disable tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
            receiver.setSettings({ test_management: { enabled: true } })

            runDisableTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
          })
        })

        context('quarantine', () => {
          beforeEach(() => {
            receiver.setTestManagementTests({
              vitest: {
                suites: {
                  'ci-visibility/vitest-tests/test-quarantine.mjs': {
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
              .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                assert.strictEqual(tests.length, 2)

                const testSession = events.find(event => event.type === 'test_session_end').content

                if (isQuarantining) {
                  assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
                } else {
                  assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
                }

                const resourceNames = tests.map(span => span.resource)

                assertObjectContains(resourceNames,
                  [
                    'ci-visibility/vitest-tests/test-quarantine.mjs.quarantine tests can quarantine a test',
                    'ci-visibility/vitest-tests/test-quarantine.mjs.quarantine tests can pass normally',
                  ]
                )

                const quarantinedTest = tests.find(
                  test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
                )

                if (isQuarantining) {
                  assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
                  assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
                } else {
                  assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
                  assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in quarantinedTest.meta))
                }
              })

          const runQuarantineTest = (done, isQuarantining, extraEnvVars = {}) => {
            let stdout = ''
            const testAssertionsPromise = getTestAssertions(isQuarantining)

            childProcess = exec(
              './node_modules/.bin/vitest run',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  TEST_DIR: 'ci-visibility/vitest-tests/test-quarantine*',
                  NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
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
                  // exit code 0 even though one of the tests failed
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

          it('fails if quarantine is not enabled', (done) => {
            receiver.setSettings({ test_management: { enabled: false } })

            runQuarantineTest(done, false)
          })

          it('does not enable quarantine tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
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

          // Request module waits before retrying — need longer gather timeout
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSessionEnd = events.find(event => event.type === 'test_session_end')
              assert.ok(testSessionEnd, 'expected test_session_end event in payloads')
              const testSession = testSessionEnd.content
              assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              // it is not retried
              assert.strictEqual(tests.length, 1)
            }, 60000)

          childProcess = exec(
            './node_modules/.bin/vitest run',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/test-attempt-to-fix*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
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
    }

    context('libraries capabilities', () => {
      it('adds capabilities to tests', (done) => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            assert.ok(metadataDicts.length > 0)
            metadataDicts.forEach(metadata => {
              assert.ok(!Object.hasOwn(metadata.test, DD_CAPABILITIES_TEST_IMPACT_ANALYSIS))

              assertObjectContains(metadata.test, {
                [DD_CAPABILITIES_EARLY_FLAKE_DETECTION]: '1',
                [DD_CAPABILITIES_AUTO_TEST_RETRIES]: '1',
                [DD_CAPABILITIES_IMPACTED_TESTS]: '1',
                [DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE]: '1',
                [DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE]: '1',
                [DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX]: '5',
                [DD_CAPABILITIES_FAILED_TEST_REPLAY]: '1',
                // capabilities logic does not overwrite test session name
                [TEST_SESSION_NAME]: 'my-test-session-name',
              })
            })
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
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

    context('impacted tests', () => {
      beforeEach(() => {
        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/impacted-test.mjs': [
              'impacted test can impacted test',
            ],
          },
        })
      })

      // Modify `impacted-test.mjs` to mark it as impacted
      before(() => {
        execSync('git checkout -b feature-branch', { cwd, stdio: 'ignore' })
        fs.writeFileSync(
          path.join(cwd, 'ci-visibility/vitest-tests/impacted-test.mjs'),
          `import { describe, test, expect } from 'vitest'
           describe('impacted test', () => {
             test('can impacted test', () => {
               assert.strictEqual(1 + 2, 4)
             })
           })`
        )
        execSync('git add ci-visibility/vitest-tests/impacted-test.mjs', { cwd, stdio: 'ignore' })
        execSync('git commit -m "modify impacted-test.mjs"', { cwd, stdio: 'ignore' })
      })

      after(() => {
        execSync('git checkout -', { cwd, stdio: 'ignore' })
        execSync('git branch -D feature-branch', { cwd, stdio: 'ignore' })
      })

      /**
       * @param {{
       *   isModified?: boolean,
       *   isEfd?: boolean,
       *   isNew?: boolean,
       * }} options
       */
      const getTestAssertions = ({ isModified, isEfd, isNew }) =>
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
                'ci-visibility/vitest-tests/impacted-test.mjs.impacted test can impacted test',
              ]
            )

            const impactedTests = tests.filter(test =>
              test.meta[TEST_SOURCE_FILE] === 'ci-visibility/vitest-tests/impacted-test.mjs' &&
              test.meta[TEST_NAME] === 'impacted test can impacted test')

            if (isEfd) {
              assert.strictEqual(impactedTests.length, NUM_RETRIES_EFD + 1) // Retries + original test
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
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
              assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
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
              assert.strictEqual(retriedTestNew, isNew ? NUM_RETRIES_EFD : 0)
              assert.strictEqual(retriedTestsWithReason, NUM_RETRIES_EFD)
            }
          })

      const runImpactedTest = (
        done,
        { isModified, isEfd = false, isNew = false },
        extraEnvVars = {}
      ) => {
        const testAssertionsPromise = getTestAssertions({ isModified, isEfd, isNew })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/impacted-test*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
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
      })

      context('test is new', () => {
        it('should be retried and marked both as new and modified', (done) => {
          receiver.setKnownTests({
            vitest: {},
          })
          receiver.setSettings({
            impacted_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD,
              },
            },
            known_tests_enabled: true,
          })
          runImpactedTest(done, { isModified: true, isEfd: true, isNew: true })
        })
      })
    })

    it('does not blow up when tinypool is used outside of a test', (done) => {
      childProcess = exec('node ./ci-visibility/run-tinypool.mjs', {
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
        assert.match(testOutput, /result 10/)
        assert.strictEqual(code, 0)
        done()
      })
    })

    context('programmatic api', () => {
      it('can report data using the vitest programmatic api', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')
            const testModuleEvent = events.find(event => event.type === 'test_module_end')
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            assert.strictEqual(testSessionEvent.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testModuleEvent.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSessionEvent.content.meta[TEST_TYPE], 'test')
            assert.strictEqual(testModuleEvent.content.meta[TEST_TYPE], 'test')

            const testSuite = testSuiteEvents.find(
              suite => suite.content.resource ===
                'test_suite.ci-visibility/vitest-tests-programmatic-api/test-programmatic-api.mjs'
            )
            assert.strictEqual(testSuite.content.meta[TEST_STATUS], 'fail')

            assert.strictEqual(testEvents.length, 3)
          })

        childProcess = exec(
          'node run-programmatic-api.mjs',
          {
            cwd: `${cwd}/ci-visibility/vitest-tests-programmatic-api`,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              TEST_DIR: './test-programmatic-api*',
            },
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })
    })

    // Coverage report upload only works for >=2.0.0 (when vitest has proper coverage support)
    // v4 dropped support for Node 18
    if (version === 'latest' && NODE_MAJOR >= 20) {
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
            './node_modules/.bin/vitest run --coverage',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                COVERAGE_PROVIDER: 'v8',
                TEST_DIR: 'ci-visibility/vitest-tests/coverage-test.mjs',
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
            './node_modules/.bin/vitest run --coverage',
            {
              cwd,
              env: {
                ...getCiVisEvpProxyConfig(receiver.port),
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
                COVERAGE_PROVIDER: 'v8',
                TEST_DIR: 'ci-visibility/vitest-tests/coverage-test.mjs',
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
            './node_modules/.bin/vitest run --coverage',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                COVERAGE_PROVIDER: 'v8',
                TEST_DIR: 'ci-visibility/vitest-tests/coverage-test.mjs',
                DD_GIT_COMMIT_SHA: gitCommitSha,
                DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
              },
            }
          )

          await once(childProcess, 'exit')

          assert.strictEqual(coverageReportUploaded, false, 'coverage report should not be uploaded')
        })
      })
    }

    context('final status tag', () => {
      it('sets final_status tag to test status on regular tests without retry features', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: false,
          early_flake_detection: { enabled: false },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            tests.forEach(test => {
              assert.strictEqual(
                test.meta[TEST_FINAL_STATUS],
                test.meta[TEST_STATUS],
                `Expected TEST_FINAL_STATUS to match TEST_STATUS for test "${test.meta[TEST_NAME]}"`
              )
            })
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              // Runs test-visibility-passed-suite (pass/skip), test-visibility-failed-suite
              // (fail/pass with hooks), and test-visibility-failed-hooks (fail due to hook throws)
              TEST_DIR: 'ci-visibility/vitest-tests/test-visibility*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        await Promise.all([once(childProcess, 'exit'), eventsPromise])
      })

      it('sets final_status tag to test status reported to test framework on last retry (ATR active only)',
        async () => {
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            flaky_test_retries_enabled: true,
            early_flake_detection: { enabled: false },
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const assertAtrFinalStatus = (testName, expectedFinalStatus) => {
                const group = tests.filter(t => t.meta[TEST_NAME] === testName)
                group.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
                  .forEach((test, index) => {
                    if (index < group.length - 1) {
                      assert.ok(!(TEST_FINAL_STATUS in test.meta),
                        `TEST_FINAL_STATUS should not be set on attempt ${index} of "${testName}"`
                      )
                    } else {
                      assert.strictEqual(test.meta[TEST_FINAL_STATUS], expectedFinalStatus)
                    }
                  })
              }

              // Test that always passes on the first try: final_status is set immediately
              const alwaysPassingTests = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test retries does not retry if unnecessary'
              )
              assert.strictEqual(alwaysPassingTests.length, 1)
              assert.strictEqual(alwaysPassingTests[0].meta[TEST_FINAL_STATUS], 'pass')

              assertAtrFinalStatus('flaky test retries can retry tests that eventually pass', 'pass')
              assertAtrFinalStatus('flaky test retries can retry tests that never pass', 'fail')

              // With hooks: same behavior
              const alwaysPassingTestsWithHooks = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test retries with hooks does not retry if unnecessary'
              )
              assert.strictEqual(alwaysPassingTestsWithHooks.length, 1)
              assert.strictEqual(alwaysPassingTestsWithHooks[0].meta[TEST_FINAL_STATUS], 'pass')

              assertAtrFinalStatus('flaky test retries with hooks can retry tests that eventually pass', 'pass')
              assertAtrFinalStatus('flaky test retries with hooks can retry tests that never pass', 'fail')
            })

          childProcess = exec(
            './node_modules/.bin/vitest run',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/{flaky-test-retries,hooks-flaky-test-retries}.mjs',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          await Promise.all([once(childProcess, 'exit'), eventsPromise])
        })

      it('sets final_status tag to test status reported to test framework on last retry (EFD active only)',
        async () => {
          receiver.setKnownTests({
            vitest: {
              'ci-visibility/vitest-tests/early-flake-detection.mjs': [
                'early flake detection does not retry if it is not new',
              ],
              'ci-visibility/vitest-tests/hooks-flaky-test-retries.mjs': [
                'flaky test retries with hooks does not retry if unnecessary',
              ],
            },
          })
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              slow_test_retries: { '5s': NUM_RETRIES_EFD },
              faulty_session_threshold: 100,
            },
            known_tests_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              // Known test: not retried, every execution is already the final one
              const knownTests = tests.filter(
                test => test.meta[TEST_NAME] === 'early flake detection does not retry if it is not new'
              )
              assert.strictEqual(knownTests.length, 1)
              assert.ok(!(TEST_IS_NEW in knownTests[0].meta))
              assert.ok(!(TEST_IS_RETRY in knownTests[0].meta))
              assert.strictEqual(knownTests[0].meta[TEST_FINAL_STATUS], knownTests[0].meta[TEST_STATUS])

              const assertEfdFinalStatus = (testName, expectedFinalStatus) => {
                const group = tests.filter(t => t.meta[TEST_NAME] === testName)
                group.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
                  .forEach((test, index) => {
                    if (index < group.length - 1) {
                      assert.ok(!(TEST_FINAL_STATUS in test.meta))
                    } else {
                      assert.strictEqual(test.meta[TEST_FINAL_STATUS], expectedFinalStatus)
                    }
                  })
              }

              assertEfdFinalStatus('early flake detection can retry tests that eventually pass', 'pass')
              assertEfdFinalStatus('early flake detection can retry tests that always pass', 'pass')

              // With hooks: same behavior
              const knownTestsWithHooks = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test retries with hooks does not retry if unnecessary'
              )
              assert.strictEqual(knownTestsWithHooks.length, 1)
              assert.ok(!(TEST_IS_NEW in knownTestsWithHooks[0].meta))
              assert.ok(!(TEST_IS_RETRY in knownTestsWithHooks[0].meta))
              assert.strictEqual(knownTestsWithHooks[0].meta[TEST_FINAL_STATUS], knownTestsWithHooks[0].meta[TEST_STATUS])

              assertEfdFinalStatus('flaky test retries with hooks can retry tests that eventually pass', 'pass')
              assertEfdFinalStatus('flaky test retries with hooks can retry tests that never pass', 'fail')
            })

          childProcess = exec(
            './node_modules/.bin/vitest run',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/{early-flake-detection,hooks-flaky-test-retries}.mjs',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          await Promise.all([once(childProcess, 'exit'), eventsPromise])
        })

      it('sets final_status tag only on last ATR retry when EFD is enabled but not active and ATR is active',
        async () => {
          // All tests are known so EFD will be enabled but not active for them
          receiver.setKnownTests({
            vitest: {
              'ci-visibility/vitest-tests/flaky-test-retries.mjs': [
                'flaky test retries can retry tests that eventually pass',
                'flaky test retries can retry tests that never pass',
                'flaky test retries does not retry if unnecessary',
              ],
              'ci-visibility/vitest-tests/hooks-flaky-test-retries.mjs': [
                'flaky test retries with hooks can retry tests that eventually pass',
                'flaky test retries with hooks can retry tests that never pass',
                'flaky test retries with hooks does not retry if unnecessary',
              ],
            },
          })
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: { '5s': 3 },
              faulty_session_threshold: 100,
            },
            known_tests_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const eventuallyPassingTests = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test retries can retry tests that eventually pass'
              )
              eventuallyPassingTests.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
                .forEach((test, idx) => {
                  if (idx < eventuallyPassingTests.length - 1) {
                    assert.ok(!(TEST_FINAL_STATUS in test.meta),
                      'TEST_FINAL_STATUS should not be set on previous ATR runs'
                    )
                  } else {
                    assert.strictEqual(test.meta[TEST_FINAL_STATUS], test.meta[TEST_STATUS])
                    assert.strictEqual(test.meta[TEST_STATUS], 'pass')
                  }
                })

              const alwaysPassingTests = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test retries does not retry if unnecessary'
              )
              assert.strictEqual(alwaysPassingTests.length, 1)
              assert.strictEqual(alwaysPassingTests[0].meta[TEST_FINAL_STATUS], 'pass')

              // With hooks: same behavior
              const eventuallyPassingTestsWithHooks = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test retries with hooks can retry tests that eventually pass'
              )
              eventuallyPassingTestsWithHooks.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
                .forEach((test, idx) => {
                  if (idx < eventuallyPassingTestsWithHooks.length - 1) {
                    assert.ok(!(TEST_FINAL_STATUS in test.meta),
                      'TEST_FINAL_STATUS should not be set on previous ATR runs'
                    )
                  } else {
                    assert.strictEqual(test.meta[TEST_FINAL_STATUS], test.meta[TEST_STATUS])
                    assert.strictEqual(test.meta[TEST_STATUS], 'pass')
                  }
                })

              const alwaysPassingTestsWithHooks = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test retries with hooks does not retry if unnecessary'
              )
              assert.strictEqual(alwaysPassingTestsWithHooks.length, 1)
              assert.strictEqual(alwaysPassingTestsWithHooks[0].meta[TEST_FINAL_STATUS], 'pass')
            })

          childProcess = exec(
            './node_modules/.bin/vitest run',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/{flaky-test-retries,hooks-flaky-test-retries}.mjs',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          await Promise.all([once(childProcess, 'exit'), eventsPromise])
        })

      if (version === 'latest') {
        it('sets final_status tag to skip for disabled tests', async () => {
          receiver.setSettings({ test_management: { enabled: true } })
          receiver.setTestManagementTests({
            vitest: {
              suites: {
                'ci-visibility/vitest-tests/test-disabled.mjs': {
                  tests: {
                    'disable tests can disable a test': {
                      properties: { disabled: true },
                    },
                  },
                },
                'ci-visibility/vitest-tests/hooks-test-management.mjs': {
                  tests: {
                    'test management with hooks can apply management to a failing test with hooks': {
                      properties: { disabled: true },
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

              const disabledTest = tests.find(test => test.meta[TEST_NAME] === 'disable tests can disable a test')
              assert.ok(disabledTest, 'Expected to find the disabled test')
              assert.strictEqual(disabledTest.meta[TEST_STATUS], 'skip')
              assert.strictEqual(disabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
              assert.strictEqual(disabledTest.meta[TEST_FINAL_STATUS], 'skip')

              // With hooks: same behavior
              const disabledTestWithHooks = tests.find(
                test => test.meta[TEST_NAME] ===
                  'test management with hooks can apply management to a failing test with hooks'
              )
              assert.ok(disabledTestWithHooks, 'Expected to find the disabled test with hooks')
              assert.strictEqual(disabledTestWithHooks.meta[TEST_STATUS], 'skip')
              assert.strictEqual(disabledTestWithHooks.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
              assert.strictEqual(disabledTestWithHooks.meta[TEST_FINAL_STATUS], 'skip')
            })

          childProcess = exec(
            './node_modules/.bin/vitest run',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/{test-disabled,hooks-test-management}.mjs',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
              },
            }
          )

          await Promise.all([once(childProcess, 'exit'), eventsPromise])
        })

        it('sets final_status tag to skip for quarantined tests', async () => {
          receiver.setSettings({ test_management: { enabled: true } })
          receiver.setTestManagementTests({
            vitest: {
              suites: {
                'ci-visibility/vitest-tests/test-quarantine.mjs': {
                  tests: {
                    'quarantine tests can quarantine a test': {
                      properties: { quarantined: true },
                    },
                  },
                },
                'ci-visibility/vitest-tests/hooks-test-management.mjs': {
                  tests: {
                    'test management with hooks can apply management to a failing test with hooks': {
                      properties: { quarantined: true },
                    },
                  },
                },
                'ci-visibility/vitest-tests/hooks-test-quarantine-failing-after-each.mjs': {
                  tests: {
                    'quarantine tests with failing afterEach can quarantine a test whose afterEach hook fails': {
                      properties: { quarantined: true },
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

              const quarantinedTest = tests.find(
                test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
              )
              assert.ok(quarantinedTest, 'Expected to find the quarantined test')
              // Quarantined test still runs and reports its actual status,
              // but the final status must be 'skip' (errors are suppressed)
              assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
              assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')

              const passingTest = tests.find(test => test.meta[TEST_NAME] === 'quarantine tests can pass normally')
              assert.ok(passingTest, 'Expected to find the passing test')
              assert.strictEqual(passingTest.meta[TEST_STATUS], 'pass')
              assert.strictEqual(passingTest.meta[TEST_FINAL_STATUS], 'pass')

              // With hooks: same behavior
              const quarantinedTestWithHooks = tests.find(
                test => test.meta[TEST_NAME] ===
                  'test management with hooks can apply management to a failing test with hooks'
              )
              assert.ok(quarantinedTestWithHooks, 'Expected to find the quarantined test with hooks')
              assert.strictEqual(quarantinedTestWithHooks.meta[TEST_STATUS], 'fail')
              assert.strictEqual(quarantinedTestWithHooks.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              assert.strictEqual(quarantinedTestWithHooks.meta[TEST_FINAL_STATUS], 'skip')

              const passingTestWithHooks = tests.find(
                test => test.meta[TEST_NAME] === 'test management with hooks can pass normally with hooks'
              )
              assert.ok(passingTestWithHooks, 'Expected to find the passing test with hooks')
              assert.strictEqual(passingTestWithHooks.meta[TEST_STATUS], 'pass')
              assert.strictEqual(passingTestWithHooks.meta[TEST_FINAL_STATUS], 'pass')

              // With hooks where afterEach throws: test body passes but hook causes failure — still skip
              const quarantinedTestFailingAfterEach = tests.find(
                test => test.meta[TEST_NAME] ===
                  'quarantine tests with failing afterEach can quarantine a test whose afterEach hook fails'
              )
              assert.ok(quarantinedTestFailingAfterEach, 'Expected to find the quarantined test with failing afterEach')
              assert.strictEqual(quarantinedTestFailingAfterEach.meta[TEST_STATUS], 'fail')
              assert.strictEqual(quarantinedTestFailingAfterEach.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              assert.strictEqual(quarantinedTestFailingAfterEach.meta[TEST_FINAL_STATUS], 'skip')
            })

          childProcess = exec(
            './node_modules/.bin/vitest run',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/' +
                  '{test-quarantine,hooks-test-management,hooks-test-quarantine-failing-after-each}.mjs',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
              },
            }
          )

          await Promise.all([once(childProcess, 'exit'), eventsPromise])
        })
      }
    })
  })
})
