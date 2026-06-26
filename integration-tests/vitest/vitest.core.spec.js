'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { exec } = require('child_process')
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
  ERROR_MESSAGE,
  ERROR_STACK,
  ERROR_TYPE,
} = require('../../packages/dd-trace/src/constants')
const {
  TEST_STATUS,
  TEST_TYPE,
  TEST_IS_RETRY,
  TEST_CODE_OWNERS,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_SESSION_NAME,
  TEST_COMMAND,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
  TEST_SUITE_ID,
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
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_RETRY_REASON_TYPES,
  TEST_HAS_DYNAMIC_NAME,
  VITEST_POOL,
  TEST_IS_TEST_FRAMEWORK_WORKER,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { NODE_MAJOR } = require('../../version')

const NUM_RETRIES_EFD = 3
const CUSTOM_SEQUENCER_MARKER = 'dd-trace custom vitest sequencer was used'
const FLAKY_EVENTUALLY_PASSING_RESOURCE =
  'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass'
const FLAKY_NEVER_PASSING_RESOURCE =
  'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass'
const FLAKY_UNNECESSARY_RETRY_RESOURCE =
  'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary'
const linePctMatchRegex = /Lines\s+:\s+([\d.]+)%/

// vitest@4.x requires Node.js >= 20
const versions = NODE_MAJOR <= 18 ? ['1.6.0', '3.2.6'] : ['1.6.0', 'latest']

versions.forEach((version) => {
  describe(`vitest@${version}`, () => {
    let cwd, receiver, childProcess, testOutput
    const newerVitestIt = version === '1.6.0' ? it.skip : it
    const latestVitestIt = version === 'latest' ? it : it.skip
    const noWorkerUnsupportedIt = process.env.DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT ? it.skip : it

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
              assert.strictEqual(metadata['*'][TEST_SESSION_NAME], 'my-test-session')
              assert.ok(metadata['*'][TEST_COMMAND])
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
              // `threads` config will report directly. TODO: update this once we're testing vitest@>=4
              if (poolConfig === 'forks') {
                assert.strictEqual(test.content.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
              }
              assert.ok(test.content.metrics[DD_HOST_CPU_COUNT])
              assert.strictEqual(test.content.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'false')
            })

            testSuiteEvents.forEach(testSuite => {
              // `threads` config will report directly. TODO: update this once we're testing vitest@>=4
              if (poolConfig === 'forks') {
                assert.strictEqual(testSuite.content.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
              }
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

    newerVitestIt('sets DD_VITEST_WORKER in workers with pool=forks', async () => {
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
            POOL_CONFIG: 'forks',
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

    newerVitestIt('strips Datadog NODE_OPTIONS from fork workers when no-worker init is enabled', async () => {
      const payloadsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testEvent = events.find(event => event.type === 'test')

          assert.ok(testEvent, `should have test event, got events: ${inspect(events.map(event => event.type))}`)
          assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testEvent.content.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
        }
      )

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--no-warnings --import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
            POOL_CONFIG: 'forks',
            DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
            EXPECT_DD_NODE_OPTIONS_STRIPPED: '1',
            DD_SERVICE: undefined,
          },
        }
      )

      childProcess.stdout.on('data', data => { testOutput += data })
      childProcess.stderr.on('data', data => { testOutput += data })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        payloadsPromise,
      ])

      assert.strictEqual(exitCode, 0, testOutput)
    })

    newerVitestIt('strips Datadog NODE_OPTIONS from fork project workers when root pool is threads', async () => {
      const payloadsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testEvent = events.find(event => event.type === 'test')

          assert.ok(testEvent, `should have test event, got events: ${inspect(events.map(event => event.type))}`)
          assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testEvent.content.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
        }
      )

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--no-warnings --import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
            POOL_CONFIG: 'threads',
            PROJECT_POOL_CONFIG: 'forks',
            DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
            EXPECT_DD_NODE_OPTIONS_STRIPPED: '1',
            DD_SERVICE: undefined,
          },
        }
      )

      childProcess.stdout.on('data', data => { testOutput += data })
      childProcess.stderr.on('data', data => { testOutput += data })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        payloadsPromise,
      ])

      assert.strictEqual(exitCode, 0, testOutput)
    })

    newerVitestIt('parents no-worker test events to their own suite when fork modules overlap', async () => {
      const payloadsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSuiteEvents = events
            .filter(event => event.type === 'test_suite_end')
            .map(event => event.content)
            .filter(testSuite => testSuite.meta[TEST_SOURCE_FILE].startsWith(
              'ci-visibility/vitest-tests/no-worker-suite-context-'
            ))
          const testEvents = events
            .filter(event => event.type === 'test')
            .map(event => event.content)
            .filter(test => test.meta[TEST_SOURCE_FILE].startsWith(
              'ci-visibility/vitest-tests/no-worker-suite-context-'
            ))
          const testSuiteIdsBySourceFile = new Map(testSuiteEvents.map(testSuite => [
            testSuite.meta[TEST_SOURCE_FILE],
            testSuite[TEST_SUITE_ID].toString(),
          ]))

          assert.strictEqual(testSuiteEvents.length, 2, inspect(testSuiteEvents.map(testSuite => testSuite.resource)))
          assert.strictEqual(testEvents.length, 2, inspect(testEvents.map(test => test.resource)))
          for (const test of testEvents) {
            assert.strictEqual(
              test[TEST_SUITE_ID].toString(),
              testSuiteIdsBySourceFile.get(test.meta[TEST_SOURCE_FILE])
            )
          }
        }
      )

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--no-warnings --import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/no-worker-suite-context-*.mjs',
            POOL_CONFIG: 'forks',
            DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
            DD_SERVICE: undefined,
          },
        }
      )

      childProcess.stdout.on('data', data => { testOutput += data })
      childProcess.stderr.on('data', data => { testOutput += data })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        payloadsPromise,
      ])

      assert.strictEqual(exitCode, 0, testOutput)
    })

    newerVitestIt('reports suite hook failures when no-worker init is enabled', async () => {
      const payloadsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSuiteEvent = events.find(event => event.type === 'test_suite_end')

          assert.ok(
            testSuiteEvent,
            `should have test suite event, got events: ${inspect(events.map(event => event.type))}`
          )
          assert.strictEqual(testSuiteEvent.content.meta[TEST_STATUS], 'fail')
          assert.strictEqual(testSuiteEvent.content.meta[ERROR_MESSAGE], 'failed before all')
        }
      )

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--no-warnings --import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/failed-suite-hook.mjs',
            POOL_CONFIG: 'forks',
            DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
            DD_SERVICE: undefined,
          },
        }
      )

      childProcess.stdout.on('data', data => { testOutput += data })
      childProcess.stderr.on('data', data => { testOutput += data })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        payloadsPromise,
      ])

      assert.strictEqual(exitCode, 1, testOutput)
    })

    newerVitestIt('preserves string setupFiles when no-worker init is enabled', async () => {
      const payloadsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testEvent = events.find(event => event.type === 'test')

          assert.ok(testEvent, `should have test event, got events: ${inspect(events.map(event => event.type))}`)
          assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'pass')
        }
      )

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--no-warnings --import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/uses-string-setup-file.mjs',
            VITEST_SETUP_FILE: 'ci-visibility/vitest-tests/string-setup-file.mjs',
            POOL_CONFIG: 'forks',
            DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
            DD_SERVICE: undefined,
          },
        }
      )

      childProcess.stdout.on('data', data => { testOutput += data })
      childProcess.stderr.on('data', data => { testOutput += data })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        payloadsPromise,
      ])

      assert.strictEqual(exitCode, 0, testOutput)
    })

    latestVitestIt('does not duplicate thread project events when no-worker init is enabled', async () => {
      const payloadsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testEvents = events.filter(event => event.type === 'test')

          assert.strictEqual(testEvents.length, 2, inspect(testEvents.map(event => event.content.meta)))
          testEvents.forEach(testEvent => {
            assert.strictEqual(testEvent.content.meta[TEST_NAME], 'vitest worker env sets DD_VITEST_WORKER')
            assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'pass')
          })
        }
      )

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--no-warnings --import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
            SECOND_PROJECT_TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
            POOL_CONFIG: 'forks',
            PROJECT_POOL_CONFIG: 'forks',
            SECOND_PROJECT_POOL_CONFIG: 'threads',
            DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
            DD_SERVICE: undefined,
          },
        }
      )

      childProcess.stdout.on('data', data => { testOutput += data })
      childProcess.stderr.on('data', data => { testOutput += data })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        payloadsPromise,
      ])

      assert.strictEqual(exitCode, 0, testOutput)
    })

    newerVitestIt('ignores no-worker init when isolate is disabled', async () => {
      const payloadsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSessionEvent = events.find(event => event.type === 'test_session_end')
          const testModuleEvent = events.find(event => event.type === 'test_module_end')

          assert.ok(
            testSessionEvent,
            `should have test session event, got events: ${inspect(events.map(event => event.type))}`
          )
          assert.ok(
            testModuleEvent,
            `should have test module event, got events: ${inspect(events.map(event => event.type))}`
          )
        }
      )

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--no-warnings --import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
            POOL_CONFIG: 'forks',
            NO_ISOLATE: '1',
            DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
            EXPECT_DD_NODE_OPTIONS_PRESENT: '1',
            DD_TRACE_DEBUG: 'true',
            DD_TRACE_LOG_LEVEL: 'warn',
            DD_SERVICE: undefined,
          },
        }
      )

      childProcess.stdout.on('data', data => { testOutput += data })
      childProcess.stderr.on('data', data => { testOutput += data })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        payloadsPromise,
      ])

      assert.strictEqual(exitCode, 0, testOutput)
      assert.match(
        testOutput,
        /DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT is ignored because Vitest isolate is disabled/
      )
    })

    newerVitestIt('ignores no-worker init when a fork project disables isolate', async () => {
      const payloadsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testEvent = events.find(event => event.type === 'test')

          assert.ok(testEvent, `should have test event, got events: ${inspect(events.map(event => event.type))}`)
          assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'pass')
        }
      )

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--no-warnings --import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
            POOL_CONFIG: 'threads',
            PROJECT_POOL_CONFIG: 'forks',
            PROJECT_NO_ISOLATE: '1',
            DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
            EXPECT_DD_NODE_OPTIONS_PRESENT: '1',
            DD_TRACE_DEBUG: 'true',
            DD_TRACE_LOG_LEVEL: 'warn',
            DD_SERVICE: undefined,
          },
        }
      )

      childProcess.stdout.on('data', data => { testOutput += data })
      childProcess.stderr.on('data', data => { testOutput += data })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        payloadsPromise,
      ])

      assert.strictEqual(exitCode, 0, testOutput)
      assert.match(
        testOutput,
        /DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT is ignored because Vitest isolate is disabled/
      )
    })

    noWorkerUnsupportedIt('propagates test span context to HTTP requests and hooks during test execution', async () => {
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

      // No skippable_tests test: vitest does not request skippable suites (TIA unsupported).

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

        const eventsPromise = receiver.gatherPayloadsMaxTimeout(
          ({ url }) => url === '/api/v2/citestcycle',
          payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testEvents = events.filter(event => event.type === 'test')
            assert.strictEqual(testEvents.length, 11)
            assertObjectContains(testEvents.map(test => test.content.resource), [
              FLAKY_EVENTUALLY_PASSING_RESOURCE,
              FLAKY_EVENTUALLY_PASSING_RESOURCE,
              FLAKY_EVENTUALLY_PASSING_RESOURCE,
              // passes at the third retry
              FLAKY_NEVER_PASSING_RESOURCE,
              FLAKY_NEVER_PASSING_RESOURCE,
              FLAKY_NEVER_PASSING_RESOURCE,
              FLAKY_NEVER_PASSING_RESOURCE,
              FLAKY_NEVER_PASSING_RESOURCE,
              FLAKY_EVENTUALLY_PASSING_RESOURCE,
              // never passes
              FLAKY_NEVER_PASSING_RESOURCE,
              // passes on the first try
              FLAKY_UNNECESSARY_RETRY_RESOURCE,
            ])
            const eventuallyPassingTest = testEvents.filter(
              test => test.content.resource === FLAKY_EVENTUALLY_PASSING_RESOURCE
            )
            assert.strictEqual(eventuallyPassingTest.length, 4)
            assert.strictEqual(
              eventuallyPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'fail').length,
              3
            )
            assert.strictEqual(
              eventuallyPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'pass').length,
              1
            )
            assert.strictEqual(
              eventuallyPassingTest.filter(test => test.content.meta[TEST_IS_RETRY] === 'true').length,
              3
            )
            assert.strictEqual(eventuallyPassingTest.filter(test =>
              test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            ).length, 3)

            const neverPassingTest = testEvents.filter(
              test => test.content.resource === FLAKY_NEVER_PASSING_RESOURCE
            )
            assert.strictEqual(neverPassingTest.length, 6)
            assert.strictEqual(neverPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'fail').length, 6)
            assert.strictEqual(neverPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'pass').length, 0)
            assert.strictEqual(neverPassingTest.filter(test => test.content.meta[TEST_IS_RETRY] === 'true').length, 5)
            assert.strictEqual(neverPassingTest.filter(test =>
              test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            ).length, 5)
          }
        )

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              CUSTOM_SEQUENCER: version === '1.6.0' ? undefined : 'true',
              CUSTOM_SEQUENCER_MARKER: version === '1.6.0' ? undefined : CUSTOM_SEQUENCER_MARKER,
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            },
          }
        )
        let childStdout = ''
        childProcess.stdout?.on('data', chunk => { childStdout += chunk.toString() })

        Promise.all([eventsPromise, once(childProcess, 'exit')]).then(() => {
          if (version !== '1.6.0') {
            assert.ok(childStdout.includes(CUSTOM_SEQUENCER_MARKER), `Got: ${inspect(childStdout)}`)
          }
          done()
        }).catch(done)
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

      newerVitestIt('marks user-configured retries as external when no-worker init is enabled', async () => {
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
            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

            assert.ok(
              retriedTests.length > 0,
              `Expected retried tests. Got: ${inspect(tests.map(test => test.meta))}`
            )
            retriedTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
            })
          }
        )

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              POOL_CONFIG: 'forks',
              PROJECT_POOL_CONFIG: 'forks',
              PROJECT_RETRY_CONFIG: '1',
              DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
              DD_SERVICE: undefined,
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, 1)
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
              // 'early flake detection can retry tests that pass only on the last attempt', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // skipped so not retried
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 18)

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
              'early flake detection can retry tests that pass only on the last attempt',
              'early flake detection can retry tests that pass only on the last attempt',
              'early flake detection can retry tests that pass only on the last attempt',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that pass only on the last attempt',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // 4 executions of the 4 new tests + 1 new skipped test (not retried)
            assert.strictEqual(newTests.length, 17)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 12) // 3 retries of the 4 new tests

            retriedTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
            })

            // exit code should be 0 and test session should be reported as passed,
            // even though there are some failing executions
            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 6)

            // Verifies that task.result.state is reset before the last repetition runs.
            // Without this reset, vitest keeps a stale 'fail' from prior repetitions and
            // incorrectly reports the last execution as failed even when it succeeds.
            const lastAttemptPassTests = tests
              .filter(test =>
                test.meta[TEST_NAME] === 'early flake detection can retry tests that pass only on the last attempt')
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
            assert.strictEqual(lastAttemptPassTests.length, NUM_RETRIES_EFD + 1)
            assert.strictEqual(
              lastAttemptPassTests.filter(test => test.meta[TEST_STATUS] === 'fail').length,
              NUM_RETRIES_EFD
            )
            assert.strictEqual(lastAttemptPassTests[lastAttemptPassTests.length - 1].meta[TEST_STATUS], 'pass')
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
              SHOULD_ADD_LAST_ATTEMPT_PASS: '1',
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

      it('uses the retry count from the matching slow_test_retries bucket', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 1,
              '10s': 0,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {},
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            const instantTests = tests.filter(test =>
              test.meta[TEST_NAME] === 'early flake detection can retry tests that always pass'
            )
            assert.strictEqual(instantTests.length, 2)
            assert.strictEqual(
              instantTests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd).length,
              1
            )

            const slowTests = tests.filter(test =>
              test.meta[TEST_NAME] === 'early flake detection slightly slow duration bucket test'
            )
            assert.strictEqual(slowTests.length, 1)
            assert.strictEqual(slowTests[0].meta[TEST_IS_NEW], 'true')
            assert.strictEqual(slowTests[0].meta[TEST_EARLY_FLAKE_ABORT_REASON], 'slow')
            assert.ok(!(TEST_IS_RETRY in slowTests[0].meta))
          }, 55_000)

        childProcess = exec(
          './node_modules/.bin/vitest run -t "can retry tests that always pass|slightly slow duration bucket test"',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              SHOULD_ADD_SLOW_DURATION_TEST: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, 0)
      })

      newerVitestIt('keeps failed status for slow EFD tests when no-worker init skips extra repeats', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 1,
              '10s': 0,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {},
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(test => test.content)
            const slowTests = tests.filter(test =>
              test.meta[TEST_NAME] === 'early flake detection slightly slow duration bucket test'
            )

            assert.strictEqual(slowTests.length, 1)
            assert.strictEqual(slowTests[0].meta[TEST_STATUS], 'fail')
            assert.strictEqual(slowTests[0].meta[TEST_IS_NEW], 'true')
            assert.strictEqual(slowTests[0].meta[TEST_EARLY_FLAKE_ABORT_REASON], 'slow')
          }, 55_000)

        childProcess = exec(
          './node_modules/.bin/vitest run -t "slightly slow duration bucket test"',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              SHOULD_ADD_SLOW_DURATION_TEST: '1',
              SLOW_DURATION_ALWAYS_FAIL: '1',
              DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, 1)
      })

      it('reports the error from each failed EFD attempt', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 9,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {},
        })

        const testName = 'early flake detection reports the current failed attempt error'
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events
              .filter(event => event.type === 'test')
              .map(test => test.content)
              .filter(test => test.meta[TEST_NAME] === testName)
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            assert.strictEqual(tests.length, 10)

            const failedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.deepStrictEqual(
              failedAttempts.map(test => ({
                isRetry: test.meta[TEST_IS_RETRY],
                retryReason: test.meta[TEST_RETRY_REASON],
                errorType: test.meta[ERROR_TYPE],
                errorMessage: test.meta[ERROR_MESSAGE],
              })),
              [
                {
                  isRetry: undefined,
                  retryReason: undefined,
                  errorType: 'Error',
                  errorMessage: 'failure 0',
                },
                {
                  isRetry: 'true',
                  retryReason: TEST_RETRY_REASON_TYPES.efd,
                  errorType: 'Error',
                  errorMessage: 'failure 2',
                },
                {
                  isRetry: 'true',
                  retryReason: TEST_RETRY_REASON_TYPES.efd,
                  errorType: 'Error',
                  errorMessage: 'failure 5',
                },
                {
                  isRetry: 'true',
                  retryReason: TEST_RETRY_REASON_TYPES.efd,
                  errorType: 'Error',
                  errorMessage: 'failure 8',
                },
              ]
            )
            failedAttempts.forEach(test => {
              assert.ok(
                test.meta[ERROR_STACK],
                `Expected failed attempt error stack. Test event: ${inspect(test)}`
              )
            })
          }, 55_000)

        childProcess = exec(
          './node_modules/.bin/vitest run -t "reports the current failed attempt error"',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              SHOULD_ADD_CURRENT_ERROR_TEST: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, 0)
      })

      newerVitestIt('disables manual Vitest retries for new tests retried by EFD', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 2,
            },
            faulty_session_threshold: 100,
          },
          flaky_test_retries_enabled: false,
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {},
        })

        const testName = 'efd with manual vitest retries fails first then passes'
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events
              .filter(event => event.type === 'test')
              .map(test => test.content)
              .filter(test => test.meta[TEST_NAME] === testName)
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            const diagnosticTests = tests.map(test => ({
              status: test.meta[TEST_STATUS],
              isRetry: test.meta[TEST_IS_RETRY],
              retryReason: test.meta[TEST_RETRY_REASON],
            }))
            assert.deepStrictEqual(diagnosticTests, [
              { status: 'fail', isRetry: undefined, retryReason: undefined },
              { status: 'fail', isRetry: 'true', retryReason: TEST_RETRY_REASON_TYPES.efd },
              { status: 'pass', isRetry: 'true', retryReason: TEST_RETRY_REASON_TYPES.efd },
            ])
          }, 55_000)

        childProcess = exec(
          './node_modules/.bin/vitest run --retry=1',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/fails-first-then-passes.mjs',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, 0)
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
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 4)

            const newTests = tests.filter(
              test => test.meta[TEST_IS_NEW] === 'true'
            )
            // no new tests
            assert.strictEqual(newTests.length, 0)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)
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
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSessionEvent.meta))
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

      newerVitestIt('reports real statuses for Vitest repeats when no-worker init is enabled', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: false,
          },
          flaky_test_retries_enabled: false,
          known_tests_enabled: false,
        })

        const testName = 'early flake detection can retry tests that eventually pass'
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events
              .filter(event => event.type === 'test')
              .map(test => test.content)
              .filter(test => test.meta[TEST_NAME] === testName)
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            assert.deepStrictEqual(
              tests.map(test => ({
                status: test.meta[TEST_STATUS],
                isRetry: test.meta[TEST_IS_RETRY],
                retryReason: test.meta[TEST_RETRY_REASON],
              })),
              [
                { status: 'fail', isRetry: undefined, retryReason: undefined },
                { status: 'fail', isRetry: 'true', retryReason: TEST_RETRY_REASON_TYPES.ext },
                { status: 'pass', isRetry: 'true', retryReason: TEST_RETRY_REASON_TYPES.ext },
              ]
            )
          })

        childProcess = exec(
          './node_modules/.bin/vitest run -t "can retry tests that eventually pass"',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              SHOULD_REPEAT: '1',
              DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
              DD_SERVICE: undefined,
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, 1)
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

        noWorkerUnsupportedIt('runs retries with dynamic instrumentation', (done) => {
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
  })
})
