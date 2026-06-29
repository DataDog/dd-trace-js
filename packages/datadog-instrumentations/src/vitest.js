'use strict'

// Capture real timers at module load time, before any test can install fake timers.
const realSetTimeout = setTimeout

const path = require('node:path')
const { performance } = require('node:perf_hooks')

const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')
const {
  VITEST_WORKER_TRACE_PAYLOAD_CODE,
  VITEST_WORKER_LOGS_PAYLOAD_CODE,
  DYNAMIC_NAME_RE,
  getTestSuitePath,
  getEfdRetryCount,
  getMaxEfdRetryCount,
  recordAttemptToFixExecution,
  collectTestOptimizationSummariesFromTraces,
  logAttemptToFixTestExecution,
  logTestOptimizationSummary,
  getTestOptimizationRequestResults,
  isModifiedTest,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS,
} = require('../../dd-trace/src/plugins/util/test')
const { addHook, channel } = require('./helpers/instrument')

// test hooks
const testStartCh = channel('ci:vitest:test:start')
const testFinishTimeCh = channel('ci:vitest:test:finish-time')
const testPassCh = channel('ci:vitest:test:pass')
const testErrorCh = channel('ci:vitest:test:error')
const testSkipCh = channel('ci:vitest:test:skip')
const isNewTestCh = channel('ci:vitest:test:is-new')
const isAttemptToFixCh = channel('ci:vitest:test:is-attempt-to-fix')
const isDisabledCh = channel('ci:vitest:test:is-disabled')
const isQuarantinedCh = channel('ci:vitest:test:is-quarantined')
const isModifiedCh = channel('ci:vitest:test:is-modified')
const testFnCh = channel('ci:vitest:test:fn')

// test suite hooks
const testSuiteStartCh = channel('ci:vitest:test-suite:start')
const testSuiteFinishCh = channel('ci:vitest:test-suite:finish')
const testSuiteErrorCh = channel('ci:vitest:test-suite:error')

// test session hooks
const testSessionStartCh = channel('ci:vitest:session:start')
const testSessionFinishCh = channel('ci:vitest:session:finish')
const testSessionConfigurationCh = channel('ci:vitest:session:configuration')
const libraryConfigurationCh = channel('ci:vitest:library-configuration')
const knownTestsCh = channel('ci:vitest:known-tests')
const isEarlyFlakeDetectionFaultyCh = channel('ci:vitest:is-early-flake-detection-faulty')
const testManagementTestsCh = channel('ci:vitest:test-management-tests')
const modifiedFilesCh = channel('ci:vitest:modified-files')

const workerReportTraceCh = channel('ci:vitest:worker-report:trace')
const workerReportLogsCh = channel('ci:vitest:worker-report:logs')
const codeCoverageReportCh = channel('ci:vitest:coverage-report')

const taskToCtx = new WeakMap()
const taskToStatuses = new WeakMap()
const taskToReportedErrorCount = new WeakMap()
const attemptToFixTaskToStatuses = new WeakMap()
const originalHookFns = new WeakMap()
const newTasks = new WeakSet()
const dynamicNameTasks = new WeakSet()
const newTestsWithDynamicNames = new Set()
const disabledTasks = new WeakSet()
const quarantinedTasks = new WeakSet()
const attemptToFixTasks = new WeakSet()
const modifiedTasks = new WeakSet()
const efdDeterminedRetries = new WeakMap()
const efdSlowAbortedTasks = new WeakSet()
const efdExecutionStartByTask = new WeakMap()
const efdSkippedRetryResults = new WeakMap()
const attemptToFixExecutions = new Map()
const loggedAttemptToFixTests = new Set()
let isRetryReasonEfd = false
let isRetryReasonAttemptToFix = false
const switchedStatuses = new WeakSet()
const workerProcesses = new WeakSet()
const mainProcessSetupPromises = new WeakMap()
const coverageWrappedProviders = new WeakSet()
const finishWrappedContexts = new WeakSet()
const mainProcessReporterContexts = new WeakSet()
let isFlakyTestRetriesEnabled = false
let flakyTestRetriesCount = 0
let isEarlyFlakeDetectionEnabled = false
let earlyFlakeDetectionNumRetries = 0
let earlyFlakeDetectionSlowTestRetries = {}
let isEarlyFlakeDetectionFaulty = false
let isKnownTestsEnabled = false
let isTestManagementTestsEnabled = false
let isImpactedTestsEnabled = false
let vitestGetFn = null
let vitestSetFn = null
let vitestGetHooks = null
let testManagementAttemptToFixRetries = 0
let isDiEnabled = false
let testOptimizationRequestErrorTags = {}
let testCodeCoverageLinesTotal
let coverageRootDir
let isSessionStarted = false
let vitestPool = null
let isVitestNoWorkerInitActive = false
let hasWarnedVitestNoWorkerInitWithIsolationDisabled = false

const BREAKPOINT_HIT_GRACE_PERIOD_MS = 400
const DATADOG_TEST_OPTIMIZATION_BOOTSTRAPS = new Set([
  'dd-trace/register.js',
  'dd-trace/ci/init',
  'dd-trace/ci/init.js',
])
const DATADOG_TEST_OPTIMIZATION_NODE_OPTION_FLAGS = new Set(['--import', '--require', '-r'])
const VITEST_NO_WORKER_INIT_ACTIVE_ENV = 'DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE'
const VITEST_NO_WORKER_INIT_REQUEST_ENV = 'DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT'
const NODE_OPTIONS_QUOTE_RE = /[\s"\\]/
const VITEST_NO_WORKER_INIT_ISOLATE_WARNING =
  `${VITEST_NO_WORKER_INIT_REQUEST_ENV} is ignored because Vitest isolate is disabled. ` +
  'The lighter Vitest worker path only helps when each test file runs in an isolated worker.'

function noop () {}

function getConfiguredEfdRetryCount (slowTestRetries, fallbackRetryCount) {
  if (!slowTestRetries || !Object.keys(slowTestRetries).length) {
    return fallbackRetryCount
  }
  return getMaxEfdRetryCount(slowTestRetries)
}

function getTestCommand () {
  return `vitest ${process.argv.slice(2).join(' ')}`
}

function waitForHitProbe () {
  return new Promise(resolve => {
    realSetTimeout(() => {
      resolve()
    }, BREAKPOINT_HIT_GRACE_PERIOD_MS)
  })
}

function isValidKnownTests (receivedKnownTests) {
  return !!receivedKnownTests.vitest
}

function getProvidedContext () {
  try {
    const {
      _ddIsEarlyFlakeDetectionEnabled,
      _ddIsDiEnabled,
      _ddKnownTests: knownTests,
      _ddEarlyFlakeDetectionNumRetries: numRepeats,
      _ddEarlyFlakeDetectionSlowTestRetries: slowTestRetries,
      _ddIsKnownTestsEnabled: isKnownTestsEnabled,
      _ddIsTestManagementTestsEnabled: isTestManagementTestsEnabled,
      _ddTestManagementAttemptToFixRetries: testManagementAttemptToFixRetries,
      _ddTestManagementTests: testManagementTests,
      _ddIsFlakyTestRetriesEnabled: isFlakyTestRetriesEnabled,
      _ddFlakyTestRetriesCount: flakyTestRetriesCount,
      _ddFlakyTestRetriesIncludesUnnamedProject: flakyTestRetriesIncludesUnnamedProject,
      _ddFlakyTestRetriesProjectNames: flakyTestRetriesProjectNames,
      _ddIsImpactedTestsEnabled: isImpactedTestsEnabled,
      _ddModifiedFiles: modifiedFiles,
      _ddTestSessionId: testSessionId,
      _ddTestModuleId: testModuleId,
      _ddTestCommand: testCommand,
      _ddRepositoryRoot: repositoryRoot,
      _ddCodeOwnersEntries: codeOwnersEntries,
    } = globalThis.__vitest_worker__.providedContext

    return {
      isDiEnabled: _ddIsDiEnabled,
      isEarlyFlakeDetectionEnabled: _ddIsEarlyFlakeDetectionEnabled,
      knownTests,
      numRepeats,
      slowTestRetries: slowTestRetries ?? {},
      isKnownTestsEnabled,
      isTestManagementTestsEnabled,
      testManagementAttemptToFixRetries,
      testManagementTests,
      isFlakyTestRetriesEnabled,
      flakyTestRetriesCount: flakyTestRetriesCount ?? 0,
      flakyTestRetriesIncludesUnnamedProject,
      flakyTestRetriesProjectNames,
      isImpactedTestsEnabled,
      modifiedFiles,
      testSessionId,
      testModuleId,
      testCommand,
      repositoryRoot,
      codeOwnersEntries,
    }
  } catch {
    log.error('Vitest workers could not parse provided context, so some features will not work.')
    return {
      isDiEnabled: false,
      isEarlyFlakeDetectionEnabled: false,
      knownTests: {},
      numRepeats: 0,
      slowTestRetries: {},
      isKnownTestsEnabled: false,
      isTestManagementTestsEnabled: false,
      testManagementAttemptToFixRetries: 0,
      testManagementTests: {},
      isFlakyTestRetriesEnabled: false,
      flakyTestRetriesCount: 0,
      flakyTestRetriesIncludesUnnamedProject: false,
      flakyTestRetriesProjectNames: undefined,
      isImpactedTestsEnabled: false,
      modifiedFiles: {},
      testSessionId: undefined,
      testModuleId: undefined,
      testCommand: undefined,
      repositoryRoot: undefined,
      codeOwnersEntries: undefined,
    }
  }
}

function isReporterPackage (vitestPackage) {
  return vitestPackage.B?.name === 'BaseSequencer'
}

// from 2.0.0
function isReporterPackageNew (vitestPackage) {
  return vitestPackage.e?.name === 'BaseSequencer'
}

function isReporterPackageNewest (vitestPackage) {
  return vitestPackage.h?.name === 'BaseSequencer'
}

/**
 * Finds an export by its `.name` property in a minified vitest chunk.
 * Minified export keys change across versions, so we search by function/class name.
 * @param {object} pkg - The module exports object
 * @param {string} name - The `.name` value to look for
 * @returns {{ key: string, value: Function } | undefined}
 */
function findExportByName (pkg, name) {
  for (const [key, value] of Object.entries(pkg)) {
    if (value?.name === name) {
      return { key, value }
    }
  }
}

function getBaseSequencerExport (vitestPackage) {
  return findExportByName(vitestPackage, 'BaseSequencer')
}

function getChannelPromise (channelToPublishTo, frameworkVersion) {
  return new Promise(resolve => {
    channelToPublishTo.publish({ onDone: resolve, frameworkVersion })
  })
}

function isCliApiPackage (vitestPackage) {
  return !!findExportByName(vitestPackage, 'startVitest')
}

function getTestRunnerExport (testPackage) {
  return findExportByName(testPackage, 'VitestTestRunner') || findExportByName(testPackage, 'TestRunner')
}

function getVitestExport (vitestPackage) {
  return findExportByName(vitestPackage, 'Vitest')
}

function getForksPoolWorkerExport (vitestPackage) {
  return findExportByName(vitestPackage, 'ForksPoolWorker')
}

function getThreadsPoolWorkerExport (vitestPackage) {
  return findExportByName(vitestPackage, 'ThreadsPoolWorker')
}

function getSessionStatus (state) {
  if (state.getCountOfFailedTests() > 0) {
    return 'fail'
  }
  if (state.pathsSet.size === 0) {
    return 'skip'
  }
  return 'pass'
}

// From https://github.com/vitest-dev/vitest/blob/51c04e2f44d91322b334f8ccbcdb368facc3f8ec/packages/runner/src/run.ts#L243-L250
function getVitestTestStatus (test, retryCount) {
  if (test.result.state !== 'fail' && (!test.repeats || (test.retry ?? 0) === retryCount)) {
    return 'pass'
  }
  return 'fail'
}

function getTypeTasks (fileTasks, type = 'test') {
  const typeTasks = []

  function getTasks (tasks) {
    for (const task of tasks) {
      if (task.type === type) {
        typeTasks.push(task)
      } else if (task.tasks) {
        getTasks(task.tasks)
      }
    }
  }

  getTasks(fileTasks)

  return typeTasks
}

function getTestName (task) {
  let testName = task.name
  let currentTask = task.suite

  while (currentTask) {
    if (currentTask.name) {
      testName = `${currentTask.name} ${testName}`
    }
    currentTask = currentTask.suite
  }

  return testName
}

function getFinalAttemptToFixStatus (task, state, isSwitchedStatus, testCtx) {
  if (isSwitchedStatus && attemptToFixTasks.has(task) && testCtx?.status) {
    return testCtx.status
  }

  return state === 'fail' ? 'fail' : 'pass'
}

function recordFinalAttemptToFixExecution (task, status, providedContext) {
  const statuses = attemptToFixTaskToStatuses.get(task)
  if (statuses && statuses.length <= providedContext.testManagementAttemptToFixRetries) {
    statuses.push(status)
  }

  recordAttemptToFixExecution(attemptToFixExecutions, {
    testSuite: getTestSuitePath(task.file.filepath, process.cwd()),
    testName: getTestName(task),
    status,
    isDisabled: disabledTasks.has(task),
    isQuarantined: quarantinedTasks.has(task),
  })
}

function disableFrameworkRetries (task) {
  task.retry = 0
}

/**
 * Vitest accumulates retry and repeat errors on one task result. The first error added since
 * the last reported attempt is the primary error for the failed attempt currently being reported.
 *
 * @param {object} task
 * @param {Array<object> | undefined} errors
 * @returns {object | undefined}
 */
function getCurrentAttemptTestError (task, errors) {
  if (!errors?.length) return

  const previousErrorCount = taskToReportedErrorCount.get(task) ?? 0
  const testError = errors[previousErrorCount] ?? errors[0]
  taskToReportedErrorCount.set(task, errors.length)
  return testError
}

/**
 * Wraps a function so it runs inside the current test span context.
 * @param {object} task
 * @param {Function} fn
 * @returns {Function}
 */
function wrapTestScopedFn (task, fn) {
  return shimmer.wrapFunction(fn, fn => function (...args) {
    return testFnCh.runStores(taskToCtx.get(task), () => fn.apply(this, args))
  })
}

/**
 * Wraps a `beforeEach` cleanup callback so it inherits the test span context.
 * Vitest allows `beforeEach` to return a cleanup function, including via a promise.
 * @param {object} task
 * @param {unknown} result
 * @returns {unknown}
 */
function wrapBeforeEachCleanupResult (task, result) {
  if (typeof result === 'function') {
    return wrapTestScopedFn(task, result)
  }

  if (result && typeof result.then === 'function') {
    return result.then(cleanupFn => wrapBeforeEachCleanupResult(task, cleanupFn))
  }

  return result
}

function getWorkspaceProject (ctx) {
  return ctx.getCoreWorkspaceProject
    ? ctx.getCoreWorkspaceProject()
    : ctx.getRootProject()
}

function isVitestNoWorkerInitRequested () {
  // eslint-disable-next-line eslint-rules/eslint-process-env
  const value = process.env[VITEST_NO_WORKER_INIT_REQUEST_ENV]
  return value === 'true' || value === '1'
}

function shouldUseVitestNoWorkerInit (ctx, testSpecifications) {
  if (!isVitestNoWorkerInitRequested()) {
    return false
  }

  const config = ctx?.config
  if (!config) {
    return false
  }

  if (config.isolate === false) {
    warnVitestNoWorkerInitWithIsolationDisabled()
    return false
  }

  if (Array.isArray(testSpecifications)) {
    if (hasNonIsolatedForkPoolTestSpecification(testSpecifications, config.pool, config.isolate)) {
      warnVitestNoWorkerInitWithIsolationDisabled()
      return false
    }
    return hasIsolatedForkPoolTestSpecification(testSpecifications, config.pool, config.isolate)
  }

  return !isThreadPool(config.pool)
}

function warnVitestNoWorkerInitWithIsolationDisabled () {
  if (hasWarnedVitestNoWorkerInitWithIsolationDisabled) {
    return
  }

  hasWarnedVitestNoWorkerInitWithIsolationDisabled = true
  log.warn(VITEST_NO_WORKER_INIT_ISOLATE_WARNING)
}

function setProvidedContext (ctx, values, warningMessage) {
  try {
    Object.assign(getWorkspaceProject(ctx)._provided, values)
  } catch {
    log.warn(warningMessage)
  }
}

function getTestFilepathsFromSpecifications (testSpecifications) {
  if (!Array.isArray(testSpecifications) || !testSpecifications.length) {
    return
  }

  return testSpecifications.map(testSpecification => {
    const testFile = Array.isArray(testSpecification) ? testSpecification[1] : testSpecification
    return testFile?.moduleId || testFile?.filepath || testFile
  })
}

function getTestFilepaths (ctx, testSpecifications) {
  const testFilepaths = getTestFilepathsFromSpecifications(testSpecifications)
  if (testFilepaths) {
    return testFilepaths
  }

  const getFilePaths = ctx.getTestFilepaths || ctx._globTestFilepaths
  return getFilePaths.call(ctx)
}

function wrapCoverageProvider (ctx) {
  const { coverageProvider } = ctx
  if (!coverageProvider?.generateCoverage || coverageWrappedProviders.has(coverageProvider)) {
    return
  }
  coverageWrappedProviders.add(coverageProvider)

  // Capture coverage root directory from config (default is 'coverage' in cwd)
  try {
    const coverageConfig = ctx.config?.coverage
    const reportsDirectory = coverageConfig?.reportsDirectory || 'coverage'
    const rootDir = ctx.config?.root || process.cwd()
    coverageRootDir = path.isAbsolute(reportsDirectory) ? reportsDirectory : path.join(rootDir, reportsDirectory)
  } catch {
    // Fallback to cwd if we can't get config
    coverageRootDir = process.cwd()
  }

  shimmer.wrap(coverageProvider, 'generateCoverage', generateCoverage => async function () {
    const totalCodeCoverage = await generateCoverage.apply(this, arguments)

    try {
      testCodeCoverageLinesTotal = totalCodeCoverage.getCoverageSummary().lines.pct
    } catch {
      // ignore errors
    }
    return totalCodeCoverage
  })
}

function wrapSessionFinish (ctx) {
  if (finishWrappedContexts.has(ctx)) {
    return
  }
  finishWrappedContexts.add(ctx)

  shimmer.wrap(ctx, 'exit', getFinishWrapper)
  shimmer.wrap(ctx, 'close', getFinishWrapper)
}

async function runMainProcessSetup (ctx, frameworkVersion, testSpecifications) {
  if (!testSessionFinishCh.hasSubscribers) {
    return
  }

  let testSessionConfiguration
  let knownTests
  let testManagementTests
  let modifiedFiles
  testOptimizationRequestErrorTags = {}

  try {
    const { err, libraryConfig, requestErrorTags = {} } =
      await getChannelPromise(libraryConfigurationCh, frameworkVersion)
    testOptimizationRequestErrorTags = requestErrorTags
    if (err) {
      addTestOptimizationRequestErrorTag(DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS)
    } else {
      isFlakyTestRetriesEnabled = libraryConfig.isFlakyTestRetriesEnabled
      flakyTestRetriesCount = libraryConfig.flakyTestRetriesCount
      isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
      earlyFlakeDetectionNumRetries = libraryConfig.earlyFlakeDetectionNumRetries
      earlyFlakeDetectionSlowTestRetries = libraryConfig.earlyFlakeDetectionSlowTestRetries ?? {}
      isDiEnabled = libraryConfig.isDiEnabled
      isKnownTestsEnabled = libraryConfig.isKnownTestsEnabled
      isTestManagementTestsEnabled = libraryConfig.isTestManagementEnabled
      testManagementAttemptToFixRetries = libraryConfig.testManagementAttemptToFixRetries
      isImpactedTestsEnabled = libraryConfig.isImpactedTestsEnabled
    }
  } catch {
    isFlakyTestRetriesEnabled = false
    isEarlyFlakeDetectionEnabled = false
    isDiEnabled = false
    isKnownTestsEnabled = false
    isImpactedTestsEnabled = false
  }

  const shouldInstallNoWorkerInit = shouldUseVitestNoWorkerInit(ctx, testSpecifications)
  isVitestNoWorkerInitActive = shouldInstallNoWorkerInit
  const shouldSendWorkerInstrumentationContext = !shouldInstallNoWorkerInit ||
    hasThreadPoolTestSpecification(ctx.config?.pool, testSpecifications)

  if (testSessionConfigurationCh.hasSubscribers) {
    testSessionConfiguration = await getChannelPromise(
      testSessionConfigurationCh,
      frameworkVersion
    )
    const { testSessionId, testModuleId, testCommand, repositoryRoot, codeOwnersEntries } = testSessionConfiguration
    if (shouldSendWorkerInstrumentationContext) {
      setProvidedContext(ctx, {
        _ddTestSessionId: testSessionId,
        _ddTestModuleId: testModuleId,
        _ddTestCommand: testCommand,
        _ddRepositoryRoot: repositoryRoot,
        _ddCodeOwnersEntries: codeOwnersEntries,
      }, 'Could not send test session configuration to workers.')
    }
  }

  const {
    knownTestsResponse,
    testManagementTestsResponse,
  } = await getTestOptimizationRequestResults({
    isKnownTestsEnabled,
    isTestManagementTestsEnabled,
    getKnownTests: () => getChannelPromise(knownTestsCh),
    getTestManagementTests: () => getChannelPromise(testManagementTestsCh),
  })

  const flakyTestRetriesConfiguration = configureFlakyTestRetries(ctx, testSpecifications)
  if (shouldSendWorkerInstrumentationContext && flakyTestRetriesConfiguration) {
    setProvidedContext(ctx, {
      _ddIsFlakyTestRetriesEnabled: isFlakyTestRetriesEnabled,
      _ddFlakyTestRetriesCount: flakyTestRetriesCount,
      _ddFlakyTestRetriesIncludesUnnamedProject: flakyTestRetriesConfiguration.includesUnnamedProject,
      _ddFlakyTestRetriesProjectNames: flakyTestRetriesConfiguration.projectNames,
    }, 'Could not send library configuration to workers.')
  }

  if (isKnownTestsEnabled) {
    const currentKnownTestsResponse = knownTestsResponse || await getChannelPromise(knownTestsCh)
    if (currentKnownTestsResponse.err) {
      isEarlyFlakeDetectionEnabled = false
      addTestOptimizationRequestErrorTag(DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS)
    } else {
      knownTests = currentKnownTestsResponse.knownTests
      const testFilepaths = await getTestFilepaths(ctx, testSpecifications)

      if (isValidKnownTests(knownTests)) {
        isEarlyFlakeDetectionFaultyCh.publish({
          knownTests: knownTests.vitest,
          testFilepaths,
          onDone: (isFaulty) => {
            isEarlyFlakeDetectionFaulty = isFaulty
          },
        })
        if (isEarlyFlakeDetectionFaulty) {
          isEarlyFlakeDetectionEnabled = false
          log.warn('New test detection is disabled because the number of new tests is too high.')
        } else if (shouldSendWorkerInstrumentationContext) {
          setProvidedContext(ctx, {
            _ddIsKnownTestsEnabled: isKnownTestsEnabled,
            _ddKnownTests: knownTests,
            _ddIsEarlyFlakeDetectionEnabled: isEarlyFlakeDetectionEnabled,
            _ddEarlyFlakeDetectionNumRetries:
              getConfiguredEfdRetryCount(earlyFlakeDetectionSlowTestRetries, earlyFlakeDetectionNumRetries),
            _ddEarlyFlakeDetectionSlowTestRetries: earlyFlakeDetectionSlowTestRetries,
          }, 'Could not send known tests to workers so Early Flake Detection will not work.')
        }
      } else {
        isEarlyFlakeDetectionFaulty = true
        isEarlyFlakeDetectionEnabled = false
      }
    }
  }

  if (shouldSendWorkerInstrumentationContext && isDiEnabled) {
    setProvidedContext(ctx, {
      _ddIsDiEnabled: isDiEnabled,
    }, 'Could not send Dynamic Instrumentation configuration to workers.')
  }

  if (isTestManagementTestsEnabled) {
    const { err, testManagementTests: receivedTestManagementTests } =
      testManagementTestsResponse || await getChannelPromise(testManagementTestsCh)
    if (err) {
      isTestManagementTestsEnabled = false
      addTestOptimizationRequestErrorTag(DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS)
      log.error('Could not get test management tests.')
    } else {
      testManagementTests = receivedTestManagementTests
      if (shouldSendWorkerInstrumentationContext) {
        setProvidedContext(ctx, {
          _ddIsTestManagementTestsEnabled: isTestManagementTestsEnabled,
          _ddTestManagementAttemptToFixRetries: testManagementAttemptToFixRetries,
          _ddTestManagementTests: receivedTestManagementTests,
        }, 'Could not send test management tests to workers so Test Management will not work.')
      }
    }
  }

  if (isImpactedTestsEnabled) {
    const modifiedFilesResponse = await getChannelPromise(modifiedFilesCh)
    const { err } = modifiedFilesResponse
    if (err) {
      log.error('Could not get modified tests.')
    } else {
      modifiedFiles = modifiedFilesResponse.modifiedFiles
      if (shouldSendWorkerInstrumentationContext) {
        setProvidedContext(ctx, {
          _ddIsImpactedTestsEnabled: isImpactedTestsEnabled,
          _ddModifiedFiles: modifiedFiles,
        }, 'Could not send modified tests to workers so Impacted Tests will not work.')
      }
    }
  }

  installMainProcessReporter(ctx, frameworkVersion, testSessionConfiguration, {
    flakyTestRetriesConfiguration,
    knownTests,
    testManagementTests,
    modifiedFiles,
  }, shouldInstallNoWorkerInit, testSpecifications)
  configureMainProcessExecutionHooks(ctx, testSessionConfiguration, {
    knownTests,
    modifiedFiles,
    testManagementTests,
  }, shouldInstallNoWorkerInit, testSpecifications)
  wrapCoverageProvider(ctx)
  wrapSessionFinish(ctx)
}

function addTestOptimizationRequestErrorTag (tag) {
  testOptimizationRequestErrorTags[tag] = 'true'
}

function configureMainProcessExecutionHooks (
  ctx,
  testSessionConfiguration = {},
  testOptimizationData = {},
  shouldInstallNoWorkerInit,
  testSpecifications
) {
  if (shouldInstallNoWorkerInit === undefined) {
    shouldInstallNoWorkerInit = shouldUseVitestNoWorkerInit(ctx, testSpecifications)
  }

  if (!shouldInstallNoWorkerInit) {
    return
  }

  const { knownTests, modifiedFiles, testManagementTests } = testOptimizationData
  const attemptToFixTests = testManagementTests && getMainProcessAttemptToFixTests(testManagementTests)
  const disabledTests = testManagementTests && getMainProcessDisabledTests(testManagementTests)
  const quarantinedTests = testManagementTests && getMainProcessQuarantinedTests(testManagementTests)
  const shouldConfigureEarlyFlakeDetection =
    isEarlyFlakeDetectionEnabled && knownTests?.vitest && !isEarlyFlakeDetectionFaulty

  const setupFile = path.join(__dirname, '..', '..', '..', 'ci', 'vitest-worker-setup.mjs')
  addSetupFileToVitestConfigs(ctx, setupFile, testSpecifications)
  setProvidedContext(ctx, {
    _ddVitestWorkerSetup: {
      attemptToFixRetries: testManagementAttemptToFixRetries,
      attemptToFixTests: attemptToFixTests || {},
      disabledTests: disabledTests || {},
      earlyFlakeDetectionRetries: getConfiguredEfdRetryCount(
        earlyFlakeDetectionSlowTestRetries,
        earlyFlakeDetectionNumRetries
      ),
      earlyFlakeDetectionSlowRetries: earlyFlakeDetectionSlowTestRetries,
      isEarlyFlakeDetectionEnabled: shouldConfigureEarlyFlakeDetection,
      knownTests: knownTests?.vitest || {},
      modifiedFiles: modifiedFiles || {},
      quarantinedTests: quarantinedTests || {},
      repositoryRoot: testSessionConfiguration.repositoryRoot || process.cwd(),
    },
  }, 'Could not send Vitest worker setup context, so no-worker execution changes will not work.')
}

function getVitestConfigs (ctx, testSpecifications) {
  const configs = new Set()

  if (Array.isArray(testSpecifications)) {
    const defaultPool = ctx.config?.pool
    let hasRootConfigForkSpecification = false
    for (const testSpecification of testSpecifications) {
      if (!isForkPool(getEffectiveTestSpecificationPool(testSpecification, defaultPool))) continue

      const config = safeConfig(getTestSpecificationProject(testSpecification))
      if (config) {
        configs.add(config)
      } else {
        hasRootConfigForkSpecification = true
      }
    }

    if (hasRootConfigForkSpecification) {
      addRootVitestConfigs(configs, ctx)
    }

    return configs
  }

  addRootVitestConfigs(configs, ctx)

  return configs
}

/**
 * Add root-level configs used when Vitest reports file-only test specifications.
 *
 * @param {Set<object|undefined>} configs
 * @param {object} ctx
 * @returns {void}
 */
function addRootVitestConfigs (configs, ctx) {
  configs.add(ctx.config)
  configs.add(safeWorkspaceProject(ctx)?.config)
}

function addSetupFileToVitestConfigs (ctx, setupFile, testSpecifications) {
  const configs = getVitestConfigs(ctx, testSpecifications)

  for (const config of configs) {
    if (!config) continue

    if (config.setupFiles === undefined) {
      config.setupFiles = []
    } else if (typeof config.setupFiles === 'string') {
      config.setupFiles = [config.setupFiles]
    }

    if (!config.setupFiles.includes(setupFile)) {
      config.setupFiles.push(setupFile)
    }
  }
}

function getMainProcessAttemptToFixTests (testManagementTests) {
  return getMainProcessTestManagementTests(testManagementTests, properties => properties.attempt_to_fix)
}

function getMainProcessDisabledTests (testManagementTests) {
  return getMainProcessTestManagementTests(testManagementTests, properties =>
    properties.disabled && !properties.attempt_to_fix
  )
}

function getMainProcessQuarantinedTests (testManagementTests) {
  return getMainProcessTestManagementTests(testManagementTests, properties =>
    properties.quarantined && !properties.attempt_to_fix
  )
}

function getMainProcessTestManagementTests (testManagementTests, predicate) {
  const suites = testManagementTests.vitest?.suites
  if (!suites) return

  const selectedTests = {}
  let hasSelectedTests = false

  for (const [testSuite, testSuiteData] of Object.entries(suites)) {
    const tests = testSuiteData.tests
    if (!tests) continue

    for (const [testName, testData] of Object.entries(tests)) {
      const properties = testData.properties
      if (!properties || !predicate(properties)) continue

      selectedTests[testSuite] ||= {}
      selectedTests[testSuite][testName] = true
      hasSelectedTests = true
    }
  }

  return hasSelectedTests ? selectedTests : undefined
}

function installMainProcessReporter (
  ctx,
  frameworkVersion,
  testSessionConfiguration,
  testOptimizationData,
  shouldInstallNoWorkerInit = shouldUseVitestNoWorkerInit(ctx),
  testSpecifications
) {
  const forkPoolTestModules = getForkPoolTestModules(ctx.config?.pool, testSpecifications)

  if (
    !shouldInstallNoWorkerInit ||
    forkPoolTestModules?.isEmpty ||
    mainProcessReporterContexts.has(ctx)
  ) {
    return
  }
  mainProcessReporterContexts.add(ctx)
  ctx.reporters.push(createMainProcessReporter(
    frameworkVersion,
    testSessionConfiguration,
    testOptimizationData,
    forkPoolTestModules
  ))
}

function createMainProcessReporter (
  frameworkVersion,
  testSessionConfiguration = {},
  testOptimizationData = {},
  forkPoolTestModules
) {
  const testSuiteContexts = new Map()
  const finishedTestModules = new Set()
  const taskAttemptStatuses = new Map()

  return {
    onTestModuleStart (testModule) {
      if (!shouldReportTestModule(testModule)) return

      startTestSuite(testModule)
    },

    onTestModuleEnd (testModule) {
      if (!shouldReportTestModule(testModule)) return

      return reportTestModule(testModule)
    },

    onTestCaseResult (testCase) {
      const task = getTestCaseTask(testCase)
      if (!shouldReportTestTask(task)) return

      recordFinalTaskAttemptResult(task)
    },

    onTaskUpdate (packs, events) {
      if (!events) return

      for (const event of events) {
        if (event[1] === 'test-retried') {
          recordTaskAttemptStatus(event[0], 'fail')
        }
      }
    },

    onFinished (files) {
      if (!files) return
      for (const file of files) {
        const testModule = createTestModuleFromFile(file)
        if (!shouldReportTestModule(testModule)) continue

        if (!finishedTestModules.has(file.id)) {
          reportTestModule(testModule)
        }
      }
    },
  }

  function shouldReportTestModule (testModule) {
    if (!forkPoolTestModules) return true

    const filepath = getTestModuleFilepath(testModule)
    const normalizedFilepath = normalizeFilepath(filepath)
    if (!normalizedFilepath) return false

    const projectName = getTestModuleProjectName(testModule)
    if (projectName) {
      return forkPoolTestModules.projectFilepaths.has(getProjectFilepathKey(projectName, normalizedFilepath))
    }
    return forkPoolTestModules.filepaths.has(normalizedFilepath)
  }

  function shouldReportTestTask (task) {
    if (!forkPoolTestModules) return true

    const file = task.file
    if (!file) return false

    return shouldReportTestModule({
      moduleId: file.filepath,
      projectName: file.projectName,
      task: file,
    })
  }

  function recordTaskAttemptStatus (taskId, status) {
    let statuses = taskAttemptStatuses.get(taskId)
    if (!statuses) {
      statuses = []
      taskAttemptStatuses.set(taskId, statuses)
    }
    statuses.push(status)
  }

  function recordFinalTaskAttemptResult (task) {
    const statuses = taskAttemptStatuses.get(task.id)
    if (!statuses) return

    const attemptCount = getRepeatedAttemptCount(task, statuses)
    if (statuses.length < attemptCount) {
      statuses.push('pass')
    }
  }

  function reportTestModule (testModule) {
    const testModuleId = getTestModuleId(testModule)
    const testModuleTask = getTestModuleTask(testModule)
    finishedTestModules.add(testModuleId)
    const testSuiteCtx = testSuiteContexts.get(testModuleId) || startTestSuite(testModule)
    const testTasks = getTypeTasks(testModuleTask.tasks)
    const testReports = []
    let testSuiteError

    for (const task of testTasks) {
      const testReport = getTestReport(task, testSuiteCtx.currentStore)
      testReports.push(testReport)

      for (const attempt of testReport.nonFinalAttempts) {
        reportTestAttempt(testReport, attempt)
      }
    }

    for (const testReport of testReports) {
      const error = reportFinalTestAttempt(testReport)
      testSuiteError ||= error
    }

    const suiteTaskError = getSuiteTaskError(testModuleTask)
    recomputeTaskState(testModuleTask)
    const testSuiteResult = testModuleTask.result
    if (testSuiteResult?.errors?.length) {
      testSuiteError = testSuiteResult.errors[0]
    } else if (suiteTaskError) {
      testSuiteError = suiteTaskError
    }

    if (testSuiteError) {
      testSuiteCtx.error = testSuiteError
      testSuiteErrorCh.runStores(testSuiteCtx, () => {})
    }

    testSuiteFinishCh.publish({
      status: getDatadogStatus(testSuiteResult),
      deferFlush: true,
      onFinish: noop,
      ...testSuiteCtx.currentStore,
    })
    testSuiteContexts.delete(testModuleId)
  }

  function startTestSuite (testModule) {
    const testModuleId = getTestModuleId(testModule)
    const testSuiteCtx = {
      testSuiteAbsolutePath: getTestModuleFilepath(testModule),
      frameworkVersion,
      testSessionId: testSessionConfiguration.testSessionId,
      testModuleId: testSessionConfiguration.testModuleId,
      testCommand: testSessionConfiguration.testCommand,
      repositoryRoot: testSessionConfiguration.repositoryRoot,
      codeOwnersEntries: testSessionConfiguration.codeOwnersEntries,
      isTestFrameworkWorker: true,
      requestErrorTags: testOptimizationRequestErrorTags,
    }
    testSuiteStartCh.runStores(testSuiteCtx, () => {})
    testSuiteContexts.set(testModuleId, testSuiteCtx)
    return testSuiteCtx
  }

  function getTestReport (task, testSuiteStore) {
    const result = task.result
    const testSuiteAbsolutePath = task.file?.filepath
    const testName = getTestName(task)
    const testProperties = getMainProcessTestProperties(task, testSuiteAbsolutePath, testName)
    let status = getDatadogStatus(result)

    if (task.meta?.__ddTestOptQuarantinedFailed && testProperties.isQuarantined && !testProperties.isAttemptToFix) {
      status = 'fail'
    }

    if (testProperties.isAttemptToFix && task.meta?.__ddTestOptAtfStatuses?.length) {
      return getRepeatedTestReport(task, testName, testSuiteAbsolutePath, testProperties, status, {
        errorCounts: task.meta.__ddTestOptAtfErrorCounts,
        finalStatus: getAttemptToFixFinalStatus,
        statuses: task.meta.__ddTestOptAtfStatuses,
        testSuiteStore,
        type: 'attempt_to_fix',
      })
    }

    if (testProperties.isEarlyFlakeDetection && task.meta?.__ddTestOptEfdStatuses?.length) {
      return getRepeatedTestReport(task, testName, testSuiteAbsolutePath, testProperties, status, {
        errorCounts: task.meta.__ddTestOptEfdErrorCounts,
        finalStatus: getEarlyFlakeDetectionFinalStatus,
        statuses: task.meta.__ddTestOptEfdStatuses,
        testSuiteStore,
        type: 'early_flake_detection',
      })
    }

    if (!testProperties.isAttemptToFix && task.meta?.__ddTestOptRepeatStatuses?.length) {
      return getRepeatedTestReport(task, testName, testSuiteAbsolutePath, testProperties, status, {
        errorCounts: task.meta.__ddTestOptRepeatErrorCounts,
        finalStatus: () => status,
        statuses: task.meta.__ddTestOptRepeatStatuses,
        testSuiteStore,
        type: 'external',
      })
    }

    const attemptStatuses = taskAttemptStatuses.get(task.id)
    if (!testProperties.isAttemptToFix && !testProperties.isEarlyFlakeDetection && attemptStatuses?.length > 1) {
      return getRepeatedTestReport(task, testName, testSuiteAbsolutePath, testProperties, status, {
        finalStatus: () => status,
        statuses: attemptStatuses,
        testSuiteStore,
        type: 'external',
      })
    }

    if (!testProperties.isAttemptToFix && task.result?.repeatCount > 0) {
      return getRepeatedTestReport(task, testName, testSuiteAbsolutePath, testProperties, status, {
        finalStatus: () => status,
        statuses: getRepeatedTaskStatuses(task, status),
        testSuiteStore,
        type: 'external',
      })
    }

    if (testProperties.isAttemptToFix) {
      logAttemptToFixTestExecution(testProperties.testSuite, testName, loggedAttemptToFixTests)
    }

    if (testProperties.isDisabled && !testProperties.isAttemptToFix) {
      status = 'skip'
      if (result) result.state = 'skip'
    } else if (testProperties.isQuarantined && status === 'fail' && !testProperties.isAttemptToFix) {
      result.state = 'pass'
    }

    const errors = result?.errors || []
    const finalErrorIndex = status === 'fail' ? errors.length - 1 : -1
    const nonFinalAttempts = []

    if (status !== 'skip') {
      for (let index = 0; index < errors.length; index++) {
        if (index === finalErrorIndex) continue
        nonFinalAttempts.push({
          error: errors[index],
          isRetry: index > 0,
          status: 'fail',
        })
      }
    }

    return {
      errors,
      nonFinalAttempts,
      status,
      task,
      testName,
      testProperties,
      testSuiteAbsolutePath,
      testSuiteStore,
    }
  }

  function getMainProcessTestProperties (task, testSuiteAbsolutePath, testName) {
    const testSuite = getTestSuitePath(
      testSuiteAbsolutePath,
      testSessionConfiguration.repositoryRoot || process.cwd()
    )
    const knownTests = testOptimizationData.knownTests?.vitest
    const testsForThisTestSuite = knownTests?.[testSuite] || []
    const isNew = !!(
      isKnownTestsEnabled &&
      knownTests &&
      !isEarlyFlakeDetectionFaulty &&
      !testsForThisTestSuite.includes(testName)
    )
    const testManagementProperties =
      testOptimizationData.testManagementTests?.vitest?.suites?.[testSuite]?.tests?.[testName]?.properties || {}
    const isModified = !!(isImpactedTestsEnabled && testOptimizationData.modifiedFiles &&
      isModifiedTest(testSuite, 0, 0, testOptimizationData.modifiedFiles, 'vitest'))
    const { flakyTestRetriesConfiguration } = testOptimizationData
    const isFlakyTestRetries = !!flakyTestRetriesConfiguration && isFlakyTestRetriesEnabledForTask({
      isFlakyTestRetriesEnabled,
      flakyTestRetriesIncludesUnnamedProject: flakyTestRetriesConfiguration.includesUnnamedProject,
      flakyTestRetriesProjectNames: flakyTestRetriesConfiguration.projectNames,
    }, task)

    return {
      isAttemptToFix: testManagementProperties.attempt_to_fix,
      isDisabled: testManagementProperties.disabled,
      isEarlyFlakeDetection: (isNew || isModified) && isEarlyFlakeDetectionEnabled,
      isFlakyTestRetries,
      isQuarantined: testManagementProperties.quarantined,
      isModified,
      isNew,
      testSuite,
      hasDynamicName: isNew && DYNAMIC_NAME_RE.test(testName),
    }
  }
}

function createTestModuleFromFile (file) {
  return {
    id: file.id,
    moduleId: file.filepath,
    task: file,
  }
}

function getTestModuleId (testModule) {
  return testModule.id || getTestModuleFilepath(testModule)
}

function getTestModuleTask (testModule) {
  if (testModule.task?.tasks) {
    return testModule.task
  }

  const task = createTaskFromReportedTask(testModule)
  task.file = task
  return task
}

function getTestCaseTask (testCase) {
  if (testCase.task) {
    return testCase.task
  }

  return createTaskFromReportedTask(testCase, {
    filepath: getTestModuleFilepath(testCase.module),
    projectName: getTestModuleProjectName(testCase.module),
  })
}

function createTaskFromReportedTask (reportedTask, file, suite) {
  const task = {
    id: reportedTask.id,
    type: reportedTask.type,
    name: reportedTask.name || reportedTask.relativeModuleId || reportedTask.moduleId,
    mode: reportedTask.options?.mode,
    meta: getReportedTaskMeta(reportedTask),
    result: getReportedTaskResult(reportedTask),
    file,
    suite,
  }

  if (reportedTask.type === 'module') {
    task.filepath = reportedTask.moduleId
    task.projectName = getTestModuleProjectName(reportedTask)
  }

  const children = getReportedTaskChildren(reportedTask)
  if (children) {
    task.tasks = []
    const taskFile = file || task
    const childSuite = task.type === 'suite' ? task : undefined
    for (const child of children) {
      task.tasks.push(createTaskFromReportedTask(child, taskFile, childSuite))
    }
  }

  return task
}

function getReportedTaskChildren (reportedTask) {
  const children = reportedTask.children
  if (!children) return

  if (typeof children.array === 'function') {
    return children.array()
  }

  if (Array.isArray(children)) {
    return children
  }

  return [...children]
}

function getReportedTaskMeta (reportedTask) {
  if (typeof reportedTask.meta === 'function') {
    return reportedTask.meta()
  }

  return reportedTask.meta || {}
}

function getReportedTaskResult (reportedTask) {
  let result
  if (typeof reportedTask.result === 'function') {
    result = reportedTask.result()
  } else if (typeof reportedTask.state === 'function') {
    result = {
      errors: typeof reportedTask.errors === 'function' ? reportedTask.errors() : undefined,
      state: reportedTask.state(),
    }
  } else {
    result = reportedTask.result
  }

  const diagnostic = typeof reportedTask.diagnostic === 'function'
    ? reportedTask.diagnostic()
    : undefined

  return {
    duration: diagnostic?.duration,
    errors: result?.errors,
    note: result?.note,
    repeatCount: diagnostic?.repeatCount,
    retryCount: diagnostic?.retryCount,
    state: result?.state,
  }
}

function getTestModuleFilepath (testModule) {
  return testModule.moduleId || testModule.task?.filepath || testModule.filepath
}

function getTestModuleProjectName (testModule) {
  return normalizeProjectName(
    testModule.projectName || getProjectName(testModule.project) || testModule.task?.projectName ||
      testModule.task?.file?.projectName
  )
}

function getRepeatedTestReport (task, testName, testSuiteAbsolutePath, testProperties, status, options) {
  const result = task.result
  const errors = result?.errors || []
  const { errorCounts, finalStatus, statuses, testSuiteStore, type } = options
  const finalAttemptStatus = finalStatus(statuses)
  const hasFailure = finalAttemptStatus === 'fail'
  const attempts = []
  const attemptCount = getRepeatedAttemptCount(task, statuses)
  let errorIndex = 0
  let previousErrorCount = 0

  if (type === 'attempt_to_fix') {
    logAttemptToFixTestExecution(testProperties.testSuite, testName, loggedAttemptToFixTests)
  }

  for (let index = 0; index < attemptCount; index++) {
    const isFinalAttempt = index === attemptCount - 1
    const attemptStatus = statuses[index] || 'pass'
    const nextErrorCount = errorCounts?.[index]
    const error = attemptStatus === 'fail' ? errors[previousErrorCount] || errors[errorIndex] || errors[0] : undefined
    if (nextErrorCount !== undefined) {
      previousErrorCount = nextErrorCount
    } else if (attemptStatus === 'fail') {
      errorIndex++
    }
    const attempt = {
      attemptToFixFailed: isFinalAttempt && hasFailure,
      earlyFlakeAbortReason: type === 'early_flake_detection' && isFinalAttempt
        ? task.meta?.__ddTestOptEfdAbortReason
        : undefined,
      error,
      finalStatus: isFinalAttempt ? finalAttemptStatus : undefined,
      hasFailedAllRetries: isFinalAttempt && hasFailure && statuses.every(status => status === 'fail'),
      isRetry: index > 0,
      status: attemptStatus,
    }
    if (type === 'attempt_to_fix') {
      attempt.attemptToFixPassed = isFinalAttempt && !hasFailure
    } else if (type === 'early_flake_detection') {
      attempt.isRetryReasonEfd = index > 0
    }
    attempts.push(attempt)
  }

  return {
    errors,
    finalAttempt: attempts[attempts.length - 1],
    nonFinalAttempts: attempts.slice(0, -1),
    status,
    task,
    testName,
    testProperties,
    testSuiteAbsolutePath,
    testSuiteStore,
  }
}

function getRepeatedAttemptCount (task, statuses) {
  const retries = task.meta?.__ddTestOptAtfRetries ?? task.meta?.__ddTestOptEfdRetries ?? task.repeats ?? 0
  return Math.max(statuses.length, retries + 1)
}

function getAttemptToFixFinalStatus (statuses) {
  return statuses.includes('fail') ? 'fail' : 'pass'
}

function getEarlyFlakeDetectionFinalStatus (statuses) {
  return statuses.includes('pass') ? 'pass' : 'fail'
}

function getRepeatedTaskStatuses (task, status) {
  const repeatedStatuses = []
  const repeatCount = task.result?.repeatCount || 0
  for (let index = 0; index <= repeatCount; index++) {
    repeatedStatuses.push(status)
  }
  return repeatedStatuses
}

function reportFinalTestAttempt (testReport) {
  const {
    errors,
    status,
    task,
    testName,
    testProperties,
    testSuiteAbsolutePath,
    testSuiteStore,
  } = testReport

  if (status === 'skip') {
    testSkipCh.publish({
      testName,
      testSuiteAbsolutePath,
      isNew: testProperties.isNew,
      isDisabled: testProperties.isDisabled,
      isTestFrameworkWorker: true,
      ...testSuiteStore,
    })
    return
  }

  const result = task.result
  const finalStatus = getFinalTestStatus(testReport)
  const finalAttempt = testReport.finalAttempt

  if (status === 'fail') {
    const error = errors[errors.length - 1] || errors[0]
    reportTestAttempt(testReport, finalAttempt || {
      error,
      finalStatus,
      hasFailedAllRetries: (result?.retryCount || 0) > 0,
      isRetry: errors.length > 1 || (result?.retryCount || 0) > 0 || (result?.repeatCount || 0) > 0,
      status: 'fail',
    })
    return error
  }

  reportTestAttempt(testReport, finalAttempt || {
    finalStatus,
    isRetry: errors.length > 0 || (result?.retryCount || 0) > 0 || (result?.repeatCount || 0) > 0,
    status: 'pass',
  })
}

function reportTestAttempt (testReport, attempt) {
  const {
    task,
    testName,
    testProperties,
    testSuiteAbsolutePath,
    testSuiteStore,
  } = testReport
  const result = task.result
  const status = attempt.status
  const testCtx = {
    currentStore: testSuiteStore,
    testName,
    testSuiteAbsolutePath,
    isRetry: attempt.isRetry,
    isNew: testProperties.isNew,
    hasDynamicName: testProperties.hasDynamicName,
    isAttemptToFix: testProperties.isAttemptToFix,
    isDisabled: testProperties.isDisabled,
    isQuarantined: testProperties.isQuarantined,
    isModified: testProperties.isModified,
    isRetryReasonEfd: attempt.isRetryReasonEfd,
    isRetryReasonAttemptToFix: testProperties.isAttemptToFix && attempt.isRetry,
    isRetryReasonAtr: !testProperties.isAttemptToFix && !testProperties.isEarlyFlakeDetection &&
      testProperties.isFlakyTestRetries,
    isTestFrameworkWorker: true,
    requestErrorTags: testOptimizationRequestErrorTags,
  }
  if (testProperties.isAttemptToFix) {
    recordAttemptToFixExecution(attemptToFixExecutions, {
      testSuite: testProperties.testSuite,
      testName,
      status,
      isDisabled: testProperties.isDisabled,
      isQuarantined: testProperties.isQuarantined,
    })
  }
  if (testProperties.hasDynamicName) {
    newTestsWithDynamicNames.add(`${testProperties.testSuite} › ${testName}`)
  }
  if (attempt.attemptToFixPassed) {
    testCtx.attemptToFixPassed = true
  } else if (attempt.attemptToFixFailed) {
    testCtx.attemptToFixFailed = true
  }
  testStartCh.runStores(testCtx, () => {})
  testCtx.status = status
  testCtx.task = task
  testFinishTimeCh.runStores(testCtx, () => {})

  if (status === 'pass') {
    testPassCh.publish({
      task,
      earlyFlakeAbortReason: attempt.earlyFlakeAbortReason,
      finalStatus: attempt.finalStatus,
      ...testCtx.currentStore,
    })
    return
  }

  testErrorCh.publish({
    duration: attempt.isRetry ? undefined : result?.duration,
    error: attempt.error,
    earlyFlakeAbortReason: attempt.earlyFlakeAbortReason,
    finalStatus: attempt.finalStatus,
    hasFailedAllRetries: attempt.hasFailedAllRetries,
    attemptToFixFailed: attempt.attemptToFixFailed,
    ...testCtx.currentStore,
  })
}

function getFinalTestStatus (testReport) {
  const testProperties = testReport.testProperties
  if (testProperties.isAttemptToFix) {
    const finalAttempt = testReport.finalAttempt
    return finalAttempt?.finalStatus
  }
  if (testProperties.isDisabled || testProperties.isQuarantined) {
    return 'skip'
  }
  return testReport.status
}

function getDatadogStatus (result) {
  const state = result?.state
  if (state === 'pass' || state === 'passed') return 'pass'
  if (state === 'fail' || state === 'failed') return 'fail'
  return 'skip'
}

function getSuiteTaskError (task) {
  const suiteTasks = getTypeTasks(task.tasks || [], 'suite')
  for (const suiteTask of suiteTasks) {
    if (suiteTask.result?.state === 'fail' && suiteTask.result?.errors?.length) {
      return suiteTask.result.errors[0]
    }
  }
}

function recomputeTaskState (task) {
  if (!task.tasks) {
    return getDatadogStatus(task.result)
  }

  const hasErrors = task.result?.errors?.length > 0
  let hasFailed = false
  let hasPassed = false

  for (const child of task.tasks) {
    const childStatus = recomputeTaskState(child)
    hasFailed ||= childStatus === 'fail'
    hasPassed ||= childStatus === 'pass'
  }

  const status = hasErrors || hasFailed ? 'fail' : hasPassed ? 'pass' : 'skip'
  task.result ||= {}
  task.result.state = status
  return status
}

function ensureMainProcessSetup (ctx, frameworkVersion, testSpecifications) {
  let setupPromise = mainProcessSetupPromises.get(ctx)
  if (!setupPromise) {
    setupPromise = runMainProcessSetup(ctx, frameworkVersion, testSpecifications)
    mainProcessSetupPromises.set(ctx, setupPromise)
  }
  return setupPromise
}

/**
 * Configure Vitest retries for the root project and resolved workspace projects.
 *
 * @param {object} ctx
 * @param {unknown[]|undefined} testSpecifications
 * @returns {{ projectNames: string[], includesUnnamedProject: boolean }|undefined}
 */
function configureFlakyTestRetries (ctx, testSpecifications) {
  if (!isFlakyTestRetriesEnabled || flakyTestRetriesCount <= 0) return

  let configured = false
  let includesUnnamedProject = false
  const projectNames = []
  for (const { config, projectName } of getVitestProjectConfigs(ctx, testSpecifications)) {
    if (!config.retry) {
      config.retry = flakyTestRetriesCount
      configured = true
      if (projectName) {
        projectNames.push(projectName)
      } else {
        includesUnnamedProject = true
      }
    }
  }

  if (!configured) return

  return {
    includesUnnamedProject,
    projectNames,
  }
}

/**
 * Return unique Vitest configs that can be used to run tests.
 *
 * @param {object} ctx
 * @param {unknown[]|undefined} testSpecifications
 * @returns {{ config: object, projectName?: string }[]}
 */
function getVitestProjectConfigs (ctx, testSpecifications) {
  const entries = []

  addTestSpecificationConfigs(entries, testSpecifications)
  if (entries.length > 0) {
    return entries
  }

  const selectedProjectNames = getSelectedProjectNames()
  addSelectedInlineProjectConfigs(entries, safeConfig(ctx), selectedProjectNames)
  addSelectedRuntimeProjectConfigs(entries, ctx?.projects, selectedProjectNames)
  if (entries.length > 0) {
    return entries
  }

  if (Array.isArray(ctx?.projects)) {
    for (const project of ctx.projects) {
      addConfig(entries, safeConfig(project), getProjectName(project))
    }
    if (entries.length > 0) {
      return entries
    }
  }

  addConfig(entries, safeConfig(ctx))
  addConfig(entries, safeConfig(safeWorkspaceProject(ctx)))

  return entries
}

/**
 * Add configs from runnable test specifications once.
 *
 * @param {{ config: object, projectName?: string }[]} entries
 * @param {unknown[]|undefined} testSpecifications
 */
function addTestSpecificationConfigs (entries, testSpecifications) {
  if (!Array.isArray(testSpecifications)) return

  for (const testSpecification of testSpecifications) {
    const project = getTestSpecificationProject(testSpecification)
    addConfig(entries, safeConfig(project), getProjectName(project))
  }
}

/**
 * Add selected inline project configs from the root Vitest config once.
 *
 * @param {{ config: object, projectName?: string }[]} entries
 * @param {object|undefined} rootConfig
 * @param {string[]} selectedProjectNames
 */
function addSelectedInlineProjectConfigs (entries, rootConfig, selectedProjectNames) {
  if (selectedProjectNames.length === 0 || !Array.isArray(rootConfig?.projects)) return

  for (const project of rootConfig.projects) {
    const config = getInlineProjectConfig(project)
    const projectName = getProjectName(project)
    if (selectedProjectNames.includes(projectName)) {
      addConfig(entries, config, projectName)
    }
  }
}

/**
 * Add selected resolved project configs once.
 *
 * @param {{ config: object, projectName?: string }[]} entries
 * @param {unknown[]|undefined} projects
 * @param {string[]} selectedProjectNames
 */
function addSelectedRuntimeProjectConfigs (entries, projects, selectedProjectNames) {
  if (selectedProjectNames.length === 0 || !Array.isArray(projects)) return

  for (const project of projects) {
    const projectName = getProjectName(project)
    if (selectedProjectNames.includes(projectName)) {
      addConfig(entries, safeConfig(project), projectName)
    }
  }
}

/**
 * Return selected project names from the Vitest CLI arguments.
 *
 * @returns {string[]}
 */
function getSelectedProjectNames () {
  const names = []
  for (let index = 0; index < process.argv.length; index++) {
    const argument = process.argv[index]
    if (argument === '--project' && process.argv[index + 1]) {
      names.push(process.argv[index + 1])
      index++
    } else if (argument.startsWith('--project=')) {
      names.push(argument.slice('--project='.length))
    }
  }
  return names
}

/**
 * Return the test config from an inline Vitest project entry.
 *
 * @param {unknown} project
 * @returns {object|undefined}
 */
function getInlineProjectConfig (project) {
  return project?.test || project
}

/**
 * Return a Vitest project name from runtime or inline project objects.
 *
 * @param {unknown} project
 * @returns {string|undefined}
 */
function getProjectName (project) {
  return normalizeProjectName(project?.name || project?.config?.name || project?.test?.name)
}

/**
 * Return a normalized Vitest project name.
 *
 * @param {unknown} name
 * @returns {string|undefined}
 */
function normalizeProjectName (name) {
  if (typeof name === 'string') return name

  const label = name?.label
  return typeof label === 'string' ? label : undefined
}

/**
 * Add a config object once.
 *
 * @param {{ config: object, projectName?: string }[]} entries
 * @param {object|undefined} config
 * @param {string|undefined} projectName
 */
function addConfig (entries, config, projectName) {
  if (config && !entries.some(entry => entry.config === config || (projectName && entry.projectName === projectName))) {
    entries.push({ config, projectName })
  }
}

/**
 * Read a Vitest config object without assuming the project is initialized.
 *
 * @param {object|undefined} project
 * @returns {object|undefined}
 */
function safeConfig (project) {
  let config
  try {
    config = project?.config
  } catch {}
  return config
}

/**
 * Read the workspace project without assuming the root server is initialized.
 *
 * @param {object} ctx
 * @returns {object|undefined}
 */
function safeWorkspaceProject (ctx) {
  let project
  try {
    project = getWorkspaceProject(ctx)
  } catch {}
  return project
}

/**
 * Return whether Datadog configured ATR retries for a task.
 *
 * @param {object} providedContext
 * @param {object} task
 * @returns {boolean}
 */
function isFlakyTestRetriesEnabledForTask (providedContext, task) {
  if (!providedContext.isFlakyTestRetriesEnabled) return false

  const { flakyTestRetriesProjectNames } = providedContext
  if (!Array.isArray(flakyTestRetriesProjectNames)) return true

  const projectName = task.file?.projectName
  if (!projectName) {
    return providedContext.flakyTestRetriesIncludesUnnamedProject === true
  }

  return flakyTestRetriesProjectNames.includes(projectName)
}

function getSortWrapper (sort, frameworkVersion) {
  return async function () {
    await ensureMainProcessSetup(this.ctx, frameworkVersion, arguments[0])
    return sort.apply(this, arguments)
  }
}

function getFinishWrapper (exitOrClose) {
  let isClosed = false
  return async function () {
    if (isClosed) { // needed because exit calls close
      return exitOrClose.apply(this, arguments)
    }
    isClosed = true

    if (!testSessionFinishCh.hasSubscribers) {
      return exitOrClose.apply(this, arguments)
    }

    let onFinish

    const flushPromise = new Promise(resolve => {
      onFinish = resolve
    })
    const failedSuites = this.state.getFailedFilepaths()
    let error
    if (failedSuites.length) {
      error = new Error(`Test suites failed: ${failedSuites.length}.`)
    }

    testSessionFinishCh.publish({
      status: getSessionStatus(this.state),
      testCodeCoverageLinesTotal,
      error,
      isEarlyFlakeDetectionEnabled,
      isEarlyFlakeDetectionFaulty,
      isTestManagementTestsEnabled,
      requestErrorTags: testOptimizationRequestErrorTags,
      vitestPool,
      onFinish,
    })

    logTestOptimizationSummary({ attemptToFixExecutions, newTestsWithDynamicNames })
    loggedAttemptToFixTests.clear()

    await flushPromise

    // If coverage was generated, publish coverage report channel for upload
    if (coverageRootDir && codeCoverageReportCh.hasSubscribers) {
      await new Promise((resolve) => {
        codeCoverageReportCh.publish({ rootDir: coverageRootDir, onDone: resolve })
      })
    }

    return exitOrClose.apply(this, arguments)
  }
}

function getCliOrStartVitestWrapper (frameworkVersion) {
  return function (oldCliOrStartVitest) {
    return function (...args) {
      if (!testSessionStartCh.hasSubscribers || isSessionStarted) {
        return oldCliOrStartVitest.apply(this, args)
      }
      isSessionStarted = true
      testSessionStartCh.publish({ command: getTestCommand(), frameworkVersion })
      return oldCliOrStartVitest.apply(this, args)
    }
  }
}

function isForkPool (pool) {
  return pool === 'forks' || pool === 'vmForks'
}

function isThreadPool (pool) {
  return pool === 'threads' || pool === 'vmThreads'
}

function normalizeFilepath (filepath) {
  return typeof filepath === 'string' ? filepath.replaceAll('\\', '/') : undefined
}

/**
 * Return the project object attached to a Vitest test specification.
 *
 * @param {unknown} testSpecification
 * @returns {object|undefined}
 */
function getTestSpecificationProject (testSpecification) {
  if (Array.isArray(testSpecification)) {
    return testSpecification[0]
  }
  return testSpecification?.project
}

function getTestSpecificationPool (testSpecification) {
  const project = getTestSpecificationProject(testSpecification)
  return project?.config?.pool || project?.serializedConfig?.pool || project?.pool || testSpecification?.pool
}

function getEffectiveTestSpecificationPool (testSpecification, defaultPool) {
  return getTestSpecificationPool(testSpecification) || defaultPool
}

function getTestSpecificationIsolate (testSpecification) {
  const project = getTestSpecificationProject(testSpecification)
  return project?.config?.isolate ?? project?.serializedConfig?.isolate ?? project?.isolate ??
    testSpecification?.isolate
}

function getEffectiveTestSpecificationIsolate (testSpecification, defaultIsolate) {
  const isolate = getTestSpecificationIsolate(testSpecification)
  return isolate === undefined ? defaultIsolate : isolate
}

function getTestSpecificationFilepath (testSpecification) {
  const testFile = Array.isArray(testSpecification) ? testSpecification[1] : testSpecification
  return testFile?.moduleId || testFile?.filepath || testFile
}

function getTestSpecificationProjectName (testSpecification) {
  return getProjectName(getTestSpecificationProject(testSpecification))
}

function hasForkPoolTestSpecification (testSpecifications, defaultPool) {
  if (!Array.isArray(testSpecifications)) {
    return false
  }

  for (const testSpecification of testSpecifications) {
    if (isForkPool(getEffectiveTestSpecificationPool(testSpecification, defaultPool))) {
      return true
    }
  }

  return false
}

function hasIsolatedForkPoolTestSpecification (testSpecifications, defaultPool, defaultIsolate) {
  if (!Array.isArray(testSpecifications)) {
    return false
  }

  for (const testSpecification of testSpecifications) {
    if (
      isForkPool(getEffectiveTestSpecificationPool(testSpecification, defaultPool)) &&
      getEffectiveTestSpecificationIsolate(testSpecification, defaultIsolate) !== false
    ) {
      return true
    }
  }

  return false
}

function hasNonIsolatedForkPoolTestSpecification (testSpecifications, defaultPool, defaultIsolate) {
  if (!Array.isArray(testSpecifications)) {
    return false
  }

  for (const testSpecification of testSpecifications) {
    if (
      isForkPool(getEffectiveTestSpecificationPool(testSpecification, defaultPool)) &&
      getEffectiveTestSpecificationIsolate(testSpecification, defaultIsolate) === false
    ) {
      return true
    }
  }

  return false
}

function hasThreadPoolTestSpecification (defaultPool, testSpecifications) {
  if (!Array.isArray(testSpecifications)) {
    return false
  }

  for (const testSpecification of testSpecifications) {
    if (isThreadPool(getEffectiveTestSpecificationPool(testSpecification, defaultPool))) {
      return true
    }
  }

  return false
}

function getForkPoolTestModules (defaultPool, testSpecifications) {
  if (!Array.isArray(testSpecifications)) {
    return
  }

  const filepaths = new Set()
  const projectFilepaths = new Set()
  for (const testSpecification of testSpecifications) {
    if (!isForkPool(getEffectiveTestSpecificationPool(testSpecification, defaultPool))) continue

    const filepath = normalizeFilepath(getTestSpecificationFilepath(testSpecification))
    if (!filepath) return

    const projectName = getTestSpecificationProjectName(testSpecification)
    if (projectName) {
      projectFilepaths.add(getProjectFilepathKey(projectName, filepath))
    } else {
      filepaths.add(filepath)
    }
  }

  return {
    filepaths,
    isEmpty: filepaths.size === 0 && projectFilepaths.size === 0,
    projectFilepaths,
  }
}

function getProjectFilepathKey (projectName, filepath) {
  return `${projectName}\u0000${filepath}`
}

function shouldMarkVitestWorkerEnv (pool, testSpecifications) {
  return isForkPool(pool) || hasForkPoolTestSpecification(testSpecifications, pool) ||
    (!testSpecifications && !isThreadPool(pool))
}

function markVitestWorkerEnv (ctx, testSpecifications) {
  const config = ctx?.config
  isVitestNoWorkerInitActive = shouldUseVitestNoWorkerInit(ctx, testSpecifications)
  if (!config || !shouldMarkVitestWorkerEnv(config.pool, testSpecifications)) {
    return
  }
  config.env = getVitestWorkerEnv(config.env, isVitestNoWorkerInitActive)
}

function wrapVitestRunFiles (Vitest, frameworkVersion) {
  if (!Vitest?.prototype?.runFiles) {
    return
  }

  shimmer.wrap(Vitest.prototype, 'runFiles', runFiles => async function (testSpecifications) {
    markVitestWorkerEnv(this, testSpecifications)
    await ensureMainProcessSetup(this, frameworkVersion, testSpecifications)
    return runFiles.apply(this, arguments)
  })

  if (Vitest.prototype.collectTests) {
    shimmer.wrap(Vitest.prototype, 'collectTests', collectTests => function () {
      markVitestWorkerEnv(this)
      return collectTests.apply(this, arguments)
    })
  }
}

function getCreateCliWrapper (vitestPackage, frameworkVersion) {
  const createCliExport = findExportByName(vitestPackage, 'createCLI')
  if (!createCliExport) {
    return vitestPackage
  }
  shimmer.wrap(vitestPackage, createCliExport.key, getCliOrStartVitestWrapper(frameworkVersion))

  return vitestPackage
}

function threadHandler (thread) {
  const { runtime } = thread
  let workerProcess
  if (runtime === 'child_process') {
    vitestPool = 'child_process'
    workerProcess = thread.process
  } else if (runtime === 'worker_threads') {
    vitestPool = 'worker_threads'
    workerProcess = thread.thread
  } else {
    vitestPool = 'unknown'
  }
  if (!workerProcess) {
    log.error('Vitest error: could not get process or thread from TinyPool#run')
    return
  }

  if (workerProcesses.has(workerProcess)) {
    return
  }
  workerProcesses.add(workerProcess)
  workerProcess.on('message', (message) => {
    handleVitestWorkerMessage(message)
  })
}

function getVitestWorkerMessage (message) {
  if (message?.__tinypool_worker_message__ && message.data) {
    return {
      interprocessCode: message.interprocessCode,
      data: message.data,
    }
  }

  if (message?.type !== 'Buffer' && Array.isArray(message)) {
    return {
      interprocessCode: message[0],
      data: message[1],
    }
  }
}

function handleVitestWorkerMessage (message) {
  const workerMessage = getVitestWorkerMessage(message)
  if (!workerMessage) return false

  const { interprocessCode, data } = workerMessage
  if (interprocessCode === VITEST_WORKER_TRACE_PAYLOAD_CODE) {
    collectTestOptimizationSummariesFromTraces(data, {
      newTestsWithDynamicNames,
      attemptToFixExecutions,
    })
    workerReportTraceCh.publish(data)
  } else if (interprocessCode === VITEST_WORKER_LOGS_PAYLOAD_CODE) {
    workerReportLogsCh.publish(data)
  }
  return true
}

function getTinypoolClass (TinyPool) {
  return TinyPool.Tinypool || TinyPool.default || TinyPool
}

function wrapTinypoolConstructor (Tinypool) {
  return class DatadogTinypool extends Tinypool {
    constructor (options) {
      super(getTinypoolOptions(options))
    }
  }
}

function getTinypoolOptions (options = {}) {
  if (!shouldMarkVitestForkWorkerPool(options)) {
    return options
  }

  return {
    ...options,
    env: getVitestWorkerEnv(options.env, isVitestNoWorkerInitActive),
  }
}

function shouldMarkVitestForkWorkerPool (options) {
  if (options?.runtime !== 'child_process') return false
  if (options.env?.VITEST !== 'true') return false

  const filename = typeof options.filename === 'string' ? options.filename.replaceAll('\\', '/') : ''
  return filename.includes('/node_modules/vitest/dist/worker.js')
}

function wrapTinyPoolRun (Tinypool) {
  shimmer.wrap(Tinypool.prototype, 'run', run => async function () {
    // We have to do this before and after because the threads list gets recycled, that is, the processes are re-created
    // eslint-disable-next-line unicorn/no-array-for-each
    this.threads.forEach(threadHandler)
    const runResult = await run.apply(this, arguments)
    // eslint-disable-next-line unicorn/no-array-for-each
    this.threads.forEach(threadHandler)
    return runResult
  })
}

addHook({
  name: 'tinypool',
  // version from tinypool@0.8 was used in vitest@1.6.0
  versions: ['>=0.8.0'],
}, (TinyPool) => {
  const Tinypool = getTinypoolClass(TinyPool)
  wrapTinyPoolRun(Tinypool)

  if (TinyPool.Tinypool || TinyPool.default) {
    if (TinyPool.Tinypool) {
      shimmer.wrap(TinyPool, 'Tinypool', wrapTinypoolConstructor)
    }
    if (TinyPool.default) {
      shimmer.wrap(TinyPool, 'default', wrapTinypoolConstructor)
    }
    return TinyPool
  }

  return wrapTinypoolConstructor(TinyPool)
})

function getWrappedOn (on) {
  return function (event, callback) {
    if (event !== 'message') {
      return on.apply(this, arguments)
    }
    // `arguments[1]` is the callback function, which
    // we modify to intercept our messages to not interfere
    // with vitest's own messages
    arguments[1] = shimmer.wrapFunction(callback, callback => function (message) {
      if (handleVitestWorkerMessage(message)) {
        // If we execute the callback vitest crashes, as the message is not supported
        return
      }
      return callback.apply(this, arguments)
    })
    return on.apply(this, arguments)
  }
}

function getStartVitestWrapper (cliApiPackage, frameworkVersion) {
  if (!isCliApiPackage(cliApiPackage)) {
    return cliApiPackage
  }
  const startVitestExport = findExportByName(cliApiPackage, 'startVitest')
  shimmer.wrap(cliApiPackage, startVitestExport.key, getCliOrStartVitestWrapper(frameworkVersion))

  const vitest = getVitestExport(cliApiPackage)
  if (vitest) {
    wrapVitestRunFiles(vitest.value, frameworkVersion)
  }

  const forksPoolWorker = getForksPoolWorkerExport(cliApiPackage)
  if (forksPoolWorker) {
    // function is async
    shimmer.wrap(forksPoolWorker.value.prototype, 'start', start => function (...args) {
      vitestPool = 'child_process'
      this.env = getVitestWorkerEnv(this.env, isVitestNoWorkerInitActive)

      return start.apply(this, args)
    })
    shimmer.wrap(forksPoolWorker.value.prototype, 'on', getWrappedOn)
  }

  const threadsPoolWorker = getThreadsPoolWorkerExport(cliApiPackage)
  if (threadsPoolWorker) {
    // function is async
    shimmer.wrap(threadsPoolWorker.value.prototype, 'start', start => function (...args) {
      vitestPool = 'worker_threads'
      this.env.DD_VITEST_WORKER = '1'
      return start.apply(this, args)
    })
    shimmer.wrap(threadsPoolWorker.value.prototype, 'on', getWrappedOn)
  }
  return cliApiPackage
}

function getVitestWorkerEnv (env = {}, shouldSkipWorkerInit = false) {
  const workerEnv = {
    ...env,
    DD_VITEST_WORKER: '1',
  }

  if (!shouldSkipWorkerInit) {
    delete workerEnv[VITEST_NO_WORKER_INIT_ACTIVE_ENV]
    return workerEnv
  }

  workerEnv[VITEST_NO_WORKER_INIT_ACTIVE_ENV] = '1'

  const nodeOptions = removeDatadogTestOptimizationNodeOptions(workerEnv.NODE_OPTIONS)
  if (nodeOptions) {
    workerEnv.NODE_OPTIONS = nodeOptions
  } else {
    delete workerEnv.NODE_OPTIONS
  }
  return workerEnv
}

function removeDatadogTestOptimizationNodeOptions (nodeOptions) {
  if (!nodeOptions) return nodeOptions

  const tokens = splitNodeOptions(nodeOptions)
  const filteredTokens = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    const valueSeparator = token.indexOf('=')
    if (valueSeparator !== -1) {
      const flag = token.slice(0, valueSeparator)
      const value = token.slice(valueSeparator + 1)
      if (shouldRemoveNodeOption(flag, value)) {
        continue
      }
    }

    if (token.startsWith('-r') && token.length > 2 && isDatadogTestOptimizationBootstrap(token.slice(2))) {
      continue
    }

    if (
      DATADOG_TEST_OPTIMIZATION_NODE_OPTION_FLAGS.has(token) &&
      isDatadogTestOptimizationBootstrap(tokens[index + 1])
    ) {
      index++
      continue
    }

    filteredTokens.push(token)
  }

  return serializeNodeOptions(filteredTokens)
}

function shouldRemoveNodeOption (flag, value) {
  return DATADOG_TEST_OPTIMIZATION_NODE_OPTION_FLAGS.has(flag) &&
    isDatadogTestOptimizationBootstrap(value)
}

function isDatadogTestOptimizationBootstrap (value) {
  if (!value) return false

  const normalizedValue = value.replaceAll('\\', '/')
  if (DATADOG_TEST_OPTIMIZATION_BOOTSTRAPS.has(normalizedValue)) return true

  for (const bootstrap of DATADOG_TEST_OPTIMIZATION_BOOTSTRAPS) {
    if (normalizedValue.endsWith(`/node_modules/${bootstrap}`)) return true
  }
  return false
}

function splitNodeOptions (nodeOptions) {
  const tokens = []
  let token = ''
  let quote

  for (let index = 0; index < nodeOptions.length; index++) {
    const char = nodeOptions[index]

    if (quote) {
      if (char === '\\' && nodeOptions[index + 1] === quote) {
        token += quote
        index++
        continue
      }

      if (char === quote) {
        quote = undefined
      } else {
        token += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === ' ' || char === '\n' || char === '\t') {
      if (token) {
        tokens.push(token)
        token = ''
      }
      continue
    }

    token += char
  }

  if (token) {
    tokens.push(token)
  }
  return tokens
}

function serializeNodeOptions (tokens) {
  const serializedTokens = []
  for (const token of tokens) {
    if (NODE_OPTIONS_QUOTE_RE.test(token)) {
      serializedTokens.push(JSON.stringify(token))
    } else {
      serializedTokens.push(token)
    }
  }
  return serializedTokens.join(' ')
}

function wrapVitestTestRunner (VitestTestRunner) {
  // `onBeforeRunTask` is run before any repetition or attempt is run
  // `onBeforeRunTask` is an async function
  shimmer.wrap(VitestTestRunner.prototype, 'onBeforeRunTask', onBeforeRunTask => function (task) {
    const testName = getTestName(task)

    const {
      knownTests,
      isEarlyFlakeDetectionEnabled,
      isKnownTestsEnabled,
      numRepeats,
      isTestManagementTestsEnabled,
      testManagementAttemptToFixRetries,
      testManagementTests,
      isImpactedTestsEnabled,
      modifiedFiles,
    } = getProvidedContext()

    if (isTestManagementTestsEnabled) {
      isAttemptToFixCh.publish({
        testManagementTests,
        testSuiteAbsolutePath: task.file.filepath,
        testName,
        onDone: (isAttemptToFix) => {
          if (isAttemptToFix) {
            isRetryReasonAttemptToFix = task.repeats !== testManagementAttemptToFixRetries
            disableFrameworkRetries(task)
            task.repeats = testManagementAttemptToFixRetries
            attemptToFixTasks.add(task)
            attemptToFixTaskToStatuses.set(task, [])
          }
        },
      })
      isDisabledCh.publish({
        testManagementTests,
        testSuiteAbsolutePath: task.file.filepath,
        testName,
        onDone: (isTestDisabled) => {
          if (isTestDisabled) {
            disabledTasks.add(task)
            if (!attemptToFixTasks.has(task)) {
              // we only actually skip if the test is not being attempted to be fixed
              task.mode = 'skip'
            }
          }
        },
      })
    }

    if (isImpactedTestsEnabled) {
      isModifiedCh.publish({
        modifiedFiles,
        testSuiteAbsolutePath: task.file.filepath,
        onDone: (isImpacted) => {
          if (isImpacted) {
            if (isEarlyFlakeDetectionEnabled) {
              isRetryReasonEfd = true
              disableFrameworkRetries(task)
              task.repeats = numRepeats
            }
            modifiedTasks.add(task)
            taskToStatuses.set(task, [])
          }
        },
      })
    }

    if (isKnownTestsEnabled) {
      isNewTestCh.publish({
        knownTests,
        testSuiteAbsolutePath: task.file.filepath,
        testName,
        onDone: (isNew) => {
          if (isNew && !attemptToFixTasks.has(task)) {
            if (isEarlyFlakeDetectionEnabled && !modifiedTasks.has(task)) {
              isRetryReasonEfd = true
              disableFrameworkRetries(task)
              task.repeats = numRepeats
            }
            newTasks.add(task)
            taskToStatuses.set(task, [])
            if (DYNAMIC_NAME_RE.test(testName)) {
              dynamicNameTasks.add(task)
            }
          }
        },
      })
    }

    return onBeforeRunTask.apply(this, arguments)
  })

  // `onAfterRunTask` is run after all repetitions or attempts are run
  // `onAfterRunTask` is an async function
  shimmer.wrap(VitestTestRunner.prototype, 'onAfterRunTask', onAfterRunTask => function (task) {
    const { isEarlyFlakeDetectionEnabled, isTestManagementTestsEnabled } = getProvidedContext()

    if (isTestManagementTestsEnabled) {
      const isAttemptingToFix = attemptToFixTasks.has(task)
      const isQuarantined = quarantinedTasks.has(task)

      if (isAttemptingToFix) {
        const statuses = attemptToFixTaskToStatuses.get(task)
        if (task.result.state === 'pass' && statuses?.includes('fail')) {
          switchedStatuses.add(task)
          task.result.state = 'fail'
        }
      }

      if (!isAttemptingToFix && isQuarantined) {
        if (task.result.state === 'fail') {
          switchedStatuses.add(task)
        }
        task.result.state = 'pass'
      }
    }

    if (isEarlyFlakeDetectionEnabled && taskToStatuses.has(task) && !attemptToFixTasks.has(task)) {
      const statuses = taskToStatuses.get(task)
      // If the test has passed at least once, we consider it passed
      if (statuses.includes('pass')) {
        if (task.result.state === 'fail') {
          switchedStatuses.add(task)
        }
        task.result.state = 'pass'
      }
    }

    return onAfterRunTask.apply(this, arguments)
  })

  // test start (only tests that are not marked as skip or todo)
  // `onBeforeTryTask` is run for every repetition and attempt of the test
  shimmer.wrap(VitestTestRunner.prototype, 'onBeforeTryTask', onBeforeTryTask => async function (task, retryInfo) {
    if (!testPassCh.hasSubscribers && !testErrorCh.hasSubscribers && !testSkipCh.hasSubscribers) {
      return onBeforeTryTask.apply(this, arguments)
    }
    const testName = getTestName(task)
    let isNew = false
    let isQuarantined = false

    const providedContext = getProvidedContext()
    const {
      isKnownTestsEnabled,
      isEarlyFlakeDetectionEnabled,
      isDiEnabled,
      isTestManagementTestsEnabled,
      testManagementTests,
      slowTestRetries,
    } = providedContext

    if (isKnownTestsEnabled) {
      isNew = newTasks.has(task)
    }

    if (isTestManagementTestsEnabled) {
      isQuarantinedCh.publish({
        testManagementTests,
        testSuiteAbsolutePath: task.file.filepath,
        testName,
        onDone: (isTestQuarantined) => {
          isQuarantined = isTestQuarantined
          if (isTestQuarantined) {
            quarantinedTasks.add(task)
          }
        },
      })
    }

    const { retry: numAttempt, repeats: numRepetition } = retryInfo
    const isEfdManagedTask = isEarlyFlakeDetectionEnabled && taskToStatuses.has(task) && !attemptToFixTasks.has(task)

    if (isEfdManagedTask && numRepetition > 0 && !efdDeterminedRetries.has(task)) {
      const previousExecutionStart = efdExecutionStartByTask.get(task)
      const duration = previousExecutionStart === undefined
        ? task.result?.duration ?? 0
        : performance.now() - previousExecutionStart
      const retryCount = getEfdRetryCount(duration, slowTestRetries)
      efdDeterminedRetries.set(task, retryCount)
      task.repeats = retryCount
      if (retryCount === 0) {
        efdSlowAbortedTasks.add(task)
      }
    }

    const efdRetryCount = efdDeterminedRetries.get(task)
    if (isEfdManagedTask && efdRetryCount !== undefined && numRepetition > efdRetryCount) {
      if (task.result) {
        efdSkippedRetryResults.set(task, {
          ...task.result,
          errors: task.result.errors?.slice(),
        })
      }
      if (vitestSetFn) {
        const noop = function () {}
        noop.__ddTraceWrapped = true
        vitestSetFn(task, noop)
      }
      return onBeforeTryTask.apply(this, arguments)
    }
    if (isEfdManagedTask) {
      efdExecutionStartByTask.set(task, performance.now())
    }

    // We finish the previous test here because we know it has failed already
    if (numAttempt > 0) {
      const shouldWaitForHitProbe = isDiEnabled && numAttempt > 1
      if (shouldWaitForHitProbe) {
        await waitForHitProbe()
      }

      const promises = {}
      const shouldSetProbe = isDiEnabled && numAttempt === 1
      const ctx = taskToCtx.get(task)
      const testError = getCurrentAttemptTestError(task, task.result?.errors)
      if (ctx) {
        testErrorCh.publish({
          error: testError,
          shouldSetProbe,
          promises,
          ...ctx.currentStore,
        })
        // We wait for the probe to be set
        if (promises.setProbePromise) {
          await promises.setProbePromise
        }
      }
    }

    const lastExecutionStatus = task.result.state
    const isAtf = attemptToFixTasks.has(task)
    const shouldTrackStatuses = isEarlyFlakeDetectionEnabled || isAtf
    const shouldFlipStatus = isEarlyFlakeDetectionEnabled || isAtf
    const statuses = isAtf ? attemptToFixTaskToStatuses.get(task) : taskToStatuses.get(task)

    // These clauses handle task.repeats, whether EFD is enabled or not
    // The only thing that EFD does is to forcefully pass the test if it has passed at least once
    if (numRepetition > 0 && numRepetition < task.repeats) { // it may or may have not failed
      // Here we finish the earlier iteration,
      // as long as it's not the _last_ iteration (which will be finished normally)

      const ctx = taskToCtx.get(task)
      if (ctx) {
        if (lastExecutionStatus === 'fail') {
          const testError = getCurrentAttemptTestError(task, task.result?.errors)
          testErrorCh.publish({ error: testError, ...ctx.currentStore })
        } else {
          testPassCh.publish({ task, ...ctx.currentStore })
        }
        if (shouldTrackStatuses && statuses) {
          statuses.push(lastExecutionStatus)
        }
        if (shouldFlipStatus) {
          // If we don't "reset" the result.state to "pass", once a repetition fails,
          // vitest will always consider the test as failed, so we can't read the actual status
          // This means that we change vitest's behavior:
          // if the last attempt passes, vitest would consider the test as failed
          // but after this change, it will consider the test as passed
          task.result.state = 'pass'
        }
      }
    } else if (numRepetition === task.repeats) {
      if (shouldTrackStatuses && statuses) {
        statuses.push(lastExecutionStatus)
      }

      const ctx = taskToCtx.get(task)
      if (lastExecutionStatus === 'fail') {
        const testError = getCurrentAttemptTestError(task, task.result?.errors)
        testErrorCh.publish({ error: testError, ...ctx.currentStore })
      } else {
        testPassCh.publish({ task, ...ctx.currentStore })
      }
      if (shouldFlipStatus) {
        task.result.state = 'pass'
      }
    }

    const isRetryReasonAtr = numAttempt > 0 &&
      isFlakyTestRetriesEnabledForTask(providedContext, task) &&
      !isRetryReasonAttemptToFix &&
      !isRetryReasonEfd

    const ctx = {
      testName,
      testSuiteAbsolutePath: task.file.filepath,
      isRetry: numAttempt > 0 || numRepetition > 0,
      isRetryReasonEfd,
      isRetryReasonAttemptToFix: isRetryReasonAttemptToFix && numRepetition > 0,
      isNew,
      hasDynamicName: dynamicNameTasks.has(task),
      mightHitProbe: isDiEnabled && numAttempt > 0,
      isAttemptToFix: attemptToFixTasks.has(task),
      isDisabled: disabledTasks.has(task),
      isQuarantined,
      isRetryReasonAtr,
      isModified: modifiedTasks.has(task),
    }
    taskToCtx.set(task, ctx)

    if (attemptToFixTasks.has(task)) {
      logAttemptToFixTestExecution(
        getTestSuitePath(task.file.filepath, process.cwd()),
        testName,
        loggedAttemptToFixTests
      )
    }

    testStartCh.runStores(ctx, () => {})

    // Wrap the test function so it runs inside the test span context.
    // Without this, HTTP requests during test execution become orphaned root spans.
    if (vitestGetFn && vitestSetFn) {
      const originalFn = vitestGetFn(task)
      if (originalFn && !originalFn.__ddTraceWrapped) {
        const wrappedFn = wrapTestScopedFn(task, originalFn)
        wrappedFn.__ddTraceWrapped = true
        vitestSetFn(task, wrappedFn)
      }
    }

    // Wrap beforeEach/afterEach hooks so they also run inside the test span context.
    // In vitest 4+, hooks are in a WeakMap accessed via getHooks(). In older versions, they're on suite.hooks.
    let currentSuite = task.suite
    while (currentSuite) {
      const hooks = vitestGetHooks ? vitestGetHooks(currentSuite) : currentSuite.hooks
      if (hooks) {
        for (const hookType of ['beforeEach', 'afterEach']) {
          const hookArray = hooks[hookType]
          if (!hookArray) continue
          for (let i = 0; i < hookArray.length; i++) {
            const currentFn = hookArray[i]
            const originalFn = originalHookFns.get(currentFn) || currentFn
            const wrappedFn = shimmer.wrapFunction(originalFn, fn => function (...args) {
              const result = testFnCh.runStores(taskToCtx.get(task), () => fn.apply(this, args))

              if (hookType === 'beforeEach') {
                return wrapBeforeEachCleanupResult(task, result)
              }

              return result
            })
            originalHookFns.set(wrappedFn, originalFn)
            hookArray[i] = wrappedFn
          }
        }
      }
      currentSuite = currentSuite.suite
    }

    return onBeforeTryTask.apply(this, arguments)
  })

  // test finish (only passed tests)
  shimmer.wrap(VitestTestRunner.prototype, 'onAfterTryTask', onAfterTryTask =>
    async function (task, retryInfo) {
      if (!testPassCh.hasSubscribers && !testErrorCh.hasSubscribers && !testSkipCh.hasSubscribers) {
        return onAfterTryTask.apply(this, arguments)
      }
      const result = await onAfterTryTask.apply(this, arguments)

      const {
        isEarlyFlakeDetectionEnabled,
        testManagementAttemptToFixRetries,
        slowTestRetries,
      } = getProvidedContext()

      const status = getVitestTestStatus(task, retryInfo.retry)
      const ctx = taskToCtx.get(task)

      const { isDiEnabled } = getProvidedContext()

      if (efdSkippedRetryResults.has(task)) {
        task.result = efdSkippedRetryResults.get(task)
        efdSkippedRetryResults.delete(task)
        return result
      }

      if (isDiEnabled && retryInfo.retry > 1) {
        await waitForHitProbe()
      }

      if (
        isEarlyFlakeDetectionEnabled &&
        (retryInfo.repeats ?? 0) === 0 &&
        taskToStatuses.has(task) &&
        !attemptToFixTasks.has(task) &&
        !efdDeterminedRetries.has(task)
      ) {
        const executionStart = efdExecutionStartByTask.get(task)
        const duration = executionStart === undefined ? task.result?.duration ?? 0 : performance.now() - executionStart
        const retryCount = getEfdRetryCount(duration, slowTestRetries)
        efdDeterminedRetries.set(task, retryCount)
        task.repeats = retryCount
        if (retryCount === 0) {
          efdSlowAbortedTasks.add(task)
        }
      }

      let attemptToFixPassed = false
      let attemptToFixFailed = false
      if (attemptToFixTasks.has(task)) {
        const statuses = attemptToFixTaskToStatuses.get(task)
        if (statuses.length === testManagementAttemptToFixRetries) {
          if (status === 'pass' && statuses.every(status => status === 'pass')) {
            attemptToFixPassed = true
          } else if (status === 'fail' || statuses.includes('fail')) {
            attemptToFixFailed = true
          }
        }
      }

      if (ctx) {
        // We don't finish here because the test might fail in a later hook (afterEach)
        ctx.status = status
        ctx.task = task
        ctx.attemptToFixPassed = attemptToFixPassed
        ctx.attemptToFixFailed = attemptToFixFailed
        testFinishTimeCh.runStores(ctx, () => {})
      }

      return result
    })
}

function captureRunnerFunctions (pkg) {
  if (vitestGetFn) return
  const getFnExport = findExportByName(pkg, 'getFn')
  const setFnExport = findExportByName(pkg, 'setFn')
  if (getFnExport && setFnExport) {
    vitestGetFn = getFnExport.value
    vitestSetFn = setFnExport.value
  }
  const getHooksExport = findExportByName(pkg, 'getHooks')
  if (getHooksExport) {
    vitestGetHooks = getHooksExport.value
  }
}

addHook({
  name: 'vitest',
  versions: ['>=4.0.0'],
  filePattern: 'dist/chunks/test.*',
}, (testPackage) => {
  const testRunner = getTestRunnerExport(testPackage)
  if (!testRunner) {
    return testPackage
  }

  captureRunnerFunctions(testPackage)
  wrapVitestTestRunner(testRunner.value)

  return testPackage
})

addHook({
  name: '@vitest/runner',
  versions: ['>=1.6.0'],
}, (runnerModule) => {
  if (!vitestGetFn && runnerModule.getFn && runnerModule.setFn) {
    vitestGetFn = runnerModule.getFn
    vitestSetFn = runnerModule.setFn
  }
  if (!vitestGetHooks && runnerModule.getHooks) {
    vitestGetHooks = runnerModule.getHooks
  }
  return runnerModule
})

addHook({
  name: 'vitest',
  versions: ['>=1.6.0 <4.0.0'],
  file: 'dist/runners.js',
}, (vitestPackage) => {
  const { VitestTestRunner } = vitestPackage

  wrapVitestTestRunner(VitestTestRunner)

  return vitestPackage
})

// There are multiple index* files across different versions of vitest,
// so we check for the existence of BaseSequencer to determine if we are in the right file
addHook({
  name: 'vitest',
  versions: ['>=1.6.0 <2.0.0'],
  filePattern: 'dist/vendor/index.*',
}, (vitestPackage) => {
  if (isReporterPackage(vitestPackage)) {
    shimmer.wrap(vitestPackage.B.prototype, 'sort', getSortWrapper)
  }

  return vitestPackage
})

addHook({
  name: 'vitest',
  versions: ['>=2.0.0 <2.0.5'],
  filePattern: 'dist/vendor/index.*',
}, (vitestPackage) => {
  if (isReporterPackageNew(vitestPackage)) {
    shimmer.wrap(vitestPackage.e.prototype, 'sort', getSortWrapper)
  }

  return vitestPackage
})

addHook({
  name: 'vitest',
  versions: ['>=2.0.5 <2.1.0'],
  filePattern: 'dist/chunks/index.*',
}, (vitestPackage) => {
  if (isReporterPackageNewest(vitestPackage)) {
    shimmer.wrap(vitestPackage.h.prototype, 'sort', getSortWrapper)
  }

  return vitestPackage
})

addHook({
  name: 'vitest',
  versions: ['>=2.1.0 <3.0.0'],
  filePattern: 'dist/chunks/RandomSequencer.*',
}, (randomSequencerPackage) => {
  shimmer.wrap(randomSequencerPackage.B.prototype, 'sort', getSortWrapper)
  return randomSequencerPackage
})

addHook({
  name: 'vitest',
  versions: ['>=3.0.9'],
  filePattern: 'dist/chunks/coverage.*',
}, (coveragePackage) => {
  const baseSequencer = getBaseSequencerExport(coveragePackage)
  if (baseSequencer) {
    shimmer.wrap(baseSequencer.value.prototype, 'sort', getSortWrapper)
  }
  return coveragePackage
})

addHook({
  name: 'vitest',
  versions: ['>=3.0.0 <3.0.9'],
  filePattern: 'dist/chunks/resolveConfig.*',
}, (resolveConfigPackage) => {
  shimmer.wrap(resolveConfigPackage.B.prototype, 'sort', getSortWrapper)
  return resolveConfigPackage
})

// Can't specify file because compiled vitest includes hashes in their files
// Following 3 wrappers are for test session start
addHook({
  name: 'vitest',
  versions: ['>=1.6.0 <2.0.5'],
  filePattern: 'dist/vendor/cac.*',
}, getCreateCliWrapper)

addHook({
  name: 'vitest',
  versions: ['>=2.0.5'],
  filePattern: 'dist/chunks/cac.*',
}, getCreateCliWrapper)

addHook({
  name: 'vitest',
  versions: ['>=1.6.0 <2.0.5'],
  filePattern: 'dist/vendor/cli-api.*',
}, getStartVitestWrapper)

addHook({
  name: 'vitest',
  versions: ['>=2.0.5'],
  filePattern: 'dist/chunks/cli-api.*',
}, getStartVitestWrapper)

// test suite start and finish
// only relevant for workers
addHook({
  name: '@vitest/runner',
  versions: ['>=1.6.0'],
}, (vitestPackage, frameworkVersion) => {
  shimmer.wrap(vitestPackage, 'startTests', startTests => async function (testPaths) {
    let testSuiteError = null
    if (!testSuiteFinishCh.hasSubscribers) {
      return startTests.apply(this, arguments)
    }
    // From >=3.0.1, the first arguments changes from a string to an object containing the filepath
    const testSuiteAbsolutePath = testPaths[0]?.filepath || testPaths[0]
    const providedContext = getProvidedContext()

    const testSuiteCtx = {
      testSuiteAbsolutePath,
      frameworkVersion,
      testSessionId: providedContext.testSessionId,
      testModuleId: providedContext.testModuleId,
      testCommand: providedContext.testCommand,
      repositoryRoot: providedContext.repositoryRoot,
      codeOwnersEntries: providedContext.codeOwnersEntries,
    }
    testSuiteStartCh.runStores(testSuiteCtx, () => {})
    const startTestsResponse = await startTests.apply(this, arguments)

    let onFinish = null
    const onFinishPromise = new Promise(resolve => {
      onFinish = resolve
    })

    const testTasks = getTypeTasks(startTestsResponse[0].tasks)

    // Only one test task per test, even if there are retries
    for (const task of testTasks) {
      const testCtx = taskToCtx.get(task)
      const { result } = task
      // We have to trick vitest into thinking that the test has passed
      // but we want to report it as failed if it did fail
      const isSwitchedStatus = switchedStatuses.has(task)

      if (result) {
        const { state, duration, errors } = result
        const testError = getCurrentAttemptTestError(task, errors)
        if (attemptToFixTasks.has(task)) {
          const status = getFinalAttemptToFixStatus(task, state, isSwitchedStatus, testCtx)
          recordFinalAttemptToFixExecution(task, status, providedContext)
        }

        if (state === 'skip') { // programmatic skip
          testSkipCh.publish({
            testName: getTestName(task),
            testSuiteAbsolutePath: task.file.filepath,
            isNew: newTasks.has(task),
            isDisabled: disabledTasks.has(task),
          })
        } else if (state === 'pass' && !isSwitchedStatus) {
          if (testCtx) {
            const isSkippedByTestManagement =
              !attemptToFixTasks.has(task) && (disabledTasks.has(task) || quarantinedTasks.has(task))
            testPassCh.publish({
              task,
              finalStatus: isSkippedByTestManagement ? 'skip' : 'pass',
              earlyFlakeAbortReason: efdSlowAbortedTasks.has(task) ? 'slow' : undefined,
              ...testCtx.currentStore,
            })
          }
        } else if (state === 'fail' || isSwitchedStatus) {
          let hasFailedAllRetries = false
          let attemptToFixFailed = false
          if (attemptToFixTasks.has(task)) {
            const statuses = attemptToFixTaskToStatuses.get(task)
            if (statuses.includes('fail')) {
              attemptToFixFailed = true
            }
            if (statuses.every(status => status === 'fail')) {
              hasFailedAllRetries = true
            }
          }

          // Check if all EFD retries failed
          const isEfdRetry =
            providedContext.isEarlyFlakeDetectionEnabled && (newTasks.has(task) || modifiedTasks.has(task))
          if (isEfdRetry) {
            const statuses = taskToStatuses.get(task)
            const efdRetryCount = efdDeterminedRetries.get(task) ?? providedContext.numRepeats
            // statuses only includes repetitions (not the initial run), so we check against retry count (not +1)
            if (efdRetryCount > 0 && statuses && statuses.length === efdRetryCount &&
              statuses.every(status => status === 'fail')) {
              hasFailedAllRetries = true
            }
          }

          // ATR: set hasFailedAllRetries when all auto test retries were exhausted and every attempt failed
          const isAtrRetry = isFlakyTestRetriesEnabledForTask(providedContext, task) && !attemptToFixTasks.has(task) &&
            !newTasks.has(task) && !modifiedTasks.has(task)
          if (isAtrRetry) {
            const maxRetries = providedContext.flakyTestRetriesCount ?? 0
            if (maxRetries > 0 && task.result?.retryCount === maxRetries) {
              hasFailedAllRetries = true
            }
          }

          if (testCtx) {
            const isRetry = task.result?.retryCount > 0
            // `duration` is the duration of all the retries, so it can't be used if there are retries

            let finalStatus
            if (isSwitchedStatus) {
              if (!attemptToFixTasks.has(task) && (disabledTasks.has(task) || quarantinedTasks.has(task))) {
                finalStatus = 'skip'
              } else if (isAtrRetry || isEfdRetry) {
                finalStatus = hasFailedAllRetries ? 'fail' : 'pass'
              } else if (attemptToFixTasks.has(task)) {
                finalStatus = attemptToFixFailed ? 'fail' : 'pass'
              } else {
                finalStatus = undefined
              }
            } else {
              finalStatus = 'fail'
            }

            testErrorCh.publish({
              duration: isRetry ? undefined : duration,
              error: testError,
              hasFailedAllRetries,
              attemptToFixFailed,
              finalStatus,
              earlyFlakeAbortReason: efdSlowAbortedTasks.has(task) ? 'slow' : undefined,
              ...testCtx.currentStore,
            })
          }
          if (errors?.length) {
            testSuiteError = testError // we store the error to bubble it up to the suite
          }
        }
      } else { // test.skip or test.todo
        testSkipCh.publish({
          testName: getTestName(task),
          testSuiteAbsolutePath: task.file.filepath,
          isNew: newTasks.has(task),
          isDisabled: disabledTasks.has(task),
        })
      }
    }

    const testSuiteResult = startTestsResponse[0].result

    if (testSuiteResult.errors?.length) { // Errors from root level hooks
      testSuiteError = testSuiteResult.errors[0]
    } else if (testSuiteResult.state === 'fail') { // Errors from `describe` level hooks
      const suiteTasks = getTypeTasks(startTestsResponse[0].tasks, 'suite')
      const failedSuites = suiteTasks.filter(task => task.result?.state === 'fail')
      if (failedSuites.length && failedSuites[0].result?.errors?.length) {
        testSuiteError = failedSuites[0].result.errors[0]
      }
    }

    if (testSuiteError) {
      testSuiteCtx.error = testSuiteError
      testSuiteErrorCh.runStores(testSuiteCtx, () => {})
    }

    testSuiteFinishCh.publish({ status: testSuiteResult.state, onFinish, ...testSuiteCtx.currentStore })

    await onFinishPromise

    return startTestsResponse
  })

  return vitestPackage
})
