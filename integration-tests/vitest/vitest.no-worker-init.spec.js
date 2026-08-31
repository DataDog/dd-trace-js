'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { exec, execSync } = require('node:child_process')
const { once } = require('node:events')
const { inspect } = require('node:util')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  assertObjectContains,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const noWorkerInit = require('../../packages/datadog-instrumentations/src/vitest-main-no-worker-init')
const {
  RUM_TEST_EXECUTION_ID_COOKIE_NAME,
} = require('../../packages/dd-trace/src/ci-visibility/rum')
const {
  testErrorCh,
  testStartCh,
  testSuiteFinishCh,
  testSuiteStartCh,
} = require('../../packages/datadog-instrumentations/src/vitest-util')
const {
  ERROR_MESSAGE,
} = require('../../packages/dd-trace/src/constants')
const {
  DD_CAPABILITIES_AUTO_TEST_RETRIES,
  DD_CAPABILITIES_EARLY_FLAKE_DETECTION,
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  DD_CAPABILITIES_IMPACTED_TESTS,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX,
  DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE,
  DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS,
  TEST_CODE_COVERAGE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_FINAL_STATUS,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_IS_MODIFIED,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_IS_TEST_FRAMEWORK_WORKER,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_NAME,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_SKIPPED_BY_ITR,
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

function assertRequestErrorTagOnEvents (events, tag) {
  for (const type of ['test_session_end', 'test_module_end', 'test_suite_end']) {
    const [event] = getEventContents(events, type)
    assert.strictEqual(event.meta[tag], 'true', `${type}: ${inspect(event.meta)}`)
  }

  const [test] = getEventContents(events, 'test')
  assert.strictEqual(test.meta[tag], 'true', `test: ${inspect(test.meta)}`)
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

    it('rejects default pool-specific isolate disabled configuration', () => {
      assert.strictEqual(
        noWorkerInit.shouldUse({
          config: {
            poolOptions: {
              forks: {
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

    it('rejects selected test specifications with default pool-specific isolate disabled', () => {
      const project = {
        config: {},
      }

      assert.strictEqual(
        noWorkerInit.shouldUse({
          config: {
            poolOptions: {
              forks: {
                isolate: false,
              },
            },
          },
        }, '3.2.6', [[project, {}]], options),
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

    it('rejects selected test specifications with non-worker tuple pool overrides', () => {
      const project = {
        config: {
          pool: 'forks',
        },
      }

      assert.strictEqual(
        noWorkerInit.shouldUse({ config: { pool: 'forks' } }, '3.2.6', [
          [project, {}, { pool: 'browser' }],
        ], options),
        false
      )
    })
  })

  describe('configure', () => {
    function getNoWorkerReporterContext () {
      const rootProject = { _provided: {} }
      return {
        config: {},
        reporters: [],
        getRootProject () {
          return rootProject
        },
      }
    }

    function configureNoWorkerReporter (ctx, testSpecifications) {
      noWorkerInit.configure(ctx, '3.2.6', testSpecifications, {
        knownTestsBySuite: {},
        modifiedFiles: {},
        repositoryRoot: '/repo',
        testManagementTestsBySuite: {},
        testSessionConfiguration: {},
      }, {
        state: {
          earlyFlakeDetectionRetryPolicy: {
            durationRetryCounts: [
              { durationLimitMs: 5000, retryCount: 2 },
            ],
            schedulingRetryCount: 2,
          },
          isEarlyFlakeDetectionEnabled: true,
          isEarlyFlakeDetectionFaulty: false,
          testManagementAttemptToFixRetries: 0,
        },
      })
    }

    function createReporterTestFile (retryCount = 0, errors = []) {
      const file = {
        filepath: '/repo/watch-rerun.test.mjs',
        id: 'watch-rerun-file',
        meta: {},
        projectName: 'browser',
        result: { state: 'pass' },
        tasks: [],
        type: 'suite',
      }
      const task = {
        file,
        id: 'watch-rerun-test',
        meta: {},
        name: 'does not reuse retry state',
        result: {
          errors,
          retryCount,
          state: 'pass',
        },
        type: 'test',
      }
      file.tasks.push(task)
      return { file, task }
    }

    it('sends execution and RUM configuration to the no-worker setup context', () => {
      const ctx = getNoWorkerReporterContext()

      configureNoWorkerReporter(ctx)

      const setupContext = ctx.getRootProject()._provided._ddVitestWorkerSetup
      assert.deepStrictEqual(setupContext.earlyFlakeDetectionRetryPolicy, {
        durationRetryCounts: [
          { durationLimitMs: 5000, retryCount: 2 },
        ],
        schedulingRetryCount: 2,
      })
      assert.strictEqual(setupContext.isRumCorrelationEnabled, true)
      assert.strictEqual(setupContext.rumTestExecutionIdCookieName, RUM_TEST_EXECUTION_ID_COOKIE_NAME)
    })

    it('installs the Datadog setup before user setup files', () => {
      const ctx = getNoWorkerReporterContext()
      ctx.config.setupFiles = ['/repo/user-setup.mjs']

      configureNoWorkerReporter(ctx)

      assert.strictEqual(ctx.config.includeTaskLocation, true)
      assert.strictEqual(path.basename(ctx.config.setupFiles[0]), 'vitest-no-worker-init-setup.mjs')
      assert.deepStrictEqual(ctx.config.setupFiles.slice(1), ['/repo/user-setup.mjs'])
    })

    it('allows Vite to serve the Datadog setup when dd-trace is linked outside the browser project', () => {
      const ctx = getNoWorkerReporterContext()
      const userPlugin = { name: 'user-plugin' }
      const parentProject = {
        options: {
          plugins: [userPlugin],
        },
      }
      const project = {
        _parent: parentProject,
        config: {
          browser: {
            enabled: true,
          },
        },
      }
      const testSpecifications = [[project, { filepath: '/repo/test.mjs', pool: 'browser' }]]

      configureNoWorkerReporter(ctx, testSpecifications)
      configureNoWorkerReporter(ctx, testSpecifications)

      assert.strictEqual(parentProject.options.plugins[0], userPlugin)
      assert.strictEqual(parentProject.options.plugins.length, 2)
      const accessPlugin = parentProject.options.plugins[1]
      assert.strictEqual(accessPlugin.name, 'datadog:vitest-browser-setup-file')

      const viteConfig = {
        resolve: {
          dedupe: ['user-dependency'],
        },
      }
      accessPlugin.config(viteConfig)
      accessPlugin.config(viteConfig)

      assert.deepStrictEqual(viteConfig.resolve.dedupe, ['user-dependency', '@vitest/runner'])
      assert.strictEqual(viteConfig.server, undefined)

      const resolvedConfig = {
        server: {
          fs: {
            allow: ['/repo'],
          },
        },
      }
      accessPlugin.configResolved(resolvedConfig)
      accessPlugin.configResolved(resolvedConfig)

      assert.strictEqual(resolvedConfig.server.fs.allow[0], '/repo')
      assert.strictEqual(resolvedConfig.server.fs.allow.length, 2)
      assert.strictEqual(path.basename(resolvedConfig.server.fs.allow[1]), 'vitest-no-worker-init-setup.mjs')
    })

    it('does not install the Vite access plugin for Node test projects', () => {
      const ctx = getNoWorkerReporterContext()
      const project = {
        config: {
          pool: 'forks',
        },
      }

      configureNoWorkerReporter(ctx, [[project, { filepath: '/repo/test.mjs', pool: 'forks' }]])

      assert.strictEqual(project.options, undefined)
    })

    for (const [description, project] of [
      ['the project API', { isBrowserEnabled: () => true }],
      ['serialized configuration', {
        get config () {
          throw new Error('config is unavailable')
        },
        serializedConfig: {
          browser: {
            enabled: true,
          },
        },
      }],
    ]) {
      it(`installs the Vite access plugin for Browser Mode detected through ${description}`, () => {
        const ctx = getNoWorkerReporterContext()

        configureNoWorkerReporter(ctx, [[project, { filepath: '/repo/test.mjs' }]])

        assert.strictEqual(project.options.plugins[0].name, 'datadog:vitest-browser-setup-file')
        assert.strictEqual(
          typeof project.options.browser.commands.__dd_vitest_efd_suite_admission,
          'function'
        )
      })
    }

    it('disables RUM correlation when browser files can run in parallel', () => {
      const ctx = getNoWorkerReporterContext()
      const project = {
        config: {
          browser: {
            enabled: true,
          },
          fileParallelism: true,
        },
      }

      configureNoWorkerReporter(ctx, [
        [project, { filepath: '/repo/first.test.mjs', pool: 'browser' }],
        [project, { filepath: '/repo/second.test.mjs', pool: 'browser' }],
      ])

      assert.strictEqual(ctx.getRootProject()._provided._ddVitestWorkerSetup.isRumCorrelationEnabled, false)
    })

    it('disables RUM correlation when browser setup files run in parallel', () => {
      const ctx = getNoWorkerReporterContext()
      const project = {
        config: {
          browser: {
            enabled: true,
          },
          sequence: {
            setupFiles: 'parallel',
          },
        },
      }

      configureNoWorkerReporter(ctx, [
        [project, { filepath: '/repo/test.mjs', pool: 'browser' }],
      ])

      assert.strictEqual(ctx.getRootProject()._provided._ddVitestWorkerSetup.isRumCorrelationEnabled, false)
    })

    it('disables RUM correlation when tests are globally concurrent', () => {
      const ctx = getNoWorkerReporterContext()
      const project = {
        config: {
          browser: {
            enabled: true,
          },
          sequence: {
            concurrent: true,
          },
        },
      }

      configureNoWorkerReporter(ctx, [
        [project, { filepath: '/repo/test.mjs', pool: 'browser' }],
      ])

      assert.strictEqual(ctx.getRootProject()._provided._ddVitestWorkerSetup.isRumCorrelationEnabled, false)
    })

    it('disables RUM correlation when browser hooks run in parallel', () => {
      const ctx = getNoWorkerReporterContext()
      const project = {
        config: {
          browser: {
            enabled: true,
          },
          sequence: {
            hooks: 'parallel',
          },
        },
      }

      configureNoWorkerReporter(ctx, [
        [project, { filepath: '/repo/test.mjs', pool: 'browser' }],
      ])

      assert.strictEqual(ctx.getRootProject()._provided._ddVitestWorkerSetup.isRumCorrelationEnabled, false)
    })

    it('keeps RUM correlation enabled when browser files run sequentially', () => {
      const ctx = getNoWorkerReporterContext()
      const project = {
        config: {
          browser: {
            enabled: true,
          },
          fileParallelism: false,
          sequence: {
            hooks: 'list',
          },
        },
      }

      configureNoWorkerReporter(ctx, [
        [project, { filepath: '/repo/first.test.mjs', pool: 'browser' }],
        [project, { filepath: '/repo/second.test.mjs', pool: 'browser' }],
      ])

      assert.strictEqual(ctx.getRootProject()._provided._ddVitestWorkerSetup.isRumCorrelationEnabled, true)
    })

    it('uses resolved browser file parallelism when available', () => {
      const ctx = getNoWorkerReporterContext()
      const project = {
        config: {
          browser: {
            enabled: true,
            fileParallelism: false,
          },
          fileParallelism: true,
        },
      }

      configureNoWorkerReporter(ctx, [
        [project, { filepath: '/repo/first.test.mjs', pool: 'browser' }],
        [project, { filepath: '/repo/second.test.mjs', pool: 'browser' }],
      ])

      assert.strictEqual(ctx.getRootProject()._provided._ddVitestWorkerSetup.isRumCorrelationEnabled, true)
    })

    it('uses serialized browser configuration for reporter metadata', () => {
      const ctx = getNoWorkerReporterContext()
      const testSuiteStarts = []
      const onTestSuiteStart = context => testSuiteStarts.push({
        browserDriver: context.browserDriver,
        browserName: context.browserName,
        isBrowserMode: context.isBrowserMode,
      })
      testSuiteStartCh.subscribe(onTestSuiteStart)

      try {
        configureNoWorkerReporter(ctx)
        ctx.reporters[0].onTestModuleStart({
          id: 'serialized-browser-module',
          moduleId: '/repo/serialized-browser.test.mjs',
          project: {
            serializedConfig: {
              browser: {
                enabled: true,
                name: 'chromium',
                provider: 'playwright',
              },
            },
          },
        })
      } finally {
        testSuiteStartCh.unsubscribe(onTestSuiteStart)
      }

      assert.deepStrictEqual(testSuiteStarts, [{
        browserDriver: 'playwright',
        browserName: 'chromium',
        isBrowserMode: true,
      }])
    })

    it('reports the source line collected by Vitest', () => {
      const ctx = getNoWorkerReporterContext()
      const testStartLines = []
      const onTestStart = context => testStartLines.push(context.testStartLine)
      testStartCh.subscribe(onTestStart)

      try {
        configureNoWorkerReporter(ctx)
        const { file, task } = createReporterTestFile()
        task.location = {
          column: 3,
          line: 42,
        }
        ctx.reporters[0].onTestCaseResult({ task })
        ctx.reporters[0].onFinished([file])
      } finally {
        testStartCh.unsubscribe(onTestStart)
      }

      assert.deepStrictEqual(testStartLines, [42])
    })

    it('removes Vitest browser URL metadata from reported errors', () => {
      const ctx = getNoWorkerReporterContext()
      const reportedErrors = []
      const onTestError = context => reportedErrors.push(context.error)
      const error = {
        message: 'failed at http://localhost:63315/repo/test.mjs?import&browserv=1785328307188:60:13',
        name: 'Error',
        stack: [
          'Error: failed',
          '    at http://localhost:63315/repo/test.mjs?import&browserv=1785328307188:60:13',
          '    at http://localhost:63315/repo/helper.mjs?foo=bar:10:5',
        ].join('\n'),
        stacks: [{
          column: 13,
          file: '/repo/test.mjs',
          line: 60,
          method: '',
        }, {
          column: 5,
          file: '/repo/helper.mjs?foo=bar',
          line: 10,
          method: 'runHelper',
        }],
      }
      testErrorCh.subscribe(onTestError)

      try {
        configureNoWorkerReporter(ctx)
        const { file, task } = createReporterTestFile(0, [error])
        file.pool = 'browser'
        task.result.state = 'fail'
        file.result.state = 'fail'
        ctx.reporters[0].onTestCaseResult({ task })
        ctx.reporters[0].onFinished([file])
      } finally {
        testErrorCh.unsubscribe(onTestError)
      }

      assert.strictEqual(reportedErrors.length, 1)
      assert.strictEqual(reportedErrors[0].message, 'failed at http://localhost:63315/repo/test.mjs:60:13')
      assert.strictEqual(reportedErrors[0].stack, [
        'Error: failed',
        '    at /repo/test.mjs:60:13',
        '    at runHelper (/repo/helper.mjs?foo=bar:10:5)',
      ].join('\n'))
      assert.match(error.stack, /\?import&browserv=/)
    })

    it('preserves Node error URLs for final and repeated attempts', () => {
      const reportedErrors = []
      const onTestError = context => reportedErrors.push(context.error)
      const finalError = {
        message: 'failed at http://localhost:63315/repo/test.mjs?import&browserv=123:60:13',
        stack: 'Error: failed\n    at http://localhost:63315/repo/test.mjs?import&browserv=123:60:13',
      }
      const retryError = {
        message: 'retry at http://localhost:63315/repo/test.mjs?import&browserv=456:70:13',
        stack: 'Error: retry\n    at http://localhost:63315/repo/test.mjs?import&browserv=456:70:13',
      }
      testErrorCh.subscribe(onTestError)

      try {
        const finalCtx = getNoWorkerReporterContext()
        configureNoWorkerReporter(finalCtx)
        const finalRun = createReporterTestFile(0, [finalError])
        finalRun.task.result.state = 'fail'
        finalRun.file.result.state = 'fail'
        finalCtx.reporters[0].onTestCaseResult({ task: finalRun.task })
        finalCtx.reporters[0].onFinished([finalRun.file])

        const retryCtx = getNoWorkerReporterContext()
        configureNoWorkerReporter(retryCtx)
        const retryRun = createReporterTestFile(1, [retryError])
        retryCtx.reporters[0].onTaskUpdate(
          [[retryRun.task.id, retryRun.task.result, retryRun.task.meta]],
          [[retryRun.task.id, 'test-retried']]
        )
        retryCtx.reporters[0].onTestCaseResult({ task: retryRun.task })
        retryCtx.reporters[0].onFinished([retryRun.file])
      } finally {
        testErrorCh.unsubscribe(onTestError)
      }

      assert.strictEqual(reportedErrors.length, 2)
      assert.strictEqual(reportedErrors[0], finalError)
      assert.strictEqual(reportedErrors[1], retryError)
    })

    it('deactivates the no-worker reporter for reused contexts that fall back', () => {
      const ctx = getNoWorkerReporterContext()
      const testSuiteStarts = []
      const onTestSuiteStart = context => testSuiteStarts.push(context.testSuiteAbsolutePath)
      testSuiteStartCh.subscribe(onTestSuiteStart)

      try {
        configureNoWorkerReporter(ctx)
        assert.strictEqual(ctx.reporters.length, 1)

        ctx.reporters[0].onTestModuleStart({
          id: 'first',
          moduleId: '/repo/first.test.mjs',
        })
        noWorkerInit.deactivate(ctx)
        assert.strictEqual(ctx.getRootProject()._provided._ddVitestWorkerSetup.isActive, false)
        ctx.reporters[0].onTestModuleStart({
          id: 'second',
          moduleId: '/repo/second.test.mjs',
        })
      } finally {
        testSuiteStartCh.unsubscribe(onTestSuiteStart)
      }

      assert.deepStrictEqual(testSuiteStarts, ['/repo/first.test.mjs'])
    })

    it('clears completed modules and retry state before a watch rerun', () => {
      const ctx = getNoWorkerReporterContext()
      const testAttemptRetries = []
      const onTestStart = context => testAttemptRetries.push(context.isRetry)
      testStartCh.subscribe(onTestStart)

      try {
        configureNoWorkerReporter(ctx)
        const reporter = ctx.reporters[0]
        const firstRun = createReporterTestFile(1, [new Error('first attempt failed')])
        reporter.onTaskUpdate(
          [[firstRun.task.id, firstRun.task.result, firstRun.task.meta]],
          [[firstRun.task.id, 'test-retried']]
        )
        reporter.onTestCaseResult({ task: firstRun.task })
        reporter.onFinished([firstRun.file])

        reporter.onWatcherRerun()

        const secondRun = createReporterTestFile()
        reporter.onTestCaseResult({ task: secondRun.task })
        reporter.onFinished([secondRun.file])
      } finally {
        testStartCh.unsubscribe(onTestStart)
      }

      assert.deepStrictEqual(testAttemptRetries, [false, true, false])
    })

    it('finishes active suites before a watch rerun', () => {
      const ctx = getNoWorkerReporterContext()
      const testSuiteStarts = []
      const testSuiteFinishes = []
      const onTestSuiteStart = context => testSuiteStarts.push(context.testSuiteAbsolutePath)
      const onTestSuiteFinish = context => testSuiteFinishes.push(context)
      testSuiteStartCh.subscribe(onTestSuiteStart)
      testSuiteFinishCh.subscribe(onTestSuiteFinish)

      try {
        configureNoWorkerReporter(ctx)
        const reporter = ctx.reporters[0]
        const { file } = createReporterTestFile()
        reporter.onTestModuleStart(file)

        reporter.onWatcherRerun()
        reporter.onFinished([file])
      } finally {
        testSuiteStartCh.unsubscribe(onTestSuiteStart)
        testSuiteFinishCh.unsubscribe(onTestSuiteFinish)
      }

      assert.deepStrictEqual(testSuiteStarts, [
        '/repo/watch-rerun.test.mjs',
        '/repo/watch-rerun.test.mjs',
      ])
      assert.strictEqual(testSuiteFinishes.length, 2)
      assert.strictEqual(testSuiteFinishes[0].status, 'skip')
      assert.strictEqual(testSuiteFinishes[1].status, 'pass')
    })
  })

  describe('configureWorkerEnv', () => {
    it('restores Datadog NODE_OPTIONS when no-worker mode falls back', () => {
      const noWorkerEnv = noWorkerInit.configureWorkerEnv({
        NODE_OPTIONS: DEFAULT_NODE_OPTIONS,
      }, true)

      assert.strictEqual(noWorkerEnv.NODE_OPTIONS, '--no-warnings')
      assert.strictEqual(noWorkerEnv.DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE, '1')

      const workerEnv = noWorkerInit.configureWorkerEnv({
        NODE_OPTIONS: noWorkerEnv.NODE_OPTIONS,
      })

      assert.strictEqual(workerEnv.NODE_OPTIONS, DEFAULT_NODE_OPTIONS)
      assert.ok(!('DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE' in workerEnv))
    })
  })
})

SUPPORTED_VERSIONS.forEach((version) => {
  describe(`vitest@${version} no-worker init`, () => {
    const latestVitestIt = version === 'latest' && NODE_MAJOR >= 20 ? it : it.skip
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
          assert.ok(
            Number(test.duration) >= 100 * 1e6,
            `Expected test duration to include Vitest execution time, got ${Number(test.duration) / 1e6}ms`
          )
        })

        const exitCode = await Promise.all([
          runVitest({
            TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
            POOL_CONFIG: poolConfig,
            EXPECT_DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE: '1',
            EXPECT_DD_NODE_OPTIONS_PRESERVED: '--no-warnings',
            EXPECT_DD_NODE_OPTIONS_STRIPPED: '1',
            EXPECT_NO_DD_TRACE_INIT: '1',
            WAIT_BEFORE_EXPECTATION_MS: '100',
          }),
          payloadsPromise,
        ]).then(([exitCode]) => exitCode)

        assert.strictEqual(exitCode, 0, testOutput)
      })
    }

    it('does not advertise or apply unsupported capabilities in no-worker mode', async () => {
      const testSuite = 'ci-visibility/vitest-tests/vitest-worker-env.mjs'
      receiver.setSettings({
        di_enabled: true,
        itr_enabled: true,
        code_coverage: true,
        coverage_report_upload_enabled: false,
        tests_skipping: true,
      })
      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: { suite: testSuite },
      }])

      const runPromise = runVitest({
        TEST_DIR: testSuite,
        POOL_CONFIG: 'forks',
        EXPECT_DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE: '1',
        EXPECT_NO_DD_TRACE_INIT: '1',
      })
      const payloadsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) =>
          url === '/api/v2/citestcycle' ||
          url === '/api/v2/citestcov' ||
          url === '/api/v2/ci/tests/skippable',
        payloads => {
          assert.strictEqual(payloads.some(({ url }) => url === '/api/v2/citestcov'), false)
          assert.strictEqual(payloads.some(({ url }) => url === '/api/v2/ci/tests/skippable'), false)

          const cyclePayloads = payloads.filter(({ url }) => url === '/api/v2/citestcycle')
          const metadataDicts = cyclePayloads.flatMap(({ payload }) => payload.metadata)

          assert.ok(metadataDicts.length > 0, `Expected ${metadataDicts.length} > 0`)
          metadataDicts.forEach(metadata => {
            assertObjectContains(metadata.test, {
              [DD_CAPABILITIES_EARLY_FLAKE_DETECTION]: '1',
              [DD_CAPABILITIES_AUTO_TEST_RETRIES]: '1',
              [DD_CAPABILITIES_IMPACTED_TESTS]: '1',
              [DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE]: '1',
              [DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE]: '1',
              [DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX]: '5',
            })
            assert.ok(
              !Object.hasOwn(metadata.test, DD_CAPABILITIES_FAILED_TEST_REPLAY),
              `Available keys: ${inspect(Object.keys(metadata.test))}`
            )
            assert.ok(
              !Object.hasOwn(metadata.test, DD_CAPABILITIES_TEST_IMPACT_ANALYSIS),
              `Available keys: ${inspect(Object.keys(metadata.test))}`
            )
          })

          const events = getEvents(cyclePayloads)
          const [testSession] = getEventContents(events, 'test_session_end')
          const [testSuiteEvent] = getEventContents(events, 'test_suite_end')

          assert.strictEqual(testSuiteEvent.meta[TEST_STATUS], 'pass')
          assert.ok(!(TEST_SKIPPED_BY_ITR in testSuiteEvent.meta))
          assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
          assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
        },
        { hardTimeout: 60_000 }
      )

      const [exitCode] = await Promise.all([runPromise, payloadsPromise])

      assert.strictEqual(exitCode, 0, testOutput)
    })

    it('tags skipped no-worker events with request errors when settings fails', async () => {
      receiver.setSettingsResponseCode(404)

      const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
        assertEventCounts(events, {
          test_session_end: 1,
          test_module_end: 1,
          test_suite_end: 1,
          test: 4,
        })

        assertRequestErrorTagOnEvents(events, DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS)

        const skippedTest = getTestByName(
          getEventContents(events, 'test'),
          'early flake detection does not retry if the test is skipped'
        )
        assert.strictEqual(skippedTest.meta[TEST_STATUS], 'skip')
        assert.strictEqual(
          skippedTest.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS],
          'true',
          `test: ${inspect(skippedTest.meta)}`
        )
      })

      const exitCode = await Promise.all([
        runVitest({
          TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection.mjs',
          POOL_CONFIG: 'forks',
          EXPECT_DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE: '1',
          EXPECT_NO_DD_TRACE_INIT: '1',
        }, './node_modules/.bin/vitest run -t "does not retry if the test is skipped"'),
        payloadsPromise,
      ]).then(([exitCode]) => exitCode)

      assert.strictEqual(exitCode, 0, testOutput)
    })

    it('tags no-worker events with request errors when known tests fails', async () => {
      receiver.setSettings({ known_tests_enabled: true })
      receiver.setKnownTestsResponseCode(404)

      const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
        assertEventCounts(events, {
          test_session_end: 1,
          test_module_end: 1,
          test_suite_end: 1,
          test: 1,
        })

        assertRequestErrorTagOnEvents(events, DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS)
      })

      const exitCode = await Promise.all([
        runVitest({
          TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
          POOL_CONFIG: 'forks',
          EXPECT_DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE: '1',
          EXPECT_NO_DD_TRACE_INIT: '1',
        }),
        payloadsPromise,
      ]).then(([exitCode]) => exitCode)

      assert.strictEqual(exitCode, 0, testOutput)
    })

    it('tags no-worker events with request errors when test management tests fails', async () => {
      receiver.setSettings({
        test_management: {
          enabled: true,
        },
      })
      receiver.setTestManagementTestsResponseCode(404)

      const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
        assertEventCounts(events, {
          test_session_end: 1,
          test_module_end: 1,
          test_suite_end: 1,
          test: 1,
        })

        assertRequestErrorTagOnEvents(events, DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS)
      })

      const exitCode = await Promise.all([
        runVitest({
          TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
          POOL_CONFIG: 'forks',
          EXPECT_DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE: '1',
          EXPECT_NO_DD_TRACE_INIT: '1',
        }),
        payloadsPromise,
      ]).then(([exitCode]) => exitCode)

      assert.strictEqual(exitCode, 0, testOutput)
    })

    it('preserves no-worker env when the programmatic API collects tests', async () => {
      const exitCode = await runVitest({
        TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
        POOL_CONFIG: 'forks',
        EXPECT_DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE: '1',
        EXPECT_DD_NODE_OPTIONS_STRIPPED: '1',
        EXPECT_NO_DD_TRACE_INIT: '1',
      }, 'node ci-visibility/vitest-tests-programmatic-api/run-no-worker-programmatic-api-collect-before-run.mjs')

      assert.strictEqual(exitCode, 0, testOutput)
      assert.match(testOutput, /1 passed/, testOutput)
    })

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
        name: 'default pool isolate disabled',
        env: {
          USE_VITEST_DEFAULT_POOL: '1',
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
            'ci-visibility/vitest-tests/test-attempt-to-fix-skip.mjs': {
              tests: {
                'attempt to fix skip tests can statically skip': {
                  properties: {
                    attempt_to_fix: true,
                    quarantined: true,
                  },
                },
                'attempt to fix skip tests can programmatically skip': {
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

      const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
        assertEventCounts(events, {
          test_session_end: 1,
          test_module_end: 1,
          test_suite_end: 4,
          test: 9,
        })

        const tests = getEventContents(events, 'test')
        const suites = getEventContents(events, 'test_suite_end')
        const [testSession] = getEventContents(events, 'test_session_end')
        assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')

        const disabledTest = getTestByName(tests, 'disable tests can disable a test')
        assert.strictEqual(disabledTest.meta[TEST_STATUS], 'skip')
        assert.strictEqual(disabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')

        const quarantinedTest = getTestByName(tests, 'quarantine tests can quarantine a test')
        assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
        assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')
        assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

        const quarantinedSuite = suites.find(suite =>
          suite.meta[TEST_SOURCE_FILE] === 'ci-visibility/vitest-tests/test-quarantine.mjs'
        )
        assert.ok(quarantinedSuite, inspect(suites.map(suite => suite.meta[TEST_SOURCE_FILE])))
        assert.strictEqual(quarantinedSuite.meta[TEST_STATUS], 'pass')
        assert.ok(!(ERROR_MESSAGE in quarantinedSuite.meta), inspect(quarantinedSuite.meta))

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

        for (const testName of [
          'attempt to fix skip tests can statically skip',
          'attempt to fix skip tests can programmatically skip',
        ]) {
          const skippedAttemptToFixTest = getTestByName(tests, testName)
          assert.strictEqual(skippedAttemptToFixTest.meta[TEST_STATUS], 'skip')
          assert.strictEqual(skippedAttemptToFixTest.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
          assert.strictEqual(skippedAttemptToFixTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
        }
      })

      const exitCode = await Promise.all([
        runVitest({
          POOL_CONFIG: 'forks',
          TEST_DIR: 'ci-visibility/vitest-tests/test-{disabled,quarantine,attempt-to-fix,attempt-to-fix-skip}.mjs',
        }),
        payloadsPromise,
      ]).then(([exitCode]) => exitCode)

      assert.strictEqual(exitCode, 1, testOutput)
      assert.match(testOutput, /Disabled: 1 test skipped\./)
      assert.match(
        testOutput,
        /Attempt to fix failed: 3 of 5 execution\(s\) failed across 1 of 3 test\(s\)\./
      )
    })

    it('does not skip disabled attempt-to-fix tests in no-worker mode', async () => {
      receiver.setSettings({
        test_management: {
          enabled: true,
          attempt_to_fix_retries: 2,
        },
      })
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

      const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
        assertEventCounts(events, {
          test_session_end: 1,
          test_module_end: 1,
          test_suite_end: 1,
          test: 3,
        })

        const attemptedToFixTests = getTestsByName(
          getEventContents(events, 'test'),
          'attempt to fix tests can attempt to fix a test'
        )
        assert.strictEqual(attemptedToFixTests.length, 3)

        attemptedToFixTests.forEach((test, index) => {
          assert.strictEqual(test.meta[TEST_STATUS], 'fail')
          assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
          assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
          if (index === 0) {
            assert.ok(!(TEST_IS_RETRY in test.meta))
            return
          }
          assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
        })

        const finalAttempt = attemptedToFixTests[attemptedToFixTests.length - 1]
        assert.strictEqual(finalAttempt.meta[TEST_FINAL_STATUS], 'fail')
        assert.strictEqual(finalAttempt.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
        assert.strictEqual(finalAttempt.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
      })

      const exitCode = await Promise.all([
        runVitest({
          POOL_CONFIG: 'forks',
          TEST_DIR: 'ci-visibility/vitest-tests/test-attempt-to-fix.mjs',
        }),
        payloadsPromise,
      ]).then(([exitCode]) => exitCode)

      assert.strictEqual(exitCode, 1, testOutput)
    })

    it('applies no-worker setup data for auto test retries', async () => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: {
          enabled: false,
        },
      })

      const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
        assertEventCounts(events, {
          test_session_end: 1,
          test_module_end: 1,
          test_suite_end: 1,
          test: 9,
        })

        const tests = getEventContents(events, 'test')
        const eventuallyPassingTests = getTestsByName(
          tests,
          'flaky test retries can retry tests that eventually pass'
        )
        assert.strictEqual(eventuallyPassingTests.length, 4)
        assert.ok(!(TEST_IS_RETRY in eventuallyPassingTests[0].meta), inspect(eventuallyPassingTests[0].meta))
        for (const retryTest of eventuallyPassingTests.slice(1)) {
          assert.strictEqual(retryTest.meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(retryTest.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
        }
        assert.strictEqual(eventuallyPassingTests[3].meta[TEST_STATUS], 'pass')
        assert.strictEqual(eventuallyPassingTests[3].meta[TEST_FINAL_STATUS], 'pass')

        const neverPassingTests = getTestsByName(tests, 'flaky test retries can retry tests that never pass')
        assert.strictEqual(neverPassingTests.length, 4)
        assert.ok(!(TEST_IS_RETRY in neverPassingTests[0].meta), inspect(neverPassingTests[0].meta))
        for (const retryTest of neverPassingTests.slice(1)) {
          assert.strictEqual(retryTest.meta[TEST_IS_RETRY], 'true')
          assert.strictEqual(retryTest.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
        }
        assert.strictEqual(neverPassingTests[3].meta[TEST_STATUS], 'fail')
        assert.strictEqual(neverPassingTests[3].meta[TEST_FINAL_STATUS], 'fail')
        assert.strictEqual(neverPassingTests[3].meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')

        const unnecessaryRetryTest = getTestByName(tests, 'flaky test retries does not retry if unnecessary')
        assert.ok(!(TEST_IS_RETRY in unnecessaryRetryTest.meta), inspect(unnecessaryRetryTest.meta))
        assert.ok(!(TEST_RETRY_REASON in unnecessaryRetryTest.meta), inspect(unnecessaryRetryTest.meta))
        assert.strictEqual(unnecessaryRetryTest.meta[TEST_FINAL_STATUS], 'pass')
      })

      const exitCode = await Promise.all([
        runVitest({
          DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '3',
          POOL_CONFIG: 'forks',
          TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries.mjs',
        }),
        payloadsPromise,
      ]).then(([exitCode]) => exitCode)

      assert.strictEqual(exitCode, 1, testOutput)
    })

    it('reports user configured Vitest retries as external retries in no-worker mode', async () => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: {
          enabled: false,
        },
      })

      const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
        assertEventCounts(events, {
          test_session_end: 1,
          test_module_end: 1,
          test_suite_end: 1,
          test: 5,
        })

        const tests = getEventContents(events, 'test')
        const retriedTests = getTestsByName(tests, 'flaky test retries can retry tests that eventually pass')
        assert.strictEqual(retriedTests.length, 2)
        assert.ok(!(TEST_IS_RETRY in retriedTests[0].meta), inspect(retriedTests[0].meta))
        assert.ok(!(TEST_RETRY_REASON in retriedTests[0].meta), inspect(retriedTests[0].meta))
        assert.strictEqual(retriedTests[1].meta[TEST_IS_RETRY], 'true')
        assert.strictEqual(retriedTests[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
        assert.strictEqual(retriedTests[1].meta[TEST_FINAL_STATUS], 'fail')
        assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in retriedTests[1].meta), inspect(retriedTests[1].meta))

        const atrTaggedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)
        assert.strictEqual(atrTaggedTests.length, 0, inspect(atrTaggedTests.map(test => test.meta)))
      })

      const exitCode = await Promise.all([
        runVitest({
          DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '3',
          PROJECT_POOL_CONFIG: 'forks',
          PROJECT_RETRY_CONFIG: '1',
          TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries.mjs',
        }, './node_modules/.bin/vitest run --project project-pool'),
        payloadsPromise,
      ]).then(([exitCode]) => exitCode)

      assert.strictEqual(exitCode, 1, testOutput)
    })

    it('preserves user configured Vitest retries when the EFD retry budget is zero', async () => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 0,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      receiver.setKnownTests({ vitest: {} })

      const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
        const tests = getTestsByName(
          getEventContents(events, 'test'),
          'flaky test retries can retry tests that eventually pass'
        )
        assert.strictEqual(tests.length, 2)
        assert.ok(!(TEST_IS_RETRY in tests[0].meta), inspect(tests[0].meta))
        assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
        assert.strictEqual(tests[1].meta[TEST_IS_RETRY], 'true')
        assert.strictEqual(tests[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
        assert.strictEqual(tests[1].meta[TEST_STATUS], 'fail')
        assert.strictEqual(tests[1].meta[TEST_FINAL_STATUS], 'fail')
      })

      const [exitCode] = await Promise.all([
        runVitest({
          PROJECT_POOL_CONFIG: 'forks',
          PROJECT_RETRY_CONFIG: '1',
          TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries.mjs',
        }, './node_modules/.bin/vitest run --project project-pool -t "can retry tests that eventually pass"'),
        payloadsPromise,
      ])

      assert.strictEqual(exitCode, 1, testOutput)
    })

    it('does not double report delayed final failed Vitest retries in no-worker mode', async () => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: false,
        early_flake_detection: {
          enabled: false,
        },
      })

      const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
        assertEventCounts(events, {
          test_session_end: 1,
          test_module_end: 1,
          test_suite_end: 1,
          test: 2,
        })

        const retriedTests = getTestsByName(
          getEventContents(events, 'test'),
          'slow failing retry does not double report final failed retry'
        )
        assert.strictEqual(retriedTests.length, 2)
        assert.ok(!(TEST_IS_RETRY in retriedTests[0].meta), inspect(retriedTests[0].meta))
        assert.strictEqual(retriedTests[0].meta[TEST_STATUS], 'fail')
        assert.ok(
          Number(retriedTests[0].duration) < 100 * 1e6,
          'Expected first attempt duration to exclude the delayed final retry, got ' +
            `${Number(retriedTests[0].duration) / 1e6}ms`
        )
        assert.strictEqual(retriedTests[1].meta[TEST_IS_RETRY], 'true')
        assert.strictEqual(retriedTests[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
        assert.strictEqual(retriedTests[1].meta[TEST_STATUS], 'fail')
        assert.strictEqual(retriedTests[1].meta[TEST_FINAL_STATUS], 'fail')
        assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in retriedTests[1].meta), inspect(retriedTests[1].meta))
      })

      const exitCode = await Promise.all([
        runVitest({
          PROJECT_POOL_CONFIG: 'forks',
          PROJECT_RETRY_CONFIG: '1',
          TEST_DIR: 'ci-visibility/vitest-tests/slow-failing-retry.mjs',
        }, './node_modules/.bin/vitest run --project project-pool'),
        payloadsPromise,
      ]).then(([exitCode]) => exitCode)

      assert.strictEqual(exitCode, 1, testOutput)
    })

    it('applies no-worker setup data for impacted tests', async () => {
      receiver.setSettings({
        impacted_tests_enabled: true,
        early_flake_detection: {
          enabled: false,
        },
      })

      execSync('git checkout -b no-worker-impacted-test', { cwd, stdio: 'ignore' })
      fs.writeFileSync(
        path.join(cwd, 'ci-visibility/vitest-tests/impacted-test.mjs'),
        `import { describe, test, expect } from 'vitest'

describe('impacted test', () => {
  test('can impacted test', () => {
    expect(2 + 2).to.equal(4)
  })
})
`
      )
      execSync('git add ci-visibility/vitest-tests/impacted-test.mjs', { cwd, stdio: 'ignore' })
      execSync('git commit -m "modify impacted test"', { cwd, stdio: 'ignore' })

      try {
        const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
          assertEventCounts(events, {
            test_session_end: 1,
            test_module_end: 1,
            test_suite_end: 1,
            test: 1,
          })

          const tests = getEventContents(events, 'test')
          const impactedTest = getTestByName(tests, 'impacted test can impacted test')
          assert.strictEqual(impactedTest.meta[TEST_STATUS], 'pass')
          assert.strictEqual(impactedTest.meta[TEST_IS_MODIFIED], 'true')
          assert.ok(!(TEST_IS_NEW in impactedTest.meta), inspect(impactedTest.meta))
          assert.ok(!(TEST_IS_RETRY in impactedTest.meta), inspect(impactedTest.meta))
        })

        const exitCode = await Promise.all([
          runVitest({
            GITHUB_BASE_REF: '',
            POOL_CONFIG: 'forks',
            TEST_DIR: 'ci-visibility/vitest-tests/impacted-test.mjs',
          }),
          payloadsPromise,
        ]).then(([exitCode]) => exitCode)

        assert.strictEqual(exitCode, 0, testOutput)
      } finally {
        execSync('git checkout -', { cwd, stdio: 'ignore' })
        execSync('git branch -D no-worker-impacted-test', { cwd, stdio: 'ignore' })
      }
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

    it('preserves quarantine final status for a new test retried by EFD', async () => {
      const testSuite = 'ci-visibility/vitest-tests/test-quarantine.mjs'
      const testName = 'quarantine tests can quarantine a test'
      const numRetries = 2
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': numRetries,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
        test_management: { enabled: true },
      })
      receiver.setKnownTests({
        vitest: {
          [testSuite]: [
            'quarantine tests can pass normally',
            'quarantine tests can quarantine a passing test',
          ],
        },
      })
      receiver.setTestManagementTests({
        vitest: {
          suites: {
            [testSuite]: {
              tests: {
                [testName]: {
                  properties: {
                    quarantined: true,
                  },
                },
              },
            },
          },
        },
      })

      const runPromise = runVitest({
        TEST_DIR: testSuite,
        POOL_CONFIG: 'forks',
      })
      const payloadsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url === '/api/v2/citestcycle',
        payloads => {
          const events = getEvents(payloads)
          const tests = getTestsByName(getEventContents(events, 'test'), testName)
          const [testSession] = getEventContents(events, 'test_session_end')

          assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
          assert.strictEqual(tests.length, numRetries + 1)
          for (const test of tests) {
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
            assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
          }

          assert.ok(!(TEST_IS_RETRY in tests[0].meta))
          for (const retry of tests.slice(1)) {
            assert.strictEqual(retry.meta[TEST_IS_RETRY], 'true')
            assert.strictEqual(retry.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          }
          assert.strictEqual(tests.at(-1).meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(tests.at(-1).meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
        },
        { hardTimeout: 60_000 }
      )

      const exitCode = await Promise.all([
        runPromise,
        payloadsPromise,
      ]).then(([exitCode]) => exitCode)

      assert.strictEqual(exitCode, 0, testOutput)
    })

    latestVitestIt('uses legacy EFD faultiness detection in no-worker mode', async () => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 2,
          },
          faulty_session_threshold: 1,
        },
        known_tests_enabled: true,
      })
      receiver.setKnownTests({ vitest: {} })

      const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
        const [testSession] = getEventContents(events, 'test_session_end')
        assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
        assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

        const tests = getEventContents(events, 'test')
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(new Set(tests.map(test => test.meta[TEST_SUITE])).size, 2)
        for (const test of tests) {
          assert.ok(!(TEST_IS_NEW in test.meta))
          assert.ok(!(TEST_IS_RETRY in test.meta))
        }
      })

      const exitCode = await Promise.all([
        runVitest({
          TEST_DIR: 'ci-visibility/vitest-tests/efd-suite-admission-*',
          POOL_CONFIG: 'threads',
        }),
        payloadsPromise,
      ]).then(([exitCode]) => exitCode)

      assert.strictEqual(exitCode, 0, testOutput)
    })

    it('normalizes no-worker setup data when the repository root is a symlink', async () => {
      const testSuite = 'ci-visibility/vitest-tests/early-flake-detection.mjs'
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
          [testSuite]: [
            'early flake detection does not retry if it is not new',
          ],
        },
      })

      const linkedRepositoryRoot = path.join(
        path.dirname(cwd),
        `repository-link-${path.basename(cwd)}-${process.pid}`
      )
      fs.symlinkSync(cwd, linkedRepositoryRoot, process.platform === 'win32' ? 'junction' : 'dir')

      try {
        const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
          assert.strictEqual(getEventContents(events, 'test_session_end').length, 1)
          const knownTests = getTestsByName(
            getEventContents(events, 'test'),
            'early flake detection does not retry if it is not new'
          )
          assert.strictEqual(knownTests.length, 1)
          assert.ok(!(TEST_IS_NEW in knownTests[0].meta), inspect(knownTests[0].meta))
          assert.ok(!(TEST_IS_RETRY in knownTests[0].meta), inspect(knownTests[0].meta))
          assert.strictEqual(knownTests[0].meta[TEST_SUITE], testSuite)
        })

        const exitCode = await Promise.all([
          runVitest({
            CI_PROJECT_DIR: linkedRepositoryRoot,
            GITLAB_CI: 'true',
            POOL_CONFIG: 'forks',
            TEST_DIR: testSuite,
          }),
          payloadsPromise,
        ]).then(([exitCode]) => exitCode)

        assert.strictEqual(exitCode, 0, testOutput)
      } finally {
        fs.unlinkSync(linkedRepositoryRoot)
      }
    })

    it('uses an unmocked clock for no-worker attempt durations and EFD retries', async () => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 2,
            '10s': 1,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      receiver.setKnownTests({ vitest: {} })

      const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
        const tests = getTestsByName(
          getEventContents(events, 'test'),
          'uses real time for early flake detection with fake timers'
        )
        assert.strictEqual(tests.length, 3)
        for (let index = 0; index < tests.length; index++) {
          const test = tests[index]
          assert.ok(
            Number(test.duration) < 1000 * 1e6,
            `Expected duration to use an unmocked clock, got ${Number(test.duration) / 1e6}ms`
          )
          if (index === 0) {
            assert.ok(!(TEST_IS_RETRY in test.meta), inspect(test.meta))
          } else {
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          }
        }
      })

      const exitCode = await Promise.all([
        runVitest({
          TEST_DIR: 'ci-visibility/vitest-tests/efd-fake-timers.mjs',
          POOL_CONFIG: 'forks',
          VITEST_SETUP_FILE: 'ci-visibility/vitest-tests/fake-timers-setup.mjs',
        }),
        payloadsPromise,
      ]).then(([exitCode]) => exitCode)

      assert.strictEqual(exitCode, 0, testOutput)
    })

    it('keeps a failed slow EFD test failed when remaining repeats are no-ops', async () => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 0,
            '10s': 2,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      receiver.setKnownTests({ vitest: {} })

      const payloadsPromise = gatherCitestcyclePayloads(receiver, events => {
        const tests = getEventContents(events, 'test')
        const [testSession] = getEventContents(events, 'test_session_end')
        const retriedTests = getTestsByName(tests, 'early flake detection can retry tests that always pass')
        assert.ok(retriedTests.length > 0, inspect(tests.map(test => test.meta[TEST_NAME])))
        retriedTests.forEach(test => {
          assert.strictEqual(test.meta[TEST_STATUS], 'fail', inspect(test.meta))
        })
        const finalTest = retriedTests[retriedTests.length - 1]
        assert.strictEqual(finalTest.meta[TEST_FINAL_STATUS], 'fail')
        assert.strictEqual(finalTest.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'slow')
        assert.ok(!(TEST_IS_RETRY in finalTest.meta), inspect(finalTest.meta))
        assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
      })

      const exitCode = await Promise.all([
        runVitest({
          ALWAYS_FAIL: '1',
          TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection.mjs',
          POOL_CONFIG: 'forks',
        }, './node_modules/.bin/vitest run -t "can retry tests that always pass"'),
        payloadsPromise,
      ]).then(([exitCode]) => exitCode)

      assert.strictEqual(exitCode, 1, testOutput)
    })
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
