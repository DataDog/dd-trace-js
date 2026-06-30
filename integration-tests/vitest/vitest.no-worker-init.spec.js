'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { exec } = require('child_process')
const { inspect } = require('node:util')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')
const {
  TEST_STATUS,
  TEST_SOURCE_FILE,
  TEST_SUITE_ID,
  TEST_FINAL_STATUS,
  TEST_NAME,
  TEST_IS_TEST_FRAMEWORK_WORKER,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { NODE_MAJOR } = require('../../version')

const CUSTOM_SEQUENCER_MARKER = 'dd-trace custom vitest sequencer was used'

// vitest@4.x requires Node.js >= 20
const versions = NODE_MAJOR <= 18 ? ['1.6.0', '3.2.6'] : ['1.6.0', 'latest']

versions.forEach((version) => {
  describe(`vitest@${version} no-worker init`, () => {
    let cwd, receiver, childProcess, testOutput
    const newerVitestIt = version === '1.6.0' ? it.skip : it
    const latestVitestIt = version === 'latest' ? it : it.skip

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
      testOutput = ''
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      childProcess.kill()
      await receiver.stop()
    })

    const workerPoolCases = [
      {
        nodeOptions: '--conditions=C:\\tools\\hook.js --no-warnings --import dd-trace/register.js -r dd-trace/ci/init',
        poolConfig: 'forks',
        workerName: 'fork',
        extraEnv: {
          EXPECT_DD_NODE_OPTIONS_WINDOWS_PATH_PRESERVED: '1',
          EXPECT_TEST_DURATION: '1',
        },
        testFn: newerVitestIt,
      },
    ]

    function assertNoWorkerSuiteContextEvents (events, shouldAssertWorkerMarker = false) {
      const testSessionEvents = events.filter(event => event.type === 'test_session_end')
      const testModuleEvents = events.filter(event => event.type === 'test_module_end')
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
      const sourceFiles = testEvents.map(test => test.meta[TEST_SOURCE_FILE]).sort()
      const testNames = testEvents.map(test => test.meta[TEST_NAME]).sort()
      const testSuiteSourceFiles = testSuiteEvents.map(testSuite => testSuite.meta[TEST_SOURCE_FILE]).sort()
      const testSuiteIds = new Set(testSuiteEvents.map(testSuite => testSuite[TEST_SUITE_ID].toString()))

      assert.strictEqual(testSessionEvents.length, 1, inspect(events.map(event => event.type)))
      assert.strictEqual(testModuleEvents.length, 1, inspect(events.map(event => event.type)))
      assert.strictEqual(testSuiteEvents.length, 2, inspect(testSuiteSourceFiles))
      assert.strictEqual(testEvents.length, 2, inspect(testNames))
      assert.deepStrictEqual(sourceFiles, [
        'ci-visibility/vitest-tests/no-worker-suite-context-a-slow.mjs',
        'ci-visibility/vitest-tests/no-worker-suite-context-b-fast.mjs',
      ])
      assert.deepStrictEqual(testSuiteSourceFiles, sourceFiles)
      assert.deepStrictEqual(testNames, [
        'no-worker suite context fast uses fast suite',
        'no-worker suite context slow uses slow suite',
      ])
      assert.strictEqual(new Set(testEvents.map(test => test.test_session_id.toString())).size, 1)
      assert.strictEqual(new Set(testEvents.map(test => test.test_module_id.toString())).size, 1)
      for (const testEvent of testEvents) {
        assert.strictEqual(testEvent.meta[TEST_STATUS], 'pass')
        assert.ok(testSuiteIds.has(testEvent[TEST_SUITE_ID].toString()))
        if (shouldAssertWorkerMarker) {
          assert.strictEqual(testEvent.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
        }
        assert.strictEqual(
          testEvent.test_session_id.toString(),
          testSessionEvents[0].content.test_session_id.toString()
        )
        assert.strictEqual(
          testEvent.test_module_id.toString(),
          testModuleEvents[0].content.test_module_id.toString()
        )
      }
    }

    for (const { testFn, nodeOptions, poolConfig, workerName, extraEnv } of workerPoolCases) {
      testFn(`strips Datadog NODE_OPTIONS from ${workerName} workers`, async () => {
        const payloadsPromise = receiver.gatherPayloadsMaxTimeout(
          ({ url }) => url === '/api/v2/citestcycle',
          payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testEvents = events.filter(event => event.type === 'test')

            assert.strictEqual(testEvents.length, 1, inspect(events.map(event => event.type)))
            assert.strictEqual(testEvents[0].content.meta[TEST_NAME], 'vitest worker env sets DD_VITEST_WORKER')
            assert.strictEqual(testEvents[0].content.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testEvents[0].content.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
            assert.ok(testEvents[0].content.duration > 0, 'test duration should be positive')
            assert.ok(testEvents[0].content.duration < 60_000_000_000, 'test duration should be under 60s')
          }
        )

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: nodeOptions,
              TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
              POOL_CONFIG: poolConfig,
              DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
              EXPECT_DD_NODE_OPTIONS_STRIPPED: '1',
              DD_SERVICE: undefined,
              ...extraEnv,
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
    }

    latestVitestIt('keeps Datadog NODE_OPTIONS in thread workers when no-worker init is enabled', async () => {
      const payloadsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testEvents = events.filter(event => event.type === 'test')

          assert.strictEqual(testEvents.length, 1, inspect(events.map(event => event.type)))
          assert.strictEqual(testEvents[0].content.meta[TEST_NAME], 'vitest worker env sets DD_VITEST_WORKER')
          assert.strictEqual(testEvents[0].content.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testEvents[0].content.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
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
            DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
            EXPECT_DD_NODE_OPTIONS_PRESENT: '1',
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

    newerVitestIt('reports fork project tests when custom sequencer runs before no-worker setup', async () => {
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
            CUSTOM_SEQUENCER: 'true',
            CUSTOM_SEQUENCER_MARKER,
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
      assert.ok(testOutput.includes(CUSTOM_SEQUENCER_MARKER), `Got: ${inspect(testOutput)}`)
    })

    newerVitestIt(
      'reports thread-routed specs with worker instrumentation when no-worker init is enabled',
      async () => {
        const payloadsPromise = receiver.gatherPayloadsMaxTimeout(
          ({ url }) => url === '/api/v2/citestcycle',
          payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            assertNoWorkerSuiteContextEvents(events)
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
              PROJECT_POOL_CONFIG: 'forks',
              PROJECT_THREAD_POOL_MATCH_GLOB: '**/no-worker-suite-context-b-fast.mjs',
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
      }
    )

    newerVitestIt('strips Datadog NODE_OPTIONS from fork projects when root thread pool disables isolate', async () => {
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
            POOL_NO_ISOLATE: '1',
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

    newerVitestIt('parents no-worker test events to their own suite when modules overlap', async () => {
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

    newerVitestIt('quarantines afterEach failures after user hooks when no-worker init is enabled', async () => {
      receiver.setSettings({ test_management: { enabled: true } })
      receiver.setTestManagementTests({
        vitest: {
          suites: {
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

      const payloadsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const eventTypes = inspect(events.map(event => event.type))
          const testSessionEvent = events.find(event => event.type === 'test_session_end')
          const testEvent = events.find(event => event.type === 'test')

          assert.ok(testSessionEvent, `should have test session event, got events: ${eventTypes}`)
          assert.strictEqual(testSessionEvent.content.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testSessionEvent.content.meta[TEST_MANAGEMENT_ENABLED], 'true')

          assert.ok(testEvent, `should have test event, got events: ${eventTypes}`)
          assert.strictEqual(
            testEvent.content.meta[TEST_NAME],
            'quarantine tests with failing afterEach can quarantine a test whose afterEach hook fails'
          )
          assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'fail')
          assert.strictEqual(testEvent.content.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
          assert.strictEqual(testEvent.content.meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(testEvent.content.meta[ERROR_MESSAGE], 'afterEach hook failed')
        }
      )

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--no-warnings --import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/hooks-test-quarantine-failing-after-each.mjs',
            POOL_CONFIG: 'forks',
            SEQUENCE_HOOKS: 'list',
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
            PROJECT_UNNAMED: '1',
            SECOND_PROJECT_POOL_CONFIG: 'threads',
            SECOND_PROJECT_UNNAMED: '1',
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

    newerVitestIt('ignores no-worker init when a fork project disables pool isolate', async () => {
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
            PROJECT_POOL_NO_ISOLATE: '1',
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
  })
})
