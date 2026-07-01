'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const { inspect } = require('node:util')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const noWorkerInit = require('../../packages/datadog-instrumentations/src/vitest-main-no-worker-init')
const {
  ERROR_MESSAGE,
} = require('../../packages/dd-trace/src/constants')
const {
  EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_FINAL_STATUS,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_IS_TEST_FRAMEWORK_WORKER,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_NAME,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_SOURCE_FILE,
  TEST_STATUS,
  TEST_SUITE,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { NODE_MAJOR } = require('../../version')

const DEFAULT_NODE_OPTIONS = '--no-warnings --import dd-trace/register.js -r dd-trace/ci/init'
const VITEST_NO_WORKER_INIT_REQUEST_ENV = 'DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT'
const SUPPORTED_VERSIONS = NODE_MAJOR <= 18 ? ['3.2.6'] : ['3.2.6', 'latest']
const UNSUPPORTED_VERSION = '1.6.0'
const UNSUPPORTED_VERSION_WARNING =
  'DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT is only supported for vitest >=3.2.6'
const DISABLED_ISOLATE_WARNING =
  'DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT is ignored because Vitest isolate is disabled'

function getEvents (payloads) {
  return payloads.flatMap(({ payload }) => payload.events)
}

function getEventContents (events, type) {
  return events.filter(event => event.type === type).map(event => event.content)
}

function assertEventCounts (events, expectedCounts) {
  const eventTypes = events.map(event => event.type)
  for (const [type, expectedCount] of Object.entries(expectedCounts)) {
    assert.strictEqual(
      getEventContents(events, type).length,
      expectedCount,
      inspect(eventTypes)
    )
  }
}

function sortStrings (strings) {
  return strings.slice().sort((a, b) => a.localeCompare(b))
}

function getTestByName (tests, name) {
  const test = tests.find(test => test.meta[TEST_NAME] === name)
  assert.ok(test, `Could not find test ${name}. Found: ${inspect(tests.map(test => test.meta[TEST_NAME]))}`)
  return test
}

function getTestsByName (tests, name) {
  return tests
    .filter(test => test.meta[TEST_NAME] === name)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
}

function getNoWorkerInitEnv (receiver, extraEnv = {}) {
  return {
    ...getCiVisAgentlessConfig(receiver.port),
    NODE_OPTIONS: DEFAULT_NODE_OPTIONS,
    [VITEST_NO_WORKER_INIT_REQUEST_ENV]: 'true',
    DD_SERVICE: undefined,
    ...extraEnv,
  }
}

function gatherCitestcyclePayloads (receiver, assertions) {
  return receiver.gatherPayloadsMaxTimeout(
    ({ url }) => url === '/api/v2/citestcycle',
    payloads => assertions(getEvents(payloads))
  )
}

describe('vitest no-worker init instrumentation selection', () => {
  const workerPools = new Set(['forks', 'threads', 'vmForks', 'vmThreads'])
  const options = {
    isVitestWorkerPool: pool => workerPools.has(pool),
  }
  let originalRequested

  beforeEach(() => {
    originalRequested = process.env[VITEST_NO_WORKER_INIT_REQUEST_ENV]
    process.env[VITEST_NO_WORKER_INIT_REQUEST_ENV] = 'true'
  })

  afterEach(() => {
    if (originalRequested === undefined) {
      delete process.env[VITEST_NO_WORKER_INIT_REQUEST_ENV]
    } else {
      process.env[VITEST_NO_WORKER_INIT_REQUEST_ENV] = originalRequested
    }
  })

  describe('shouldUse', () => {
    it('rejects runs when the feature was not requested', () => {
      delete process.env[VITEST_NO_WORKER_INIT_REQUEST_ENV]

      assert.strictEqual(noWorkerInit.shouldUse({ config: { pool: 'forks' } }, '3.2.6', undefined, options), false)
    })

    it('rejects vitest versions older than 3.2.6', () => {
      assert.strictEqual(noWorkerInit.shouldUse({ config: { pool: 'forks' } }, '3.2.5', undefined, options), false)
    })

    for (const pool of ['forks', 'threads']) {
      it(`accepts isolated ${pool} runs`, () => {
        assert.strictEqual(noWorkerInit.shouldUse({ config: { pool } }, '3.2.6', undefined, options), true)
      })
    }

    it('rejects root projects with isolate disabled', () => {
      assert.strictEqual(
        noWorkerInit.shouldUse({ config: { isolate: false, pool: 'forks' } }, '3.2.6', undefined, options),
        false
      )
    })

    it('rejects pool-specific isolate disabled configuration', () => {
      assert.strictEqual(
        noWorkerInit.shouldUse({
          config: {
            pool: 'threads',
            poolOptions: {
              threads: {
                isolate: false,
              },
            },
          },
        }, '3.2.6', undefined, options),
        false
      )
    })

    it('rejects selected test specifications with isolate disabled', () => {
      const project = {
        config: {
          isolate: false,
          pool: 'forks',
        },
      }

      assert.strictEqual(
        noWorkerInit.shouldUse({ config: { pool: 'forks' } }, '3.2.6', [[project, { pool: 'forks' }]], options),
        false
      )
    })

    it('rejects mixed worker and non-worker selected test specifications', () => {
      const workerProject = {
        config: {
          pool: 'forks',
        },
      }
      const nonWorkerProject = {
        config: {
          pool: 'browser',
        },
      }

      assert.strictEqual(
        noWorkerInit.shouldUse({
          config: {
            pool: 'forks',
          },
        }, '3.2.6', [
          [workerProject, { pool: 'forks' }],
          [nonWorkerProject, { pool: 'browser' }],
        ], options),
        false
      )
    })
  })

  describe('configure', () => {
    it('sends EFD retry thresholds to the no-worker setup context', () => {
      const rootProject = { _provided: {} }
      const ctx = {
        config: {},
        reporters: [],
        getRootProject () {
          return rootProject
        },
      }

      noWorkerInit.configure(ctx, '3.2.6', undefined, {
        knownTestsBySuite: {},
        modifiedFiles: {},
        repositoryRoot: '/repo',
        testManagementTestsBySuite: {},
        testSessionConfiguration: {},
      }, {
        getConfiguredEfdRetryCount: () => 2,
        state: {
          earlyFlakeDetectionNumRetries: 1,
          earlyFlakeDetectionSlowTestRetries: { '5s': 2 },
          isEarlyFlakeDetectionEnabled: true,
          isEarlyFlakeDetectionFaulty: false,
          testManagementAttemptToFixRetries: 0,
        },
      })

      assert.deepStrictEqual(
        rootProject._provided._ddVitestWorkerSetup.earlyFlakeDetectionRetryThresholds,
        EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS
      )
    })
  })
})

SUPPORTED_VERSIONS.forEach((version) => {
  describe(`vitest@${version} no-worker init`, () => {
    let cwd, receiver, childProcess, testOutput

    useSandbox([
      `vitest@${version}`,
      'tinypool',
    ], true)

    before(function () {
      cwd = sandboxCwd()
    })

    beforeEach(async function () {
      childProcess = undefined
      testOutput = ''
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      childProcess?.kill()
      await receiver.stop()
    })

    async function runVitest (extraEnv = {}, command = './node_modules/.bin/vitest run') {
      childProcess = exec(
        command,
        {
          cwd,
          env: getNoWorkerInitEnv(receiver, extraEnv),
        }
      )

      childProcess.stdout.on('data', data => { testOutput += data })
      childProcess.stderr.on('data', data => { testOutput += data })

      const [exitCode] = await once(childProcess, 'exit')
      return exitCode
    }

    for (const poolConfig of ['forks', 'threads']) {
      it(`runs and reports tests without initializing dd-trace in ${poolConfig} workers`, async () => {
        const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
          assertEventCounts(events, {
            test_session_end: 1,
            test_module_end: 1,
            test_suite_end: 1,
            test: 1,
          })

          const [test] = getEventContents(events, 'test')
          assert.strictEqual(test.meta[TEST_NAME], 'vitest worker env sets DD_VITEST_WORKER')
          assert.strictEqual(test.meta[TEST_STATUS], 'pass')
          assert.strictEqual(test.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
        })

        const exitCode = await Promise.all([
          runVitest({
            TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
            POOL_CONFIG: poolConfig,
            EXPECT_DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE: '1',
            EXPECT_DD_NODE_OPTIONS_PRESERVED: '--no-warnings',
            EXPECT_DD_NODE_OPTIONS_STRIPPED: '1',
            EXPECT_NO_DD_TRACE_INIT: '1',
          }),
          payloadsPromise,
        ]).then(([exitCode]) => exitCode)

        assert.strictEqual(exitCode, 0, testOutput)
      })
    }

    if (version === '3.2.6') {
      it('reports multiple suites with the same parentage as worker instrumentation', async () => {
        const expectedSuites = [
          'ci-visibility/vitest-tests/no-worker-suite-context-a-slow.mjs',
          'ci-visibility/vitest-tests/no-worker-suite-context-b-fast.mjs',
        ]
        const expectedTests = [
          'no-worker suite context fast reports the fast suite test',
          'no-worker suite context slow reports the slow suite test',
        ]

        const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
          assertEventCounts(events, {
            test_session_end: 1,
            test_module_end: 1,
            test_suite_end: 2,
            test: 2,
          })

          const suites = getEventContents(events, 'test_suite_end')
          const tests = getEventContents(events, 'test')
          assert.deepStrictEqual(sortStrings(suites.map(suite => suite.meta[TEST_SOURCE_FILE])), expectedSuites)
          assert.deepStrictEqual(sortStrings(tests.map(test => test.meta[TEST_NAME])), expectedTests)

          const suitesBySourceFile = new Map(suites.map(suite => [suite.meta[TEST_SOURCE_FILE], suite]))
          for (const test of tests) {
            const suite = suitesBySourceFile.get(test.meta[TEST_SOURCE_FILE])
            assert.ok(suite, `Could not find suite for ${test.meta[TEST_SOURCE_FILE]}`)
            assert.strictEqual(test.meta[TEST_SUITE], test.meta[TEST_SOURCE_FILE])
            assert.strictEqual(test.test_session_id.toString(), suite.test_session_id.toString())
            assert.strictEqual(test.test_module_id.toString(), suite.test_module_id.toString())
          }
        })

        const exitCode = await Promise.all([
          runVitest({
            TEST_DIR: 'ci-visibility/vitest-tests/no-worker-suite-context-*.mjs',
            POOL_CONFIG: 'forks',
          }),
          payloadsPromise,
        ]).then(([exitCode]) => exitCode)

        assert.strictEqual(exitCode, 0, testOutput)
      })

      it('reports suite hook failures from the main-process reporter', async () => {
        const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
          assertEventCounts(events, {
            test_session_end: 1,
            test_module_end: 1,
            test_suite_end: 1,
          })

          const [suite] = getEventContents(events, 'test_suite_end')
          assert.strictEqual(suite.meta[TEST_STATUS], 'fail')
          assert.match(suite.meta[ERROR_MESSAGE], /failed before all/)
        })

        const exitCode = await Promise.all([
          runVitest({
            TEST_DIR: 'ci-visibility/vitest-tests/failed-suite-hook.mjs',
            POOL_CONFIG: 'forks',
          }),
          payloadsPromise,
        ]).then(([exitCode]) => exitCode)

        assert.strictEqual(exitCode, 1, testOutput)
      })

      it('preserves existing string setup files when injecting the no-worker setup file', async () => {
        const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
          assertEventCounts(events, {
            test_session_end: 1,
            test_module_end: 1,
            test_suite_end: 1,
            test: 1,
          })

          const [test] = getEventContents(events, 'test')
          assert.strictEqual(test.meta[TEST_NAME], 'string setup file keeps the configured setup file')
          assert.strictEqual(test.meta[TEST_STATUS], 'pass')
        })

        const exitCode = await Promise.all([
          runVitest({
            TEST_DIR: 'ci-visibility/vitest-tests/uses-string-setup-file.mjs',
            POOL_CONFIG: 'forks',
            VITEST_SETUP_FILE: 'ci-visibility/vitest-tests/string-setup-file.mjs',
          }),
          payloadsPromise,
        ]).then(([exitCode]) => exitCode)

        assert.strictEqual(exitCode, 0, testOutput)
      })

      for (const { name, env } of [
        {
          name: 'root isolate disabled',
          env: {
            NO_ISOLATE: '1',
            POOL_CONFIG: 'forks',
          },
        },
        {
          name: 'root pool isolate disabled',
          env: {
            POOL_CONFIG: 'forks',
            POOL_NO_ISOLATE: '1',
          },
        },
        {
          name: 'project isolate disabled',
          env: {
            PROJECT_NO_ISOLATE: '1',
            PROJECT_POOL_CONFIG: 'forks',
          },
        },
        {
          name: 'project pool isolate disabled',
          env: {
            PROJECT_POOL_CONFIG: 'forks',
            PROJECT_POOL_NO_ISOLATE: '1',
          },
        },
      ]) {
        it(`warns and falls back to worker instrumentation when ${name}`, async () => {
          const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
            assertEventCounts(events, {
              test_session_end: 1,
              test_module_end: 1,
              test_suite_end: 1,
              test: 1,
            })

            const [test] = getEventContents(events, 'test')
            assert.strictEqual(test.meta[TEST_NAME], 'vitest worker env sets DD_VITEST_WORKER')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            assert.strictEqual(test.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
          })

          const exitCode = await Promise.all([
            runVitest({
              TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
              DD_TRACE_DEBUG: 'true',
              DD_TRACE_LOG_LEVEL: 'warn',
              EXPECT_DD_TEST_OPT_VITEST_NO_WORKER_INIT_INACTIVE: '1',
              ...env,
            }),
            payloadsPromise,
          ]).then(([exitCode]) => exitCode)

          assert.strictEqual(exitCode, 0, testOutput)
          assert.match(testOutput, new RegExp(DISABLED_ISOLATE_WARNING), testOutput)
        })
      }

      it('applies no-worker setup data for Test Management', async () => {
        receiver.setSettings({
          test_management: {
            enabled: true,
            attempt_to_fix_retries: 2,
          },
        })
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
              'ci-visibility/vitest-tests/test-quarantine.mjs': {
                tests: {
                  'quarantine tests can quarantine a test': {
                    properties: {
                      quarantined: true,
                    },
                  },
                },
              },
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

        const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
          assertEventCounts(events, {
            test_session_end: 1,
            test_module_end: 1,
            test_suite_end: 3,
            test: 7,
          })

          const tests = getEventContents(events, 'test')
          const [testSession] = getEventContents(events, 'test_session_end')
          assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')

          const disabledTest = getTestByName(tests, 'disable tests can disable a test')
          assert.strictEqual(disabledTest.meta[TEST_STATUS], 'skip')
          assert.strictEqual(disabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')

          const quarantinedTest = getTestByName(tests, 'quarantine tests can quarantine a test')
          assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
          assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

          const attemptedToFixTests = getTestsByName(tests, 'attempt to fix tests can attempt to fix a test')
          assert.strictEqual(attemptedToFixTests.length, 3)

          attemptedToFixTests.forEach((test, index) => {
            assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
            if (index === 0) {
              assert.ok(!(TEST_IS_RETRY in test.meta))
              return
            }
            assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
          })

          const finalAttempt = attemptedToFixTests[attemptedToFixTests.length - 1]
          assert.strictEqual(finalAttempt.meta[TEST_STATUS], 'fail')
          assert.strictEqual(finalAttempt.meta[TEST_FINAL_STATUS], 'fail')
          assert.strictEqual(finalAttempt.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
          assert.strictEqual(finalAttempt.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
        })

        const exitCode = await Promise.all([
          runVitest({
            POOL_CONFIG: 'forks',
            TEST_DIR: 'ci-visibility/vitest-tests/test-{disabled,quarantine,attempt-to-fix}.mjs',
          }),
          payloadsPromise,
        ]).then(([exitCode]) => exitCode)

        assert.strictEqual(exitCode, 1, testOutput)
      })

      it('applies no-worker setup data for early flake detection', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 2,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })
        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
          const tests = getEventContents(events, 'test')
          const [testSession] = getEventContents(events, 'test_session_end')
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const alwaysPassTests = getTestsByName(tests, 'early flake detection can retry tests that always pass')
          assert.strictEqual(alwaysPassTests.length, 3)
          assert.strictEqual(alwaysPassTests[0].meta[TEST_IS_NEW], 'true')
          assert.ok(!(TEST_IS_RETRY in alwaysPassTests[0].meta))
          for (const retryTest of alwaysPassTests.slice(1)) {
            assert.strictEqual(retryTest.meta[TEST_IS_NEW], 'true')
            assert.strictEqual(retryTest.meta[TEST_IS_RETRY], 'true')
            assert.strictEqual(retryTest.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          }

          const knownTest = getTestByName(tests, 'early flake detection does not retry if it is not new')
          assert.ok(!(TEST_IS_NEW in knownTest.meta))
          assert.ok(!(TEST_IS_RETRY in knownTest.meta))
        })

        const exitCode = await Promise.all([
          runVitest({
            TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection.mjs',
            POOL_CONFIG: 'forks',
          }),
          payloadsPromise,
        ]).then(([exitCode]) => exitCode)

        assert.strictEqual(exitCode, 0, testOutput)
      })
    }
  })
})

describe(`vitest@${UNSUPPORTED_VERSION} no-worker init`, () => {
  let cwd, receiver, childProcess, testOutput

  useSandbox([
    `vitest@${UNSUPPORTED_VERSION}`,
    'tinypool',
  ], true)

  before(function () {
    cwd = sandboxCwd()
  })

  beforeEach(async function () {
    childProcess = undefined
    testOutput = ''
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess?.kill()
    await receiver.stop()
  })

  async function runVitest (extraEnv = {}) {
    childProcess = exec(
      './node_modules/.bin/vitest run',
      {
        cwd,
        env: getNoWorkerInitEnv(receiver, extraEnv),
      }
    )

    childProcess.stdout.on('data', data => { testOutput += data })
    childProcess.stderr.on('data', data => { testOutput += data })

    const [exitCode] = await once(childProcess, 'exit')
    return exitCode
  }

  for (const poolConfig of ['forks', 'threads']) {
    it(`warns and falls back to worker instrumentation with pool=${poolConfig}`, async () => {
      const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
        assertEventCounts(events, {
          test_session_end: 1,
          test_module_end: 1,
          test_suite_end: 1,
          test: 1,
        })

        const [test] = getEventContents(events, 'test')
        assert.strictEqual(test.meta[TEST_NAME], 'vitest worker env sets DD_VITEST_WORKER')
        assert.strictEqual(test.meta[TEST_STATUS], 'pass')
        assert.strictEqual(test.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
      })

      const exitCode = await Promise.all([
        runVitest({
          TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
          POOL_CONFIG: poolConfig,
          DD_TRACE_DEBUG: 'true',
          DD_TRACE_LOG_LEVEL: 'warn',
          EXPECT_DD_TEST_OPT_VITEST_NO_WORKER_INIT_INACTIVE: '1',
        }),
        payloadsPromise,
      ]).then(([exitCode]) => exitCode)

      assert.strictEqual(exitCode, 0, testOutput)
      assert.match(testOutput, new RegExp(UNSUPPORTED_VERSION_WARNING), testOutput)
    })
  }
})
