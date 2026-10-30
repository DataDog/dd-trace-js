'use strict'

const assert = require('node:assert/strict')
const { exec, execSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { inspect } = require('node:util')
const { assertObjectContains } = require('../helpers')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  stopCiVisTestEnv,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  ERROR_MESSAGE,
  ERROR_STACK,
  ERROR_TYPE,
} = require('../../packages/dd-trace/src/constants')
const {
  TEST_STATUS,
  TEST_SESSION_EMPTY_REASON,
  TEST_SKIP_REASON,
  TEST_TYPE,
  TEST_IS_RETRY,
  TEST_CODE_OWNERS,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_SESSION_NAME,
  TEST_COMMAND,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
  TEST_IS_MODIFIED,
  TEST_IS_NEW,
  TEST_NAME,
  TEST_SUITE,
  TEST_RETRY_REASON,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_RETRY_REASON_TYPES,
  TEST_FINAL_STATUS,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  VITEST_POOL,
  TEST_IS_TEST_FRAMEWORK_WORKER,
  TEST_SKIPPED_BY_ITR,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_ITR_SKIPPING_COUNT,
  TEST_CODE_COVERAGE_ENABLED,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { NODE_MAJOR } = require('../../version')
const { describeDynamicAtr } = require('./dynamic-atr')

const NUM_RETRIES_EFD = 3
const linePctMatchRegex = /Lines\s+:\s+([\d.]+)%/

function assertCompleteTestSessionTrace (events, testOutput) {
  const testSessionEvent = events.find(event => event.type === 'test_session_end')
  const testModuleEvent = events.find(event => event.type === 'test_module_end')
  const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
  const testEvents = events.filter(event => event.type === 'test')

  assert.ok(testSessionEvent, testOutput)
  assert.ok(testModuleEvent, testOutput)
  assert.ok(testSuiteEvent, testOutput)
  assert.ok(testEvents.length, testOutput)

  const testSession = testSessionEvent.content
  const testModule = testModuleEvent.content
  const testSuite = testSuiteEvent.content
  const tests = testEvents.map(event => event.content)
  const testSessionId = testSession.test_session_id.toString()
  const testModuleId = testModule.test_module_id.toString()
  const testSuiteId = testSuite.test_suite_id.toString()

  assert.strictEqual(testModule.test_session_id.toString(), testSessionId)
  assert.strictEqual(testSuite.test_session_id.toString(), testSessionId)
  assert.strictEqual(testSuite.test_module_id.toString(), testModuleId)

  for (const test of tests) {
    assert.strictEqual(test.test_session_id.toString(), testSessionId)
    assert.strictEqual(test.test_module_id.toString(), testModuleId)
    assert.strictEqual(test.test_suite_id.toString(), testSuiteId)
  }

  return {
    testSession,
    testModule,
    testSuite,
    tests,
  }
}

// vitest@4.x requires Node.js >= 20
const supportedVersions = NODE_MAJOR <= 18 ? ['1.6.0', '3.2.6'] : ['1.6.0', 'latest']
const requestedVersion = process.env.VITEST_VERSION
const versions = requestedVersion && requestedVersion !== 'all'
  ? [requestedVersion === 'oldest'
      ? supportedVersions[0]
      : requestedVersion === 'latest' ? supportedVersions.at(-1) : requestedVersion]
  : supportedVersions
const runVersionIndependentSuites = !requestedVersion || requestedVersion === 'all' || requestedVersion === 'latest'

versions.forEach((version) => {
  describe(`vitest@${version}`, () => {
    let cwd, receiver, childProcess, testOutput
    const newerVitestIt = version === '1.6.0' ? it.skip : it
    // Native module loading was introduced in Vitest 4.1; Vitest 5 requires Node.js >=22.
    const typecheckIt = version === '1.6.0' ? it.skip : it

    useSandbox([
      `vitest@${version}`,
      // Vite 8.3.5's source-map parser rejects the Buffers returned by Vitest's server runner.
      // TODO: remove the pin once Vitest reads cached server modules as UTF-8.
      ...(version === 'latest' ? ['vite@8.3.4'] : []),
      `@vitest/coverage-istanbul@${version}`,
      `@vitest/coverage-v8@${version}`,
      '@types/node',
      'tinypool',
      'typescript@6.0.3',
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

    for (const pool of poolConfig) {
      it(`reports tests with a mocked global URL and disabled DogStatsD (${pool})`, async () => {
        testOutput = ''
        receiver.setSettings({ itr_enabled: false })
        childProcess = exec('./node_modules/.bin/vitest run', {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            DD_INJECT_FORCE: 'true',
            DD_TRACE_AGENT_URL: `http://127.0.0.1:${receiver.port}`,
            DD_RUNTIME_METRICS_ENABLED: 'false',
            TEST_DIR: 'ci-visibility/vitest-tests/mocked-url.mjs',
            POOL_CONFIG: pool,
          },
        })
        childProcess.stdout.on('data', chunk => { testOutput += chunk.toString() })
        childProcess.stderr.on('data', chunk => { testOutput += chunk.toString() })

        const eventsPromise = receiver.gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle') || url === '/dogstatsd/v2/proxy',
          payloads => {
            const metrics = payloads.filter(({ url }) => url === '/dogstatsd/v2/proxy')
            assert.strictEqual(metrics.length, 0, `unexpected DogStatsD telemetry: ${testOutput}`)

            const events = payloads.filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
              .flatMap(({ payload }) => payload.events)
            const { testSession, testModule, testSuite, tests } = assertCompleteTestSessionTrace(events, testOutput)
            for (const event of [testSession, testModule, testSuite]) {
              assert.strictEqual(event.meta[TEST_STATUS], 'fail', testOutput)
            }
            assert.strictEqual(tests.length, 2, testOutput)
            const passedTest = tests.find(test => test.meta[TEST_NAME].endsWith('is disabled'))
            const failedTest = tests.find(test => test.meta[TEST_NAME].endsWith('original test failure'))
            assert.ok(passedTest, testOutput)
            assert.ok(failedTest, testOutput)
            assert.strictEqual(passedTest.meta[TEST_STATUS], 'pass', testOutput)
            assert.strictEqual(passedTest.error, 0)
            assert.strictEqual(failedTest.meta[TEST_STATUS], 'fail', testOutput)
            assert.strictEqual(failedTest.meta[ERROR_TYPE], 'Error')
            assert.strictEqual(failedTest.meta[ERROR_MESSAGE], 'expected test failure')
          }
        )
        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, 1, testOutput)
        assert.doesNotMatch(testOutput, /URL is not a constructor/)
      })
    }

    if (version === 'latest') {
      for (const pool of poolConfig) {
        describeDynamicAtr({
          mode: pool,
          getContext: () => ({
            cwd,
            receiver,
            env: { POOL_CONFIG: pool },
            onChildProcess: child => { childProcess = child },
          }),
        })
      }
    }

    newerVitestIt('reports a failed session when a custom reporter rejects onTestRunEnd', async function () {
      this.timeout(20_000)
      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs',
            VITEST_THROWING_REPORTER: '1',
          },
        }
      )

      const eventsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const { testSession, testModule, testSuite, tests } = assertCompleteTestSessionTrace(events, testOutput)

          assert.strictEqual(events.filter(event => event.type === 'test_suite_end').length, 1)
          for (const event of [testSession, testModule]) {
            assert.strictEqual(event.meta[TEST_STATUS], 'fail')
            assert.strictEqual(event.error, 1)
            assert.match(event.meta[ERROR_MESSAGE], /custom Vitest reporter failed/)
          }
          assert.strictEqual(testSuite.meta[TEST_STATUS], 'pass')
          assert.deepStrictEqual(
            [...new Set(tests.map(test => test.meta[TEST_STATUS]))].sort(),
            ['pass', 'skip']
          )
        },
        { hardTimeout: 20_000 }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      assert.notStrictEqual(exitCode, 0)
    })

    for (const { mode, args, reason, exitCode: expectedExitCode } of [
      { mode: 'skip-tests', args: '', reason: 'all_tests_skipped', exitCode: 0 },
      { mode: 'skip-suite', args: '', reason: 'all_tests_skipped', exitCode: 0 },
      { mode: 'mixed', args: '', reason: undefined, exitCode: 0 },
      { mode: 'mixed', args: '--testNamePattern never-matches', reason: 'all_tests_skipped', exitCode: 0 },
      { mode: 'mixed', args: 'never-matches --passWithNoTests', reason: 'zero_tests', exitCode: 0 },
      { mode: 'mixed', args: '--shard=2/2 --passWithNoTests', reason: 'zero_test_shard', exitCode: 0 },
      { mode: 'mixed', args: 'never-matches', reason: undefined, exitCode: 1 },
      { mode: 'error', args: '', reason: undefined, exitCode: 1 },
    ]) {
      it(`reports zero-execution sessions: ${mode} ${args}`, async () => {
        receiver.setSettings({ itr_enabled: false, tests_skipping: false, code_coverage: false })
        childProcess = exec('./node_modules/.bin/vitest run ' + args, {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/empty-session.mjs',
            EMPTY_SESSION_MODE: mode,
          },
        })
        childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
        childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })
        const eventsPromise = receiver.gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            for (const type of ['test_session_end', 'test_module_end']) {
              const event = events.find(event => event.type === type)?.content
              assert.ok(event, testOutput)
              const expectedStatus = expectedExitCode ? 'fail' : reason ? 'skip' : 'pass'
              assert.strictEqual(event.meta[TEST_STATUS], expectedStatus, testOutput)
              assert.strictEqual(event.meta[TEST_SESSION_EMPTY_REASON], reason, testOutput)
              assert.strictEqual(event.meta[TEST_SKIP_REASON], reason === 'all_tests_skipped'
                ? 'All tests were skipped'
                : reason === 'zero_test_shard'
                  ? 'No tests were assigned to this shard'
                  : reason === 'zero_tests' ? 'No tests were detected' : undefined)
            }
          }
        )
        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, expectedExitCode, testOutput)
      })
    }

    typecheckIt('reports a failed typecheck suite when a custom reporter rejects onTestRunEnd', async function () {
      this.timeout(20_000)
      childProcess = exec(
        './node_modules/.bin/vitest run --config=./vitest.typecheck.config.mjs ' +
          'ci-visibility/vitest-tests/typecheck.test-d.ts --reporter=verbose ' +
          '--reporter=./ci-visibility/vitest-reporter-throws.mjs',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
          },
        }
      )

      const eventsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const { testSession, testModule, testSuite } = assertCompleteTestSessionTrace(events, testOutput)

          assert.strictEqual(events.filter(event => event.type === 'test_suite_end').length, 1)
          for (const event of [testSession, testModule]) {
            assert.strictEqual(event.meta[TEST_STATUS], 'fail')
            assert.strictEqual(event.error, 1)
            assert.match(event.meta[ERROR_MESSAGE], /custom Vitest reporter failed/)
          }
          assert.strictEqual(testSuite.meta[TEST_STATUS], 'pass')
        },
        { hardTimeout: 20_000 }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      assert.notStrictEqual(exitCode, 0)
    })

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
              assert.strictEqual(metadata.test_levels[TEST_SESSION_NAME], 'my-test-session')
              assert.ok(metadata.test_levels[TEST_COMMAND])
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

            assert.ok(
              testSessionEvent.content.resource.includes('test_session.vitest run'),
              `Got: ${inspect(testSessionEvent.content.resource)}`
            )
            assert.strictEqual(testSessionEvent.content.meta[TEST_STATUS], 'fail')
            assert.ok(
              testModuleEvent.content.resource.includes('test_module.vitest run'),
              `Got: ${inspect(testModuleEvent.content.resource)}`
            )
            assert.strictEqual(testModuleEvent.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSessionEvent.content.meta[TEST_TYPE], 'test')
            assert.strictEqual(testModuleEvent.content.meta[TEST_TYPE], 'test')
            assert.strictEqual(
              testModuleEvent.content.test_session_id.toString(),
              testSessionEvent.content.test_session_id.toString()
            )
            testSuiteEvents.forEach(testSuiteEvent => {
              assert.strictEqual(
                testSuiteEvent.content.test_session_id.toString(),
                testSessionEvent.content.test_session_id.toString()
              )
              assert.strictEqual(
                testSuiteEvent.content.test_module_id.toString(),
                testModuleEvent.content.test_module_id.toString()
              )
            })

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
              assert.strictEqual(test.content.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
              assert.ok(test.content.metrics[DD_HOST_CPU_COUNT])
              assert.strictEqual(test.content.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'false')
            })

            testSuiteEvents.forEach(testSuite => {
              assert.strictEqual(testSuite.content.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
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

    it('does not report negative durations for short failed tests', async () => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 1)
          assert.strictEqual(tests[0].meta[TEST_NAME], 'reports a non-negative duration for a short failed test')
          assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
          assert.strictEqual(Number(tests[0].duration), 0)
        })

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/short-failed-test.mjs',
            VITEST_RUNNER: 'ci-visibility/vitest-tests/short-failed-test-runner.mjs',
            DD_SERVICE: undefined,
          },
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const [[code]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      assert.strictEqual(code, 1, testOutput)
    })

    for (const workerPoolConfig of poolConfig) {
      it(`sets DD_VITEST_WORKER in workers with pool=${workerPoolConfig}`, async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const test = events.find(event => event.type === 'test').content

            assert.ok(test)
            assert.strictEqual(test.meta[TEST_NAME], 'vitest worker env sets DD_VITEST_WORKER')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
          }, 25000)

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
              POOL_CONFIG: workerPoolConfig,
              DD_SERVICE: undefined,
            },
          }
        )

        const [[code]] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])

        assert.strictEqual(code, 0)
      })
    }

    newerVitestIt('sets DD_VITEST_WORKER in workers when a fork project has a threads root pool', async () => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const test = events.find(event => event.type === 'test').content

          assert.ok(test)
          assert.strictEqual(test.meta[TEST_NAME], 'vitest worker env sets DD_VITEST_WORKER')
          assert.strictEqual(test.meta[TEST_STATUS], 'pass')
        }, 25000)

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
            POOL_CONFIG: 'threads',
            PROJECT_POOL_CONFIG: 'forks',
            DD_SERVICE: undefined,
          },
        }
      )

      const [[code]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      assert.strictEqual(code, 0)
    })

    typecheckIt('can report typecheck tests', async () => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const {
            testSession,
            testModule,
            testSuite,
            tests,
          } = assertCompleteTestSessionTrace(events, testOutput)
          const passedTest = tests.find(test =>
            test.meta[TEST_NAME] === 'typecheck can report type assertion'
          )
          const skippedTest = tests.find(test =>
            test.meta[TEST_NAME] === 'typecheck can report skipped assertion'
          )
          const nestedTest = tests.find(test =>
            test.meta[TEST_NAME] === 'typecheck nested suite can report nested assertion'
          )

          assert.ok(passedTest, testOutput)
          assert.ok(skippedTest, testOutput)
          assert.ok(nestedTest, testOutput)

          assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testModule.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testSuite.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testSuite.meta[TEST_SOURCE_FILE], 'ci-visibility/vitest-tests/typecheck.test-d.ts')
          assert.strictEqual(passedTest.meta[TEST_STATUS], 'pass')
          assert.strictEqual(passedTest.meta[TEST_SOURCE_FILE], 'ci-visibility/vitest-tests/typecheck.test-d.ts')
          assert.strictEqual(skippedTest.meta[TEST_STATUS], 'skip')
          assert.strictEqual(skippedTest.meta[TEST_SOURCE_FILE], 'ci-visibility/vitest-tests/typecheck.test-d.ts')
          assert.strictEqual(nestedTest.meta[TEST_STATUS], 'pass')
          assert.strictEqual(nestedTest.meta[TEST_SOURCE_FILE], 'ci-visibility/vitest-tests/typecheck.test-d.ts')
        }, 25000)

      childProcess = exec(
        './node_modules/.bin/vitest run --config=./vitest.typecheck.config.mjs ' +
          'ci-visibility/vitest-tests/typecheck.test-d.ts --reporter=verbose',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            DD_SERVICE: undefined,
          },
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const [[code]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      assert.strictEqual(code, 0, testOutput)
    })

    /**
     * Runs Vitest typechecking with TIA settings and gathers all TIA payloads.
     *
     * @param {{ suitesToSkip: string[], testFilter?: string, env?: typeof process.env }} options
     * @param {(payloads: object[]) => void} assertPayloads
     * @returns {Promise<void>}
     */
    async function runTypecheckTiaTest ({ suitesToSkip, testFilter = '', env = {} }, assertPayloads) {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        coverage_report_upload_enabled: false,
        tests_skipping: true,
      })
      receiver.setSuitesToSkip(suitesToSkip.map(suite => ({
        type: 'suite',
        attributes: { suite },
      })))
      testOutput = ''

      childProcess = exec(
        `./node_modules/.bin/vitest run --config=./vitest.typecheck.config.mjs${testFilter} --reporter=verbose`,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            DD_SERVICE: undefined,
            ...env,
          },
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      await receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) =>
          url === '/api/v2/citestcycle' ||
          url === '/api/v2/citestcov' ||
          url === '/api/v2/ci/tests/skippable',
        assertPayloads,
        { hardTimeout: 60_000 }
      )

      assert.strictEqual(childProcess.exitCode, 0, testOutput)
    }

    typecheckIt('does not advertise or enable TIA for typecheck-only runs', async () => {
      const typecheckSuite = 'ci-visibility/vitest-tests/typecheck.test-d.ts'
      await runTypecheckTiaTest({
        suitesToSkip: [typecheckSuite],
        testFilter: ` ${typecheckSuite}`,
      }, (payloads) => {
        assert.strictEqual(payloads.some(({ url }) => url === '/api/v2/ci/tests/skippable'), false, testOutput)
        assert.strictEqual(payloads.some(({ url }) => url === '/api/v2/citestcov'), false, testOutput)

        const cyclePayloads = payloads.filter(({ url }) => url === '/api/v2/citestcycle')
        const metadataEntries = cyclePayloads.flatMap(({ payload }) => payload.metadata || [])
        assert.ok(metadataEntries.length > 0, testOutput)
        for (const metadata of metadataEntries) {
          assert.strictEqual(metadata.test?.[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], undefined)
        }

        const events = cyclePayloads.flatMap(({ payload }) => payload.events)
        const testSession = events.find(event => event.type === 'test_session_end').content
        const testSuites = events.filter(event => event.type === 'test_suite_end')
        assert.strictEqual(testSuites.length, 1, testOutput)
        assert.strictEqual(testSuites[0].content.meta[TEST_STATUS], 'pass')
        assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
        assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
      })
    })

    typecheckIt('applies TIA only to runtime suites in mixed typecheck runs', async () => {
      const typecheckSuite = 'ci-visibility/vitest-tests/typecheck.test-d.ts'
      const skippedRuntimeSuite = 'ci-visibility/vitest-tests/tia-first.mjs'
      const runningRuntimeSuite = 'ci-visibility/vitest-tests/tia-second.mjs'
      await runTypecheckTiaTest({
        suitesToSkip: [typecheckSuite, skippedRuntimeSuite],
        env: { TYPECHECK_MIXED: 'true' },
      }, (payloads) => {
        assert.strictEqual(payloads.some(({ url }) => url === '/api/v2/ci/tests/skippable'), true)

        const cyclePayloads = payloads.filter(({ url }) => url === '/api/v2/citestcycle')
        const metadataEntries = cyclePayloads.flatMap(({ payload }) => payload.metadata || [])
        assert.ok(metadataEntries.length > 0, testOutput)
        for (const metadata of metadataEntries) {
          assert.strictEqual(metadata.test?.[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], '1')
        }

        const events = cyclePayloads.flatMap(({ payload }) => payload.events)
        const testSession = events.find(event => event.type === 'test_session_end').content
        const testSuites = events.filter(event => event.type === 'test_suite_end')
        const typecheckEvent = testSuites.find(({ content }) => content.meta[TEST_SUITE] === typecheckSuite).content
        const skippedRuntimeEvent =
            testSuites.find(({ content }) => content.meta[TEST_SUITE] === skippedRuntimeSuite).content
        const runningRuntimeEvent =
            testSuites.find(({ content }) => content.meta[TEST_SUITE] === runningRuntimeSuite).content

        assert.strictEqual(testSuites.length, 3, testOutput)
        assert.strictEqual(typecheckEvent.meta[TEST_STATUS], 'pass')
        assert.strictEqual(skippedRuntimeEvent.meta[TEST_STATUS], 'skip')
        assert.strictEqual(skippedRuntimeEvent.meta[TEST_SKIPPED_BY_ITR], 'true')
        assert.strictEqual(runningRuntimeEvent.meta[TEST_STATUS], 'pass')
        assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
        assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
        assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)

        const suiteById = new Map(testSuites.map(({ content }) => [
          Number(content.test_suite_id),
          content.meta[TEST_SUITE],
        ]))
        const coverages = payloads
          .filter(({ url }) => url === '/api/v2/citestcov')
          .flatMap(({ payload }) => payload)
          .flatMap(({ content }) => content.coverages)
        const runtimeCoverage = coverages.find(coverage =>
          suiteById.get(coverage.test_suite_id) === runningRuntimeSuite
        )

        assert.ok(runtimeCoverage, testOutput)
        assert.deepStrictEqual(
          runtimeCoverage.files.map(({ filename }) => filename).sort(),
          [
            runningRuntimeSuite,
            'ci-visibility/vitest-tests/bad-sum.mjs',
          ].sort()
        )
      })
    })

    typecheckIt('does not skip a runtime suite that is also selected for typechecking', async () => {
      const runtimeOnlySuite = 'ci-visibility/vitest-tests/tia-first.mjs'
      const overlappingSuite = 'ci-visibility/vitest-tests/tia-typescript.test.ts'
      await runTypecheckTiaTest({
        suitesToSkip: [runtimeOnlySuite, overlappingSuite],
        env: {
          TYPECHECK_MIXED: 'true',
          TYPECHECK_OVERLAP: 'true',
        },
      }, (payloads) => {
        assert.strictEqual(payloads.some(({ url }) => url === '/api/v2/ci/tests/skippable'), true)

        const cyclePayloads = payloads.filter(({ url }) => url === '/api/v2/citestcycle')
        const events = cyclePayloads.flatMap(({ payload }) => payload.events)
        const testSession = events.find(event => event.type === 'test_session_end').content
        const testSuites = events.filter(event => event.type === 'test_suite_end')
        const runtimeOnlyEvent =
            testSuites.find(({ content }) => content.meta[TEST_SUITE] === runtimeOnlySuite).content
        const overlappingEvents =
            testSuites.filter(({ content }) => content.meta[TEST_SUITE] === overlappingSuite)

        assert.strictEqual(testSuites.length, 4, testOutput)
        assert.strictEqual(runtimeOnlyEvent.meta[TEST_STATUS], 'skip')
        assert.strictEqual(runtimeOnlyEvent.meta[TEST_SKIPPED_BY_ITR], 'true')
        assert.strictEqual(overlappingEvents.length, 2)
        assert.ok(overlappingEvents.every(({ content }) => content.meta[TEST_STATUS] === 'pass'))
        assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)

        const suiteById = new Map(testSuites.map(({ content }) => [
          Number(content.test_suite_id),
          content.meta[TEST_SUITE],
        ]))
        const coverages = payloads
          .filter(({ url }) => url === '/api/v2/citestcov')
          .flatMap(({ payload }) => payload)
          .flatMap(({ content }) => content.coverages)
        const overlappingCoverage = coverages.find(coverage =>
          suiteById.get(coverage.test_suite_id) === overlappingSuite
        )

        assert.ok(overlappingCoverage, testOutput)
        assert.deepStrictEqual(
          overlappingCoverage.files.map(({ filename }) => filename).sort(),
          [
            overlappingSuite,
            'ci-visibility/vitest-tests/tia-typescript-source.ts',
          ].sort()
        )
      })
    })

    typecheckIt('honors Known Tests metadata for typecheck tests', async () => {
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
          'ci-visibility/vitest-tests/typecheck.test-d.ts': [
            'typecheck can report type assertion',
          ],
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const knownTest = tests.find(test =>
            test.meta[TEST_NAME] === 'typecheck can report type assertion'
          )
          const newTest = tests.find(test =>
            test.meta[TEST_NAME] === 'typecheck can report disabled assertion'
          )

          assert.ok(knownTest, testOutput)
          assert.ok(newTest, testOutput)
          assert.ok(!(TEST_IS_NEW in knownTest.meta))
          assert.strictEqual(newTest.meta[TEST_IS_NEW], 'true')
        }, 25000)

      childProcess = exec(
        './node_modules/.bin/vitest run --config=./vitest.typecheck.config.mjs ' +
          'ci-visibility/vitest-tests/typecheck.test-d.ts --reporter=verbose',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            DD_SERVICE: undefined,
          },
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const [[code]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      assert.strictEqual(code, 0, testOutput)
    })

    typecheckIt('honors Impacted Tests metadata for typecheck tests', async () => {
      receiver.setSettings({ impacted_tests_enabled: true })

      const branchName = `typecheck-impacted-${process.pid}`
      execSync(`git checkout -b ${branchName}`, { cwd, stdio: 'ignore' })

      try {
        const typecheckFile = 'ci-visibility/vitest-tests/typecheck.test-d.ts'
        fs.appendFileSync(path.join(cwd, typecheckFile), '\n// impacted typecheck test\n')
        execSync(`git add ${typecheckFile}`, { cwd, stdio: 'ignore' })
        execSync('git commit -m "modify typecheck test"', { cwd, stdio: 'ignore' })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const impactedTest = tests.find(test =>
              test.meta[TEST_NAME] === 'typecheck can report type assertion'
            )

            assert.ok(impactedTest, testOutput)
            assert.strictEqual(impactedTest.meta[TEST_IS_MODIFIED], 'true')
          }, 25000)

        childProcess = exec(
          './node_modules/.bin/vitest run --config=./vitest.typecheck.config.mjs ' +
            'ci-visibility/vitest-tests/typecheck.test-d.ts --reporter=verbose',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              DD_SERVICE: undefined,
              GITHUB_BASE_REF: '',
            },
          }
        )
        childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
        childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

        const [[code]] = await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])

        assert.strictEqual(code, 0, testOutput)
      } finally {
        execSync('git checkout -', { cwd, stdio: 'ignore' })
        execSync(`git branch -D ${branchName}`, { cwd, stdio: 'ignore' })
      }
    })

    typecheckIt('honors Test Management metadata for typecheck tests', async () => {
      receiver.setSettings({ test_management: { enabled: true } })
      receiver.setTestManagementTests({
        vitest: {
          suites: {
            'ci-visibility/vitest-tests/typecheck.test-d.ts': {
              tests: {
                'typecheck can report disabled assertion': {
                  properties: {
                    disabled: true,
                  },
                },
                'typecheck can report quarantined assertion': {
                  properties: {
                    quarantined: true,
                  },
                },
                'typecheck can report attempt-to-fix assertion': {
                  properties: {
                    attempt_to_fix: true,
                  },
                },
                'typecheck can report skipped assertion': {
                  properties: {
                    attempt_to_fix: true,
                    quarantined: true,
                  },
                },
                'typecheck nested suite can report nested disabled assertion': {
                  properties: {
                    disabled: true,
                  },
                },
              },
            },
          },
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const disabledTest = tests.find(test =>
            test.meta[TEST_NAME] === 'typecheck can report disabled assertion'
          )
          const quarantinedTest = tests.find(test =>
            test.meta[TEST_NAME] === 'typecheck can report quarantined assertion'
          )
          const attemptToFixTest = tests.find(test =>
            test.meta[TEST_NAME] === 'typecheck can report attempt-to-fix assertion'
          )
          const skippedAttemptToFixTest = tests.find(test =>
            test.meta[TEST_NAME] === 'typecheck can report skipped assertion'
          )
          const nestedDisabledTest = tests.find(test =>
            test.meta[TEST_NAME] === 'typecheck nested suite can report nested disabled assertion'
          )

          assert.ok(disabledTest, testOutput)
          assert.ok(quarantinedTest, testOutput)
          assert.ok(attemptToFixTest, testOutput)
          assert.ok(skippedAttemptToFixTest, testOutput)
          assert.ok(nestedDisabledTest, testOutput)

          assert.strictEqual(disabledTest.meta[TEST_STATUS], 'skip')
          assert.strictEqual(disabledTest.meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(disabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')

          assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'pass')
          assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

          assert.strictEqual(attemptToFixTest.meta[TEST_STATUS], 'pass')
          assert.strictEqual(attemptToFixTest.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')

          assert.strictEqual(skippedAttemptToFixTest.meta[TEST_STATUS], 'skip')
          assert.strictEqual(skippedAttemptToFixTest.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
          assert.strictEqual(skippedAttemptToFixTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

          assert.strictEqual(nestedDisabledTest.meta[TEST_STATUS], 'skip')
          assert.strictEqual(nestedDisabledTest.meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(nestedDisabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
        }, 25000)

      childProcess = exec(
        './node_modules/.bin/vitest run --config=./vitest.typecheck.config.mjs ' +
          'ci-visibility/vitest-tests/typecheck.test-d.ts --reporter=verbose',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            DD_SERVICE: undefined,
          },
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const [[code]] = await Promise.all([
        once(childProcess, 'exit'),
        once(childProcess.stdout, 'end'),
        once(childProcess.stderr, 'end'),
        eventsPromise,
      ])

      assert.strictEqual(code, 0, testOutput)
      assert.match(testOutput, /Attempt to fix passed: all 2 execution\(s\) passed for 2 test\(s\)\./)
      assert.match(testOutput, /Disabled: 2 tests skipped\./)
      assert.match(testOutput, /Quarantined: 1 test run; all passed\./)
    })

    typecheckIt('does not fail the typecheck run for Test Management managed failures', async () => {
      receiver.setSettings({ test_management: { enabled: true } })
      receiver.setTestManagementTests({
        vitest: {
          suites: {
            'ci-visibility/vitest-tests/typecheck-test-management-fail.test-d.ts': {
              tests: {
                'typecheck can report disabled failing assertion': {
                  properties: {
                    disabled: true,
                  },
                },
                'typecheck can report quarantined failing assertion': {
                  properties: {
                    quarantined: true,
                  },
                },
                'typecheck nested failing suite can report nested disabled failing assertion': {
                  properties: {
                    disabled: true,
                  },
                },
              },
            },
          },
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content
          const testSuite = events.find(event => event.type === 'test_suite_end').content
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const disabledTest = tests.find(test =>
            test.meta[TEST_NAME] === 'typecheck can report disabled failing assertion'
          )
          const quarantinedTest = tests.find(test =>
            test.meta[TEST_NAME] === 'typecheck can report quarantined failing assertion'
          )
          const nestedDisabledTest = tests.find(test =>
            test.meta[TEST_NAME] === 'typecheck nested failing suite can report nested disabled failing assertion'
          )

          assert.ok(disabledTest, testOutput)
          assert.ok(quarantinedTest, testOutput)
          assert.ok(nestedDisabledTest, testOutput)
          assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testModule.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testSuite.meta[TEST_STATUS], 'pass')

          assert.strictEqual(disabledTest.meta[TEST_STATUS], 'skip')
          assert.strictEqual(disabledTest.meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(disabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')

          assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
          assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

          assert.strictEqual(nestedDisabledTest.meta[TEST_STATUS], 'skip')
          assert.strictEqual(nestedDisabledTest.meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(nestedDisabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
        }, 25000)

      childProcess = exec(
        './node_modules/.bin/vitest run --config=./vitest.typecheck.config.mjs ' +
          'ci-visibility/vitest-tests/typecheck-test-management-fail.test-d.ts --reporter=verbose',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            DD_SERVICE: undefined,
            TYPECHECK_TEST_MANAGEMENT_FAIL: 'true',
          },
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const [[code]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      assert.strictEqual(code, 0, testOutput)
    })

    typecheckIt('preserves file-level typecheck failures with Test Management managed tests', async () => {
      receiver.setSettings({ test_management: { enabled: true } })
      receiver.setTestManagementTests({
        vitest: {
          suites: {
            'ci-visibility/vitest-tests/typecheck-test-management-file-fail.test-d.ts': {
              tests: {
                'typecheck container failing suite can report disabled assertion with file-level error': {
                  properties: {
                    disabled: true,
                  },
                },
                'typecheck container failing suite can report quarantined assertion with file-level error': {
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
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content
          const testSuite = events.find(event => event.type === 'test_suite_end').content
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const disabledTest = tests.find(test =>
            test.meta[TEST_NAME] ===
              'typecheck container failing suite can report disabled assertion with file-level error'
          )
          const quarantinedTest = tests.find(test =>
            test.meta[TEST_NAME] ===
              'typecheck container failing suite can report quarantined assertion with file-level error'
          )

          assert.ok(disabledTest, testOutput)
          assert.ok(quarantinedTest, testOutput)
          assert.strictEqual(testSession.meta[TEST_STATUS], 'fail', testOutput)
          assert.strictEqual(testModule.meta[TEST_STATUS], 'fail', testOutput)
          assert.strictEqual(testSuite.meta[TEST_STATUS], 'fail', testOutput)
          assert.strictEqual(testSuite.meta[ERROR_TYPE], 'TypeCheckError')
          assert.ok(testSuite.meta[ERROR_MESSAGE])

          assert.strictEqual(disabledTest.meta[TEST_STATUS], 'skip')
          assert.strictEqual(disabledTest.meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(disabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')

          assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'pass')
          assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
        }, 25000)

      childProcess = exec(
        './node_modules/.bin/vitest run --config=./vitest.typecheck.config.mjs ' +
          'ci-visibility/vitest-tests/typecheck-test-management-file-fail.test-d.ts --reporter=verbose',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            DD_SERVICE: undefined,
            TYPECHECK_TEST_MANAGEMENT_FILE_FAIL: 'true',
          },
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const [[code]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      assert.strictEqual(code, 1, testOutput)
    })

    typecheckIt('can report failed typecheck tests', async () => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const {
            testSession,
            testModule,
            testSuite,
            tests,
          } = assertCompleteTestSessionTrace(events, testOutput)
          const test = tests.find(test =>
            test.meta[TEST_NAME] === 'typecheck can report failing assertion'
          )

          assert.ok(test, testOutput)

          assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
          assert.strictEqual(testModule.meta[TEST_STATUS], 'fail')
          assert.strictEqual(testSuite.meta[TEST_STATUS], 'fail')
          assert.strictEqual(testSuite.meta[TEST_SOURCE_FILE], 'ci-visibility/vitest-tests/typecheck-fail.test-d.ts')
          assert.strictEqual(test.meta[TEST_STATUS], 'fail')
          assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/vitest-tests/typecheck-fail.test-d.ts')
          assert.strictEqual(test.meta[ERROR_TYPE], 'TypeCheckError')
          assert.ok(test.meta[ERROR_MESSAGE])
        }, 25000)

      childProcess = exec(
        './node_modules/.bin/vitest run --config=./vitest.typecheck.config.mjs ' +
          'ci-visibility/vitest-tests/typecheck-fail.test-d.ts --reporter=verbose',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            DD_SERVICE: undefined,
            TYPECHECK_FAIL: 'true',
          },
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const [[code]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      assert.strictEqual(code, 1, testOutput)
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

          const concurrentHookTestNames = [
            'vitest-test-concurrent-hook-http first concurrent hook http is linked to first test span',
            'vitest-test-concurrent-hook-http second concurrent hook http is linked to second test span',
            'vitest-describe-concurrent-hook-http first inherited concurrent hook http is linked to first test span',
            'vitest-describe-concurrent-hook-http second inherited concurrent hook http is linked to second test span',
            'vitest-mixed-concurrent-hook-http serial hook http is linked to serial test span',
            'vitest-mixed-concurrent-hook-http first mixed concurrent hook http is linked to first test span',
            'vitest-mixed-concurrent-hook-http second mixed concurrent hook http is linked to second test span',
          ]
          for (const testName of concurrentHookTestNames) {
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
              3,
              `should have beforeEach, test body, and afterEach HTTP spans as children of ${testName}`
            )
          }
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
      it(
        'tags session and children with _dd.ci.library_configuration_error.settings when settings fails 4xx',
        async () => {
          receiver.setSettingsResponseCode(404)
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
              const testModule = events.find(event => event.type === 'test_module_end')
              assert.ok(testModule, 'should have test module event')
              assert.strictEqual(testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
              const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
              assert.ok(testSuiteEvent, 'should have test suite event')
              assert.strictEqual(testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
              const testEvent = events.find(event => event.type === 'test')
              assert.ok(testEvent, 'should have test event')
              assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
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

      it(
        'tags session and children with _dd.ci.library_configuration_error.skippable_tests when request fails',
        async () => {
          receiver.setSkippableSuitesResponseCode(404)
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
              const testModule = events.find(event => event.type === 'test_module_end')
              assert.ok(testModule, 'should have test module event')
              assert.strictEqual(
                testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS],
                'true'
              )
              const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
              assert.ok(testSuiteEvent, 'should have test suite event')
              assert.strictEqual(
                testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS],
                'true'
              )
              const testEvent = events.find(event => event.type === 'test')
              assert.ok(testEvent, 'should have test event')
              assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
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

      it(
        'tags session and children with _dd.ci.library_configuration_error.known_tests when request fails 4xx',
        async () => {
          receiver.setSettings({ known_tests_enabled: true })
          receiver.setKnownTestsResponseCode(404)
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
              const testModule = events.find(event => event.type === 'test_module_end')
              assert.ok(testModule, 'should have test module event')
              assert.strictEqual(testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
              const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
              assert.ok(testSuiteEvent, 'should have test suite event')
              assert.strictEqual(testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
              const testEvent = events.find(event => event.type === 'test')
              assert.ok(testEvent, 'should have test event')
              assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
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

      it(
        'tags session and children with _dd.ci.library_configuration_error.test_management_tests when request fails',
        async () => {
          receiver.setSettings({ test_management: { enabled: true } })
          receiver.setTestManagementTestsResponseCode(404)
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true')
              const testModule = events.find(event => event.type === 'test_module_end')
              assert.ok(testModule, 'should have test module event')
              assert.strictEqual(
                testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true'
              )
              const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
              assert.ok(testSuiteEvent, 'should have test suite event')
              assert.strictEqual(
                testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true'
              )
              const testEvent = events.find(event => event.type === 'test')
              assert.ok(testEvent, 'should have test event')
              assert.strictEqual(
                testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true'
              )
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
    {
      const coverageTest = version === 'latest' && NODE_MAJOR >= 20 ? it : it.skip
      const coverageProviders = ['v8', 'istanbul']

      coverageProviders.forEach((coverageProvider) => {
        coverageTest(`reports code coverage for ${coverageProvider} provider`, async () => {
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

      coverageTest('reports zero code coverage for instanbul provider', async () => {
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
  })
})

versions.forEach(version => {
  describe(`vitest@${version} empty-session reporting`, function () {
    this.timeout(60_000)
    let receiver, childProcess

    useSandbox([
      `vitest@${version}`,
      ...(version === 'latest' ? ['vite@8.3.4'] : []),
    ], false, ['./integration-tests/ci-visibility/vitest-empty-sessions'])

    beforeEach(async () => {
      receiver = await new FakeCiVisIntake().start()
      receiver.setSettings({ itr_enabled: false })
    })

    afterEach(async () => {
      await stopCiVisTestEnv({ childProcess, receiver })
      childProcess = undefined
    })

    const scenarios = [
      'empty-shard', 'empty-shard-default', 'empty-file', 'empty-file-disallowed', 'setup-error', 'normal', 'skipped',
      'no-candidates', 'no-candidates-default', 'no-candidates-sharded', 'no-candidates-sharded-default',
      'collected-only',
    ]
    for (const scenario of scenarios) {
      // Vitest 1.6 aborts global setup before the session finalizer can be installed.
      const scenarioIt = version === '1.6.0' && scenario === 'setup-error' ? it.skip : it
      scenarioIt(`reports ${scenario} with the correct session status`, async () => {
        // Unlike 1.6, newer Vitest versions reject excess shards unless passWithNoTests is enabled.
        const isFailure = scenario === 'empty-file-disallowed' || scenario === 'setup-error' ||
          (scenario.startsWith('no-candidates') && scenario.endsWith('default')) ||
          (scenario === 'empty-shard-default' && version !== '1.6.0')
        const reason = isFailure
          ? undefined
          : scenario.startsWith('empty-shard')
            ? 'zero_test_shard'
            : scenario === 'empty-file' || scenario.startsWith('no-candidates')
              ? 'zero_tests'
              : ['skipped', 'collected-only'].includes(scenario) ? 'all_tests_skipped' : undefined
        const skipReason = reason === 'zero_test_shard'
          ? 'No tests were assigned to this shard'
          : reason === 'zero_tests'
            ? 'No tests were detected'
            : reason === 'all_tests_skipped' ? 'All tests were skipped' : undefined
        const expectedStatus = isFailure ? 'fail' : reason ? 'skip' : 'pass'
        const shard = scenario.startsWith('empty-shard') || scenario.includes('sharded') ? ' --shard=2/2' : ''
        let output = ''
        childProcess = exec(
          `./node_modules/.bin/vitest run --config vitest-empty-sessions/config.mjs${shard}`,
          {
            cwd: sandboxCwd(),
            env: {
              ...getCiVisEvpProxyConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 'false',
              DD_INJECT_FORCE: 'true',
              EMPTY_SESSION_SCENARIO: scenario,
            },
          }
        )
        childProcess.stdout.on('data', chunk => { output += chunk })
        childProcess.stderr.on('data', chunk => { output += chunk })
        const eventsPromise = receiver.gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const sessions = events.filter(event => event.type === 'test_session_end')
            const modules = events.filter(event => event.type === 'test_module_end')
            const tests = events.filter(event => event.type === 'test')
            assert.strictEqual(sessions.length, 1, output)
            assert.strictEqual(modules.length, 1, output)
            assert.strictEqual(tests.length, ['normal', 'skipped', 'collected-only'].includes(scenario) ? 1 : 0, output)
            if (scenario === 'collected-only') {
              assert.strictEqual(tests[0].content.meta[TEST_STATUS], 'skip', output)
            }
            for (const event of [...sessions, ...modules]) {
              assert.strictEqual(event.content.meta[TEST_STATUS], expectedStatus, output)
              assert.strictEqual(event.content.meta[TEST_SESSION_EMPTY_REASON], reason, output)
              assert.strictEqual(event.content.meta[TEST_SKIP_REASON], skipReason, output)
            }
          }
        )
        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, isFailure ? 1 : 0, output)
      })
    }
  })
})

const describeCloudflareWorkers = NODE_MAJOR < 20 || !runVersionIndependentSuites ? describe.skip : describe

describeCloudflareWorkers('vitest@3.2.4 with @cloudflare/vitest-pool-workers@0.12.21', () => {
  let cwd, receiver, childProcess, testOutput

  useSandbox([
    'vitest@3.2.4',
    '@cloudflare/vitest-pool-workers@0.12.21',
  ], true)

  before(function () {
    cwd = sandboxCwd()
  })

  beforeEach(async function () {
    testOutput = ''
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess?.kill()
    await receiver?.stop()
  })

  it('keeps Cloudflare worker pool context safe with Unicode git metadata', async () => {
    childProcess = exec(
      './node_modules/.bin/vitest run',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
          TEST_DIR: 'ci-visibility/vitest-tests/cloudflare-worker-pool.mjs',
          CLOUDFLARE_WORKERS_POOL: '1',
          USE_VITEST_DEFAULT_POOL: '1',
          // The emoji keeps this a regression test: Miniflare rejects its UTF-16 surrogate when
          // DD_GIT_COMMIT_MESSAGE is accidentally propagated through Vitest providedContext headers.
          DD_GIT_COMMIT_MESSAGE: 'ship vitest metadata 😄',
          DD_SERVICE: undefined,
        },
      }
    )
    childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
    childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

    const [[code]] = await Promise.all([
      once(childProcess, 'exit'),
    ])

    assert.strictEqual(code, 0, testOutput)
  })
})

// Vite's loader can notify ESM hooks more than once for the same runner.
// Cover the original reproducer and the latest supported Vitest release.
// Vitest 4 requires Node >=20; Vitest 5 requires Node >=22.
for (const version of ['4.1.10', 'latest']) {
  let describeRunnerReuse = describe
  if (!runVersionIndependentSuites || NODE_MAJOR < 20 || (version === 'latest' && NODE_MAJOR < 22)) {
    describeRunnerReuse = describe.skip
  }

  describeRunnerReuse(`vitest@${version} runner reuse`, () => {
    let cwd, receiver, childProcess, output
    useSandbox([`vitest@${version}`, 'jsdom@26.1.0', '@testing-library/jest-dom@6.9.1'])

    before(() => {
      cwd = sandboxCwd()
    })
    beforeEach(async () => {
      output = ''
      receiver = await new FakeCiVisIntake().start()
    })
    afterEach(async () => {
      childProcess?.kill()
      await receiver.stop()
    })

    for (const pool of ['forks', 'threads']) {
      for (const feature of ['atr', 'efd', 'atf']) {
        for (const passAttempt of [2, 3]) {
          const title = `reports each ${feature} attempt once when attempt ${passAttempt} passes with jsdom and ${pool}`
          it(title, async () => {
            receiver.setSettings({
              itr_enabled: false,
              tests_skipping: false,
              code_coverage: false,
              flaky_test_retries_enabled: feature === 'atr',
              test_management: { enabled: feature === 'atf', attempt_to_fix_retries: 2 },
              known_tests_enabled: feature === 'efd',
              early_flake_detection: { enabled: feature === 'efd', slow_test_retries: { '5s': 2 } },
            })
            receiver.setKnownTests({ vitest: {} })
            receiver.setTestManagementTests({
              vitest: {
                suites: {
                  'ci-visibility/vitest-tests/efd-retries.mjs': {
                    tests: { 'EFD retries': { properties: { attempt_to_fix: true } } },
                  },
                },
              },
            })
            childProcess = exec('./node_modules/.bin/vitest run --environment jsdom', {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                TEST_DIR: 'ci-visibility/vitest-tests/efd-retries.mjs',
                EFD_PASS_ATTEMPT: String(passAttempt),
                POOL_CONFIG: pool,
                VITEST_SETUP_FILE: 'ci-visibility/vitest-tests/runner-reuse-setup.mjs',
              },
            })
            childProcess.stdout.on('data', data => { output += data })
            childProcess.stderr.on('data', data => { output += data })
            const eventsPromise = receiver.gatherPayloadsUntilChildExit(
              childProcess,
              ({ url }) => url === '/api/v2/citestcycle',
              payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events
                  .filter(event => event.type === 'test').map(event => event.content)
                  .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0)
                const attempts = feature === 'atr' ? passAttempt : 3
                const expected = Array.from({ length: attempts }, (_, index) => {
                  return index + 1 === passAttempt ? 'pass' : 'fail'
                })
                assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]), expected, output)
                assert.strictEqual(tests.at(-1).meta[TEST_FINAL_STATUS], feature === 'atf' ? 'fail' : 'pass')
                assert.strictEqual(tests[0].meta[TEST_IS_RETRY], undefined)
                for (const test of tests.slice(1)) {
                  assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                  assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES[feature])
                }

                const suites = events.filter(event => event.type === 'test_suite_end')
                assert.strictEqual(suites.length, 1, output)
                const suite = suites[0].content
                assert.strictEqual(suite.meta[TEST_STATUS], feature === 'atf' ? 'fail' : 'pass')
                if (feature === 'atf') {
                  const failedAttempt = passAttempt === 3 ? tests[0] : tests.at(-1)
                  for (const field of [ERROR_TYPE, ERROR_MESSAGE, ERROR_STACK]) {
                    assert.ok(failedAttempt.meta[field], output)
                    assert.strictEqual(suite.meta[field], failedAttempt.meta[field], output)
                  }
                }
                if (tests.at(-1).meta[TEST_STATUS] === 'pass') {
                  for (const field of [ERROR_TYPE, ERROR_MESSAGE, ERROR_STACK]) {
                    assert.strictEqual(tests.at(-1).meta[field], undefined, output)
                  }
                }
              }
            )
            const [[code, signal]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
            assert.strictEqual(signal, null, output)
            assert.strictEqual(code, feature === 'atf' ? 1 : 0, output)
          })
        }
      }
    }
  })
}
