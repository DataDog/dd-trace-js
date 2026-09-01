'use strict'

const { createCoverageMap } = require('../../../../vendor/dist/istanbul-lib-coverage')
const satisfies = require('../../../../vendor/dist/semifies')
const { DD_MAJOR } = require('../../../../version')
const {
  getRunStoresPromise,
  publishWithCompletion,
  runStoresWithCompletion,
} = require('../helpers/channel')
const { addHook, channel } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const { EMPTY_EFD_RETRY_POLICY } = require('../../../dd-trace/src/ci-visibility/efd-retry-policy')
const { writeCoverageBackfillToCache } = require('../../../dd-trace/src/ci-visibility/test-optimization-cache')
const log = require('../../../dd-trace/src/log')
const { getEnvironmentVariable } = require('../../../dd-trace/src/config/helper')
const {
  getTestSuitePath,
  MOCHA_WORKER_TELEMETRY_PAYLOAD_CODE,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  fromCoverageMapToCoverage,
  getCoveredFilesFromCoverage,
  getExecutableFilesFromCoverage,
  applySkippedCoverageToCoverage,
  mergeCoverage,
  resetCoverage,
  getIsFaultyEarlyFlakeDetection,
  getRelativeCoverageFiles,
  getTestCoverageLinesPercentage,
  collectTestOptimizationSummariesFromTraces,
  logTestOptimizationSummary,
  TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE,
  getTestOptimizationRequestResults,
  isModifiedTest,
  isMarkedAsUnskippable,
} = require('../../../dd-trace/src/plugins/util/test')

const { addMochaRunHooks } = require('./common')
const {
  isNewTest,
  getTestProperties,
  getSuitesByTestFile,
  runnableWrapper,
  getOnTestHandler,
  getOnTestEndHandler,
  getOnTestRetryHandler,
  getOnHookEndHandler,
  patchFailedTestReplayHookUp,
  getOnFailHandler,
  getOnPendingHandler,
  testFileToSuiteCtx,
  newTests,
  efdTests,
  testsQuarantined,
  getTestFullName,
  getRunTestsWrapper,
  resetRunState,
  newTestsWithDynamicNames,
  attemptToFixExecutions,
  loggedAttemptToFixTests,
  adjustRunnerFailuresForTestOptimization,
} = require('./utils')

const MINIMUM_MOCHA_VERSION = DD_MAJOR >= 6 ? '>=8.0.0' : '>=5.2.0'

/**
 * @typedef {{ replacement: Function, run: Function }} ReporterReplacement
 * @typedef {{
 *   createFileRunner?: ReporterReplacement,
 *   hookRuns: Map<object, ReporterReplacement>,
 *   pendingTests: Map<object, { hadPending: boolean, pending: unknown }>,
 *   tests: Set<object>
 * }} RunnerRecoveryState
 */

const patched = new WeakSet()
const runnerEndHandlers = new WeakMap()
const runnerHookMethods = new WeakMap()
const runnerTestEndHandlers = new WeakMap()
const runnerFailuresAdjusted = new WeakSet()
const runnerFrameworkErrors = new WeakMap()
const runnerStarted = new WeakSet()
const runnerRecoveryStates = new WeakMap()
const runnersWithPendingCoverageReset = new WeakSet()
const parallelRunners = new WeakSet()
const wrappedRunnerEmitPrototypes = new WeakSet()
let hasWarnedDeprecatedMochaVersion = false

const unskippableSuites = []
let suitesToSkip = []
let isSuitesSkipped = false
let areAllSuitesSkipped = false
let skippedSuites = []
let skippableSuitesCoverage
let skippedSuitesCoverage = {}
let itrCorrelationId = ''
let isForcedToRun = false
const config = {
  earlyFlakeDetectionRetryPolicy: EMPTY_EFD_RETRY_POLICY,
}

// We'll preserve the original coverage here
const originalCoverageMap = createCoverageMap()
let untestedCoverage

// test channels
const testFinishCh = channel('ci:mocha:test:finish')

// test suite channels
const testSuiteStartCh = channel('ci:mocha:test-suite:start')
const testSuiteFinishCh = channel('ci:mocha:test-suite:finish')
const testSuiteErrorCh = channel('ci:mocha:test-suite:error')
const testSuiteCodeCoverageCh = channel('ci:mocha:test-suite:code-coverage')

// session channels
const libraryConfigurationCh = channel('ci:mocha:library-configuration')
const knownTestsCh = channel('ci:mocha:known-tests')
const skippableSuitesCh = channel('ci:mocha:test-suite:skippable')
const mochaGlobalRunCh = channel('ci:mocha:global:run')

const testManagementTestsCh = channel('ci:mocha:test-management-tests')
const modifiedFilesCh = channel('ci:mocha:modified-files')
const workerReportTraceCh = channel('ci:mocha:worker-report:trace')
const workerReportTelemetryCh = channel('ci:mocha:worker-report:telemetry')
const testSessionStartCh = channel('ci:mocha:session:start')
const testSessionFinishCh = channel('ci:mocha:session:finish')
const itrSkippedSuitesCh = channel('ci:mocha:itr:skipped-suites')

const getCodeCoverageCh = channel('ci:nyc:get-coverage')

function warnDeprecatedMochaVersion (frameworkVersion) {
  if (DD_MAJOR >= 6 || hasWarnedDeprecatedMochaVersion || !frameworkVersion ||
      !satisfies(frameworkVersion, '<8.0.0')) {
    return
  }

  hasWarnedDeprecatedMochaVersion = true
  // eslint-disable-next-line no-console
  console.warn(
    'dd-trace support for Mocha<8.0.0 is deprecated and will be removed in dd-trace v6. ' +
      'Please upgrade Mocha to >=8.0.0.'
  )
}

function getRootSuiteStatus (rootTests) {
  let status = 'pass'
  if (rootTests.every(t => t.isPending())) {
    status = 'skip'
  } else {
    for (const test of rootTests) {
      if (test.state === 'failed' || test.timedOut || test._ddHookFailed) {
        status = 'fail'
      }
    }
  }
  return status
}

function haveRootTestsFinished (rootTests) {
  for (const test of rootTests) {
    if (!test.isPending() && !test.state && !test.timedOut && !test._ddHookFailed) {
      return false
    }
  }
  return true
}

function getSuitePath (suite) {
  return getTestSuitePath(suite.file, process.cwd())
}

function getSuitesToSkip (originalSuites) {
  return getSuitesToSkipFromPaths(originalSuites.map(getSuitePath))
}

function getSuitesToSkipFromPaths (localSuites) {
  const localSuitesSet = new Set(localSuites)
  const suitesToSkipForRun = []

  for (const suite of suitesToSkip) {
    if (localSuitesSet.has(suite)) {
      suitesToSkipForRun.push(suite)
    }
  }

  return suitesToSkipForRun
}

function getFilteredSuites (originalSuites) {
  const suitesToSkipForRun = getSuitesToSkip(originalSuites)

  return originalSuites.reduce((acc, suite) => {
    const testPath = getSuitePath(suite)
    const shouldSkip = suitesToSkipForRun.includes(testPath)
    const isUnskippable = unskippableSuites.includes(suite.file)
    if (shouldSkip && !isUnskippable) {
      acc.skippedSuites.add(testPath)
    } else {
      acc.suitesToRun.push(suite)
    }
    return acc
  }, { suitesToRun: [], skippedSuites: new Set(), suitesToSkipForRun })
}

function isTiaCoverageBackfillEnabled () {
  return config.isItrEnabled && config.isCoverageReportUploadEnabled
}

function getCoverageRootDir () {
  return config.repositoryRoot || process.cwd()
}

/**
 * Recomputes whether a parallel worker result belongs to a modified suite.
 *
 * In parallel mode, `_ddIsModified` is set on Mocha Test objects inside the worker.
 * The main process receives `Test.prototype.serialize()` output for test events,
 * and that fixed serialization drops custom properties. We still need modified-test
 * bookkeeping in the main process for EFD failure suppression, so infer it again
 * from the suite path.
 *
 * @param {string} testSuiteAbsolutePath
 * @returns {boolean}
 */
function isModifiedTestSuite (testSuiteAbsolutePath) {
  const testPath = getTestSuitePath(testSuiteAbsolutePath, getCoverageRootDir())
  return isModifiedTest(testPath, null, null, config.modifiedFiles, 'mocha')
}

function shouldReportCodeCoverageLinesPct (hasBackfilledCoverage) {
  return !isSuitesSkipped || hasBackfilledCoverage
}

function getSkippedSuitesCoverageForRun () {
  return isSuitesSkipped && isTiaCoverageBackfillEnabled() && skippableSuitesCoverage !== undefined
    ? skippableSuitesCoverage
    : {}
}

function applySkippedCoverageToMochaCoverageMap () {
  if (!isTiaCoverageBackfillEnabled()) return false
  return applySkippedCoverageToCoverage(originalCoverageMap, skippedSuitesCoverage, getCoverageRootDir())
}

function getMochaTestSessionCoverageFiles () {
  return getRelativeCoverageFiles(getExecutableFilesFromCoverage(originalCoverageMap), getCoverageRootDir())
}

function resetSuiteSkippingRunState () {
  isSuitesSkipped = false
  areAllSuitesSkipped = false
  skippedSuites = []
  skippableSuitesCoverage = undefined
  skippedSuitesCoverage = {}
  untestedCoverage = undefined
  config.repositoryRoot = undefined
  writeCoverageBackfillToCache({})
}

/**
 * @param {((failures: number) => void) | undefined} callback
 * @returns {{ onRunDone: (failures: number) => void, onFlushDone: () => void }}
 */
function getRunCompletionCallbacks (callback) {
  let failures
  let hasRunFinished = false
  let hasFlushFinished = false
  let hasCompleted = false
  const onDone = callback || (() => {})

  const completeIfReady = () => {
    if (hasCompleted || !hasRunFinished || !hasFlushFinished) return

    hasCompleted = true
    onDone(failures)
  }

  return {
    onRunDone: (runFailures) => {
      if (hasRunFinished) return

      failures = runFailures
      hasRunFinished = true
      completeIfReady()
    },
    onFlushDone: () => {
      if (hasFlushFinished) return

      hasFlushFinished = true
      completeIfReady()
    },
  }
}

function getOnStartHandler (frameworkVersion) {
  return function () {
    const processArgv = process.argv.slice(2).join(' ')
    const command = `mocha ${processArgv}`
    testSessionStartCh.publish({ command, frameworkVersion })
    if (skippedSuites.length) {
      itrSkippedSuitesCh.publish({ skippedSuites, frameworkVersion })
    }
  }
}

/**
 * @param {boolean} isParallel
 * @param {() => void} onDone
 * @returns {(frameworkError?: unknown, onFrameworkErrorDone?: () => void) => void}
 */
function getOnEndHandler (isParallel, onDone) {
  return function (frameworkError, onFrameworkErrorDone) {
    let status = 'pass'
    let error = frameworkError
    if (this.stats) {
      status = this.stats.failures === 0 ? 'pass' : 'fail'
      if (this.stats.tests === 0) {
        status = 'skip'
      }
    } else if (this.failures !== 0) {
      status = 'fail'
    }

    if (arguments.length > 0) {
      status = 'fail'
    } else if (status === 'fail') {
      error = new Error(`Failed tests: ${this.failures}.`)
    }

    testFileToSuiteCtx.clear()

    let testCodeCoverageLinesTotal
    let testSessionCoverageFiles
    if (global.__coverage__ || untestedCoverage) {
      try {
        let hasBackfilledCoverage = false
        if (untestedCoverage) {
          originalCoverageMap.merge(fromCoverageMapToCoverage(untestedCoverage))
        }
        hasBackfilledCoverage = applySkippedCoverageToMochaCoverageMap()
        if (shouldReportCodeCoverageLinesPct(hasBackfilledCoverage)) {
          testCodeCoverageLinesTotal = getTestCoverageLinesPercentage(
            originalCoverageMap,
            undefined,
            getCoverageRootDir()
          )
        }
        if (isTiaCoverageBackfillEnabled()) {
          testSessionCoverageFiles = getMochaTestSessionCoverageFiles()
        }
      } catch {
        // ignore errors
      }
      // restore the original coverage
      global.__coverage__ = fromCoverageMapToCoverage(originalCoverageMap)
    }

    publishWithCompletion(testSessionFinishCh, {
      status,
      isSuitesSkipped,
      testCodeCoverageLinesTotal,
      testSessionCoverageFiles,
      numSkippedSuites: skippedSuites.length,
      hasForcedToRunSuites: isForcedToRun,
      hasUnskippableSuites: !!unskippableSuites.length,
      error,
      isEarlyFlakeDetectionEnabled: config.isEarlyFlakeDetectionEnabled,
      isEarlyFlakeDetectionFaulty: config.isEarlyFlakeDetectionFaulty,
      isTestManagementEnabled: config.isTestManagementTestsEnabled,
      isParallel,
      isFrameworkError: arguments.length > 0,
    }, () => {
      try {
        onDone()
      } finally {
        onFrameworkErrorDone?.()
      }
    })

    logTestOptimizationSummary({
      attemptToFixExecutions,
      newTestsWithDynamicNames,
      extraSections: areAllSuitesSkipped ? [TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE] : [],
    })
    loggedAttemptToFixTests.clear()
  }
}

/**
 * Applies Test Optimization failure suppression once per runner execution.
 *
 * @param {object} runner
 * @returns {void}
 */
function adjustRunnerFailuresOnce (runner) {
  if (runnerFailuresAdjusted.has(runner)) return

  runnerFailuresAdjusted.add(runner)
  adjustRunnerFailuresForTestOptimization(runner, config)
}

/**
 * Returns the mutations that must be restored after reporter-error recovery.
 *
 * @param {object} runner
 * @returns {RunnerRecoveryState}
 */
function getRunnerRecoveryState (runner) {
  let state = runnerRecoveryStates.get(runner)
  if (!state) {
    state = {
      hookRuns: new Map(),
      pendingTests: new Map(),
      tests: new Set(),
    }
    runnerRecoveryStates.set(runner, state)
  }
  return state
}

/**
 * Marks a test pending for the aborted run while retaining its reusable state.
 *
 * @param {object} runner
 * @param {object} test
 * @returns {void}
 */
function markTestPending (runner, test) {
  const state = getRunnerRecoveryState(runner)
  if (!state.pendingTests.has(test)) {
    state.pendingTests.set(test, {
      hadPending: Object.hasOwn(test, 'pending'),
      pending: test.pending,
    })
  }
  state.tests.add(test)
  test.pending = true
  test._ddReporterStartFailed = true
}

/**
 * Marks a completed test for immediate reporter-error finalization.
 *
 * @param {object} runner
 * @param {object} test
 * @returns {void}
 */
function markTestTerminal (runner, test) {
  getRunnerRecoveryState(runner).tests.add(test)
  test._ddReporterTerminalFailed = true
}

/**
 * Restores test and hook state changed only to abort the current run.
 *
 * @param {object} runner
 * @returns {void}
 */
function restoreReporterMutations (runner) {
  const state = runnerRecoveryStates.get(runner)
  if (!state) return

  runnerRecoveryStates.delete(runner)
  for (const [test, { hadPending, pending }] of state.pendingTests) {
    if (hadPending) test.pending = pending
    else delete test.pending
  }
  for (const test of state.tests) {
    delete test._ddTestFinishStarted
    delete test._ddTestFinishPublished
    delete test._ddIsFinalAttempt
    delete test._ddHookFailed
    delete test._ddReporterStartFailed
    delete test._ddReporterTerminalFailed
  }
  for (const [hook, { replacement, run }] of state.hookRuns) {
    if (hook.run === replacement) hook.run = run
  }
  if (state.createFileRunner && runner._createFileRunner === state.createFileRunner.replacement) {
    runner._createFileRunner = state.createFileRunner.run
  }
}

/**
 * Prevents Mocha from entering hooks or the test body after a test-start reporter error.
 *
 * @param {object} runner
 * @param {object} test
 * @returns {void}
 */
function stopCurrentTest (runner, test) {
  const hookDown = runner.hookDown
  const hookUp = runner.hookUp

  markTestPending(runner, test)
  runner.hookDown = function (name, onDone) {
    runner.hookDown = hookDown
    onDone()
  }
  runner.hookUp = function (name, onDone) {
    runner.hookUp = hookUp
    onDone()
  }
}

/**
 * Prevents Mocha from entering a hook after its hook-start reporter event fails.
 *
 * @param {object} runner
 * @param {object} hook
 * @returns {void}
 */
function stopCurrentHook (runner, hook) {
  const hookMethod = runner.hook
  const hookDown = runner.hookDown
  const hookUp = runner.hookUp
  const run = hook.run

  stopRemainingCurrentHooks(runner, hook)
  runner.hook = function (name, onDone) {
    runner.hook = hookMethod
    onDone()
  }
  runner.hookDown = function (name, onDone) {
    runner.hookDown = hookDown
    onDone()
  }
  runner.hookUp = function (name, onDone) {
    runner.hookUp = hookUp
    onDone()
  }
  hook.run = function (onDone) {
    hook.run = run
    const test = hook.ctx?.currentTest
    if (test) {
      if (hook.parent?._afterEach?.includes(hook) || hook.parent?._afterAll?.includes(hook)) {
        markTestTerminal(runner, test)
        if (!test._ddTestFinishStarted) runnerTestEndHandlers.get(runner)?.(test)
      } else {
        markTestPending(runner, test)
      }
    }
    onDone()
  }
}

/**
 * Prevents Mocha from running after-each hooks after a terminal test reporter event fails.
 *
 * @param {object} runner
 * @param {object} test
 * @returns {void}
 */
function stopAfterEachHooks (runner, test) {
  const hookUp = runner.hookUp

  markTestTerminal(runner, test)
  runner.hookUp = function (name, onDone) {
    runner.hookUp = hookUp
    onDone()
  }
}

/**
 * Prevents Mocha from entering any subsequent user hooks after a reporter error.
 *
 * @param {object} runner
 * @returns {void}
 */
function stopFutureHooks (runner) {
  if (runnerHookMethods.has(runner)) return

  runnerHookMethods.set(runner, runner.hook)
  runner.hook = function (name, onDone) {
    onDone()
  }
}

/**
 * Restores the runner hook method after reporter-error finalization.
 *
 * @param {object} runner
 * @returns {void}
 */
function restoreFutureHooks (runner) {
  const hook = runnerHookMethods.get(runner)
  if (!hook) return

  runnerHookMethods.delete(runner)
  runner.hook = hook
}

/**
 * Stops hooks remaining in the currently executing hook array.
 *
 * @param {object} runner
 * @param {object} hook
 * @returns {boolean} whether the completed hook was a before-each hook
 */
function stopRemainingCurrentHooks (runner, hook) {
  const hookLists = [hook.parent?._beforeAll, hook.parent?._beforeEach, hook.parent?._afterEach, hook.parent?._afterAll]

  for (const hooks of hookLists) {
    const hookIndex = hooks?.indexOf(hook) ?? -1
    if (hookIndex === -1) continue

    for (let index = hookIndex + 1; index < hooks.length; index++) {
      const remainingHook = hooks[index]
      const run = remainingHook.run
      const replacement = function (onDone) {
        remainingHook.run = run
        onDone()
      }
      getRunnerRecoveryState(runner).hookRuns.set(remainingHook, { replacement, run })
      remainingHook.run = replacement
    }
    return hooks === hook.parent._beforeEach
  }
  return false
}

/**
 * Prevents a completed before-each hook from continuing into the test body.
 *
 * @param {object} runner
 * @param {object} hook
 * @returns {void}
 */
function stopAfterHookEnd (runner, hook) {
  if (!stopRemainingCurrentHooks(runner, hook) || !runner.test) return

  markTestPending(runner, runner.test)
}

/**
 * Prevents Mocha from entering the root suite after a run-start reporter error.
 *
 * @param {object} runner
 * @returns {void}
 */
function stopRootSuite (runner) {
  const runSuite = runner.runSuite

  runner.runSuite = function (suite, onDone) {
    runner.runSuite = runSuite
    onDone()
  }
}

function skipParallelFile () {}

function createSkippedParallelFileRunner () {
  return skipParallelFile
}

/**
 * Prevents a parallel run-start reporter error from scheduling test workers.
 *
 * @param {object} runner
 * @returns {void}
 */
function stopParallelWorkers (runner) {
  const state = getRunnerRecoveryState(runner)
  if (state.createFileRunner) return

  const run = runner._createFileRunner
  const replacement = createSkippedParallelFileRunner
  state.createFileRunner = { replacement, run }
  runner._createFileRunner = replacement
}

/**
 * Resets suite coverage after every reporter has observed the completed suite.
 *
 * @param {object} runner
 * @returns {void}
 */
function resetPendingSuiteCoverage (runner) {
  if (!runnersWithPendingCoverageReset.delete(runner) || !global.__coverage__) return

  resetCoverage(global.__coverage__)
}

/**
 * Reads a string Error property without invoking user code outside this boundary.
 *
 * @param {Error} error
 * @param {'message' | 'name' | 'stack'} property
 * @returns {string | undefined}
 */
function readErrorString (error, property) {
  try {
    const value = error[property]
    if (typeof value === 'string') return value
  } catch {
    // Ignore user-defined accessors.
  }
}

/**
 * Creates an Error for Test Optimization tags without coercing a user-thrown value.
 *
 * @param {unknown} frameworkError
 * @returns {Error}
 */
function getFrameworkFinalizationError (frameworkError) {
  if (typeof frameworkError === 'string') return new Error(frameworkError)
  let isError = false
  try {
    isError = frameworkError instanceof Error
  } catch {
    // User-thrown proxies can fail the instanceof prototype lookup.
  }
  if (!isError) return new Error('Mocha reporter failed')

  const message = readErrorString(frameworkError, 'message') || 'Mocha reporter failed'
  const error = new Error(message)
  const name = readErrorString(frameworkError, 'name')
  const stack = readErrorString(frameworkError, 'stack')
  if (name) error.name = name
  if (stack) error.stack = stack
  return error
}

/**
 * Defers reporter errors until Mocha can emit its remaining lifecycle events, then
 * runs Datadog's end handler and propagates the original error after finalization.
 *
 * @param {Function} Runner
 * @returns {void}
 */
function wrapRunnerEmit (Runner) {
  if (wrappedRunnerEmitPrototypes.has(Runner.prototype)) return

  wrappedRunnerEmitPrototypes.add(Runner.prototype)
  shimmer.wrap(Runner.prototype, 'emit', emit => function (event) {
    const endHandler = runnerEndHandlers.get(this)
    if (!endHandler) return emit.apply(this, arguments)

    if (event === 'start') runnerStarted.add(this)

    if (!runnerStarted.has(this)) return emit.apply(this, arguments)

    const hasPendingFrameworkError = runnerFrameworkErrors.has(this)
    const pendingFrameworkError = runnerFrameworkErrors.get(this)
    if (event !== 'end') {
      try {
        return emit.apply(this, arguments)
      } catch (error) {
        if (!hasPendingFrameworkError) {
          runnerFrameworkErrors.set(this, error)
          this.abort()
          stopFutureHooks(this)
          if (event === 'start') {
            if (parallelRunners.has(this)) stopParallelWorkers(this)
            else stopRootSuite(this)
          } else if (event === 'test') stopCurrentTest(this, arguments[1])
          else if (event === 'hook') stopCurrentHook(this, arguments[1])
          else if (event === 'hook end') {
            const hook = arguments[1]
            stopAfterHookEnd(this, hook)
            const test = hook.ctx?.currentTest
            if (test && hook.parent?._afterEach?.includes(hook)) {
              markTestTerminal(this, test)
              if (!test._ddTestFinishStarted) runnerTestEndHandlers.get(this)?.(test)
            }
          } else if (event === 'pending' || event === 'pass' || event === 'fail' || event === 'retry' ||
            event === 'test end') {
            const test = arguments[1]
            stopAfterEachHooks(this, test)
            if (event === 'test end' && !test._ddTestFinishStarted) {
              runnerTestEndHandlers.get(this)?.(test)
            }
          }
        }
        return
      } finally {
        if (event === 'suite end') resetPendingSuiteCoverage(this)
      }
    }

    runnerEndHandlers.delete(this)
    restoreFutureHooks(this)
    parallelRunners.delete(this)
    runnerTestEndHandlers.delete(this)
    runnerStarted.delete(this)
    let result
    let hasFrameworkError = hasPendingFrameworkError
    let frameworkError = pendingFrameworkError
    try {
      result = emit.apply(this, arguments)
    } catch (error) {
      if (!hasFrameworkError) {
        hasFrameworkError = true
        frameworkError = error
        runnerFrameworkErrors.set(this, error)
      }
    } finally {
      restoreReporterMutations(this)
    }

    adjustRunnerFailuresOnce(this)

    if (hasFrameworkError) {
      const finalizationError = getFrameworkFinalizationError(frameworkError)
      let hasPropagatedFrameworkError = false
      const propagateFrameworkError = () => {
        if (hasPropagatedFrameworkError) return

        hasPropagatedFrameworkError = true
        if (typeof this.uncaught === 'function') process.removeListener('uncaughtException', this.uncaught)
        if (typeof this.unhandled === 'function') process.removeListener('unhandledRejection', this.unhandled)
        process.nextTick(() => { throw frameworkError })
      }

      try {
        endHandler.call(this, finalizationError, propagateFrameworkError)
      } catch (finalizerError) {
        log.error('Datadog Mocha finalizer failed after a reporter error', finalizerError)
        propagateFrameworkError()
      }

      return result
    }

    endHandler.call(this)
    return result
  })
}

function applyKnownTestsResponse ({ err, knownTests }) {
  if (err) {
    config.knownTests = []
    config.isEarlyFlakeDetectionEnabled = false
    config.isKnownTestsEnabled = false
  } else {
    config.knownTests = knownTests
  }
}

function applyTestManagementTestsResponse ({ err, testManagementTests: receivedTestManagementTests }) {
  if (err) {
    config.testManagementTests = {}
    config.isTestManagementTestsEnabled = false
    config.testManagementAttemptToFixRetries = 0
  } else {
    config.testManagementTests = receivedTestManagementTests
  }
}

function isFailedTestReplayEnabled () {
  return config.isTestDynamicInstrumentationEnabled && config.isDiEnabled
}

/**
 * @typedef {object} MochaSuite
 * @property {MochaSuite[]} suites
 * @property {import('mocha').Test[]} tests
 * @property {MochaSuite[]} _onlySuites
 * @property {import('mocha').Test[]} _onlyTests
 */

/**
 * Mirrors Mocha 5's private exclusivity check.
 *
 * @param {MochaSuite} suite
 * @returns {boolean}
 */
function hasOnly (suite) {
  if (suite._onlyTests.length || suite._onlySuites.length) return true

  for (const childSuite of suite.suites) {
    if (hasOnly(childSuite)) return true
  }
  return false
}

/**
 * Mirrors Mocha 5's private exclusivity filter.
 *
 * @param {MochaSuite} suite
 * @returns {boolean}
 */
function filterOnly (suite) {
  if (suite._onlyTests.length) {
    suite.tests = suite._onlyTests
    suite.suites = []
  } else {
    suite.tests = []

    for (const onlySuite of suite._onlySuites) {
      if (hasOnly(onlySuite)) filterOnly(onlySuite)
    }

    const filteredSuites = []
    for (const childSuite of suite.suites) {
      if (suite._onlySuites.includes(childSuite) || filterOnly(childSuite)) {
        filteredSuites.push(childSuite)
      }
    }
    suite.suites = filteredSuites
  }
  return suite.tests.length > 0 || suite.suites.length > 0
}

function getExecutionConfiguration (runner, isParallel, frameworkVersion, onFinishRequest, localSuites) {
  const ctx = {
    isParallel,
    frameworkVersion,
  }
  let skippableSuitesResponse
  resetSuiteSkippingRunState()

  const onReceivedSkippableSuites = (response) => {
    const {
      err,
      skippableSuites,
      itrCorrelationId: responseItrCorrelationId,
      skippableSuitesCoverage: responseSkippableSuitesCoverage,
    } = response || {}
    if (!response || err) {
      suitesToSkip = []
      skippableSuitesCoverage = undefined
    } else {
      suitesToSkip = skippableSuites
      itrCorrelationId = responseItrCorrelationId
      skippableSuitesCoverage = responseSkippableSuitesCoverage
    }
    if (localSuites) {
      suitesToSkip = getSuitesToSkipFromPaths(localSuites)
      mochaGlobalRunCh.runStores(ctx, () => {
        onFinishRequest()
      })
      return
    }

    // We remove the suites that we skip through ITR
    // Mocha normally applies exclusivity after this asynchronous configuration step.
    if (typeof runner.suite.hasOnly === 'function') {
      if (runner.suite.hasOnly()) runner.suite.filterOnly()
    } else if (hasOnly(runner.suite)) {
      filterOnly(runner.suite)
    }
    const numTestsToRun = runner.grepTotal(runner.suite)
    const filteredSuites = getFilteredSuites(runner.suite.suites)
    const { suitesToRun, suitesToSkipForRun } = filteredSuites

    isSuitesSkipped = suitesToRun.length !== runner.suite.suites.length

    log.debug('%d out of %d suites are going to run.', suitesToRun.length, runner.suite.suites.length)

    runner.suite.suites = suitesToRun
    areAllSuitesSkipped = isSuitesSkipped && numTestsToRun > 0 && runner.grepTotal(runner.suite) === 0

    skippedSuites = [...filteredSuites.skippedSuites]
    suitesToSkip = suitesToSkipForRun
    skippedSuitesCoverage = getSkippedSuitesCoverageForRun()
    writeCoverageBackfillToCache(skippedSuitesCoverage, getCoverageRootDir())

    mochaGlobalRunCh.runStores(ctx, () => {
      onFinishRequest()
    })
  }

  const requestSkippableSuites = () => {
    if (skippableSuitesResponse) {
      onReceivedSkippableSuites(skippableSuitesResponse)
      return
    }

    runStoresWithCompletion(skippableSuitesCh, ctx, onReceivedSkippableSuites)
  }

  const onReceivedImpactedTests = (response) => {
    const { err, modifiedFiles: receivedModifiedFiles } = response || {}
    if (!response || err) {
      config.modifiedFiles = []
      config.isImpactedTestsEnabled = false
    } else {
      config.modifiedFiles = receivedModifiedFiles
    }
    if (config.isSuitesSkippingEnabled) {
      requestSkippableSuites()
    } else {
      mochaGlobalRunCh.runStores(ctx, () => {
        onFinishRequest()
      })
    }
  }

  const continueAfterTestRequests = () => {
    if (config.isImpactedTestsEnabled) {
      runStoresWithCompletion(modifiedFilesCh, ctx, onReceivedImpactedTests)
    } else if (config.isSuitesSkippingEnabled) {
      requestSkippableSuites()
    } else {
      mochaGlobalRunCh.runStores(ctx, () => {
        onFinishRequest()
      })
    }
  }

  const onReceivedConfiguration = (response) => {
    const {
      err,
      isTestDynamicInstrumentationEnabled,
      libraryConfig,
      repositoryRoot,
    } = response || {}
    if (!response || err || !skippableSuitesCh.hasSubscribers || !knownTestsCh.hasSubscribers) {
      return mochaGlobalRunCh.runStores(ctx, () => {
        onFinishRequest()
      })
    }
    config.repositoryRoot = repositoryRoot
    config.isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
    config.earlyFlakeDetectionRetryPolicy =
      libraryConfig.earlyFlakeDetectionRetryPolicy ?? EMPTY_EFD_RETRY_POLICY
    config.earlyFlakeDetectionFaultyThreshold = libraryConfig.earlyFlakeDetectionFaultyThreshold
    config.isKnownTestsEnabled = libraryConfig.isKnownTestsEnabled
    config.isTestManagementTestsEnabled = libraryConfig.isTestManagementEnabled
    config.testManagementAttemptToFixRetries = libraryConfig.testManagementAttemptToFixRetries
    config.isImpactedTestsEnabled = libraryConfig.isImpactedTestsEnabled
    config.isItrEnabled = libraryConfig.isItrEnabled
    config.isCodeCoverageEnabled = libraryConfig.isCodeCoverageEnabled
    config.isCoverageReportUploadEnabled = libraryConfig.isCoverageReportUploadEnabled
    config.isSuitesSkippingEnabled = config.isItrEnabled && libraryConfig.isSuitesSkippingEnabled
    config.isFlakyTestRetriesEnabled = libraryConfig.isFlakyTestRetriesEnabled
    config.flakyTestRetriesCount = libraryConfig.flakyTestRetriesCount
    config.isDiEnabled = libraryConfig.isDiEnabled
    config.isTestDynamicInstrumentationEnabled = isTestDynamicInstrumentationEnabled

    getTestOptimizationRequestResults({
      isKnownTestsEnabled: config.isKnownTestsEnabled,
      isTestManagementTestsEnabled: config.isTestManagementTestsEnabled,
      isSuitesSkippingEnabled: config.isSuitesSkippingEnabled,
      getKnownTests: () => getRunStoresPromise(knownTestsCh, ctx),
      getTestManagementTests: () => getRunStoresPromise(testManagementTestsCh, ctx),
      getSkippableSuites: () => getRunStoresPromise(skippableSuitesCh, ctx),
    }).then(requestResults => {
      const {
        knownTestsResponse,
        testManagementTestsResponse,
        skippableSuitesResponse: requestSkippableSuitesResponse,
      } = requestResults

      if (knownTestsResponse) {
        applyKnownTestsResponse(knownTestsResponse)
      }
      if (testManagementTestsResponse) {
        applyTestManagementTestsResponse(testManagementTestsResponse)
      }
      skippableSuitesResponse = requestSkippableSuitesResponse

      continueAfterTestRequests()
    })
  }

  runStoresWithCompletion(libraryConfigurationCh, ctx, onReceivedConfiguration)
}

// In this hook we delay the execution with options.delay to grab library configuration,
// skippable and known tests.
// It is called but skipped in parallel mode.
/**
 * @param {Function} Mocha
 * @param {string} frameworkVersion
 * @returns {Function}
 */
function wrapMochaRun (Mocha, frameworkVersion) {
  warnDeprecatedMochaVersion(frameworkVersion)

  // Shimmer is required because run must return its Runner while execution is paused and resumed after configuration.
  shimmer.wrap(Mocha.prototype, 'run', run => function (...args) {
    // Workers do not need to request any data, just run the tests
    if (!testFinishCh.hasSubscribers || getEnvironmentVariable('MOCHA_WORKER_ID') || this.options.parallel) {
      return run.apply(this, args)
    }

    // `options.delay` does not work in parallel mode, so we can't delay the execution this way
    // This needs to be both here and in `runMocha` hook. Read the comment in `runMocha` hook for more info.
    this.options.delay = true

    const runner = run.apply(this, args)

    this.files.forEach((path) => {
      const isUnskippable = isMarkedAsUnskippable({ path })
      if (isUnskippable) {
        unskippableSuites.push(path)
      }
    })

    getExecutionConfiguration(runner, false, frameworkVersion, () => {
      if (isFailedTestReplayEnabled()) {
        patchFailedTestReplayHookUp(runner.constructor)
      }
      if (config.isKnownTestsEnabled) {
        const testSuites = this.files.map(file => getTestSuitePath(file, process.cwd()))
        const isFaulty = getIsFaultyEarlyFlakeDetection(
          testSuites,
          config.knownTests?.mocha || {},
          config.earlyFlakeDetectionFaultyThreshold
        )
        if (isFaulty) {
          config.isEarlyFlakeDetectionEnabled = false
          config.isEarlyFlakeDetectionFaulty = true
          config.isKnownTestsEnabled = false
        }
      }
      if (getCodeCoverageCh.hasSubscribers) {
        getCodeCoverageCh.publish({
          onDone: (receivedCodeCoverage) => {
            untestedCoverage = receivedCodeCoverage
            global.run()
          },
        })
      } else {
        global.run()
      }
    })

    return runner
  })
  return Mocha
}

addMochaRunHooks([MINIMUM_MOCHA_VERSION], wrapMochaRun)

addHook({
  name: 'mocha',
  versions: [MINIMUM_MOCHA_VERSION],
  filePattern: String.raw`lib/cli/run-helpers\.(?:c?js)$`,
}, (run) => {
  // `runMocha` is an async function
  shimmer.wrap(run, 'runMocha', runMocha => function (...args) {
    if (!testFinishCh.hasSubscribers) {
      return runMocha.apply(this, args)
    }
    const mocha = args[0]

    /**
     * This attaches `run` to the global context, which we'll call after
     * our configuration and skippable suites requests.
     * You need this both here and in Mocha#run hook: the programmatic API
     * does not call `runMocha`, so it needs to be in Mocha#run. When using
     * the CLI, modifying `options.delay` in Mocha#run is not enough (it's too late),
     * so it also needs to be here.
     */
    if (!mocha.options.parallel) {
      mocha.options.delay = true
    }

    return runMocha.apply(this, args)
  })
  return run
})

// Only used in serial mode (no --parallel flag is passed)
// This hook is used to generate session, module, suite and test events
addHook({
  name: 'mocha',
  versions: [MINIMUM_MOCHA_VERSION],
  filePattern: String.raw`lib/runner\.(?:c?js)$`,
}, function (Runner, frameworkVersion) {
  if (patched.has(Runner)) return Runner

  patched.add(Runner)
  wrapRunnerEmit(Runner)

  shimmer.wrap(Runner.prototype, 'runTests', runTests => getRunTestsWrapper(runTests, config))

  shimmer.wrap(Runner.prototype, 'run', run => function (...args) {
    if (!testFinishCh.hasSubscribers) {
      return run.apply(this, args)
    }

    const { onRunDone, onFlushDone } = getRunCompletionCallbacks(args[0])
    resetRunState(this.suite)
    runnerFailuresAdjusted.delete(this)
    runnerFrameworkErrors.delete(this)
    runnerStarted.delete(this)
    args[0] = () => {
      adjustRunnerFailuresOnce(this)
      if (!this.failures && runnerFrameworkErrors.has(this)) this.failures = 1
      onRunDone(this.failures)
      runnerFrameworkErrors.delete(this)
    }

    const { suitesByTestFile, numSuitesByTestFile } = getSuitesByTestFile(this.suite)
    // Root-level tests (direct children of root, no describe wrapper) keyed by file.
    // Populated during the root 'suite' event so the normal finish path can include them
    // in mixed-file status calculation.
    const rootTestsByFile = new Map()
    // Counts how many original tests per pure-root file still need their final attempt.
    // Hits zero when the last test's lifecycle completes, triggering the suite finish.
    const rootPendingCountByFile = new Map()
    const rootFinalizationPendingCountByFile = new Map()
    const rootFallbackPendingFiles = new Set()
    const rootFinalizationPendingTests = new WeakSet()
    let pendingRootFinalizations = 0
    let hasEnded = false
    let hasFinishedRun = false
    let endRunner
    let endError
    let onFrameworkErrorDone

    function updateRootTestForFinalAttempt (test) {
      if (!test._retriedTest) return

      const rootTests = rootTestsByFile.get(test.file)
      if (!rootTests) return

      const retriedTestIndex = rootTests.indexOf(test._retriedTest)
      if (retriedTestIndex !== -1) {
        rootTests[retriedTestIndex] = test
      }
    }

    function finishRunIfReady () {
      if (hasFinishedRun) return
      if (hasEnded && pendingRootFinalizations === 0) {
        hasFinishedRun = true
        if (onFrameworkErrorDone) onEnd.call(endRunner, endError, onFrameworkErrorDone)
        else onEnd.call(endRunner)
      }
    }

    function incrementPendingRootFinalization (test) {
      if (!rootPendingCountByFile.has(test.file) || rootFinalizationPendingTests.has(test)) return

      rootFinalizationPendingTests.add(test)
      pendingRootFinalizations++
      rootFinalizationPendingCountByFile.set(
        test.file,
        (rootFinalizationPendingCountByFile.get(test.file) || 0) + 1
      )
    }

    function decrementPendingRootFinalization (test) {
      if (!rootFinalizationPendingTests.has(test)) return

      rootFinalizationPendingTests.delete(test)
      pendingRootFinalizations--

      const remaining = rootFinalizationPendingCountByFile.get(test.file) - 1
      if (remaining > 0) {
        rootFinalizationPendingCountByFile.set(test.file, remaining)
      } else {
        rootFinalizationPendingCountByFile.delete(test.file)
      }

      if (!rootFinalizationPendingCountByFile.has(test.file) && rootFallbackPendingFiles.delete(test.file)) {
        finishRootSuiteFallbackForFile(test.file)
      }

      finishRunIfReady()
    }

    function finishRootSuiteForFile (file) {
      const remaining = rootPendingCountByFile.get(file) - 1
      if (remaining > 0) {
        rootPendingCountByFile.set(file, remaining)
        return
      }
      rootPendingCountByFile.delete(file)

      const ctx = testFileToSuiteCtx.get(file)
      if (!ctx) {
        log.warn('No ctx found for suite', file)
        return
      }

      const rootTests = rootTestsByFile.get(file) || []
      const status = getRootSuiteStatus(rootTests)

      if (global.__coverage__) {
        const coverageFiles = getCoveredFilesFromCoverage(global.__coverage__)
        testSuiteCodeCoverageCh.publish({ coverageFiles, suiteFile: file })
        mergeCoverage(global.__coverage__, originalCoverageMap)
        resetCoverage(global.__coverage__)
      }

      testSuiteFinishCh.publish({ status, ...ctx.currentStore }, () => {})
    }

    function finishRootSuiteFallbackForFile (file) {
      const ctx = testFileToSuiteCtx.get(file)
      if (!ctx || !rootPendingCountByFile.has(file)) return

      const rootTests = rootTestsByFile.get(file) || []
      const status = haveRootTestsFinished(rootTests) ? getRootSuiteStatus(rootTests) : 'fail'
      rootPendingCountByFile.delete(file)
      testSuiteFinishCh.publish({ status, ...ctx.currentStore }, () => {})
    }

    function finishRootSuiteAfterFinalAttempt (test) {
      if (!test._ddIsFinalAttempt || !rootPendingCountByFile.has(test.file)) return

      updateRootTestForFinalAttempt(test)
      finishRootSuiteForFile(test.file)
    }

    const onEnd = getOnEndHandler(false, onFlushDone)

    this.prependOnceListener('start', getOnStartHandler(frameworkVersion))

    runnerEndHandlers.set(this, function (frameworkError, frameworkErrorDone) {
      hasEnded = true
      endRunner = this
      endError = frameworkError
      onFrameworkErrorDone = frameworkErrorDone
      finishRunIfReady()
    })

    // The job of this listener is to
    // initialize the suite span tag in correct order
    // (that is suiteA -> testA ... -> suiteB -> testB
    // instead of suiteA -> suiteB -> testA -> ... -> testB)
    // when the suite has tests that are in the top level
    // (no describe(...))
    this.prependListener('test', getOnTestHandler(true))
    // Reporters are registered before Runner#run, so prepend this after the test handler
    // to start the suite first and preserve the test event if a reporter throws.
    this.prependListener('test', function (test) {
      const ctx = testFileToSuiteCtx.get(test.file)
      if (ctx?._pendingRootStart) {
        ctx._pendingRootStart = false
        testSuiteStartCh.runStores(ctx, () => {})
      }
    })

    // Reporters are registered before this run wrapper. Prepend terminal handlers
    // so a reporter error cannot strand a test span that Mocha already completed.
    const onTestEnd = getOnTestEndHandler(config, {
      onStart: incrementPendingRootFinalization,
      onFinish: function (test) {
        finishRootSuiteAfterFinalAttempt(test)
        decrementPendingRootFinalization(test)
      },
    })
    runnerTestEndHandlers.set(this, onTestEnd)
    this.prependListener('test end', onTestEnd)

    this.prependListener('retry', getOnTestRetryHandler(config))

    this.prependListener('hook end', function (hook) {
      const test = hook.ctx?.currentTest
      if (!test) return
      finishRootSuiteAfterFinalAttempt(test)
    })

    // If the hook passes, 'hook end' will be emitted. Otherwise, 'fail' will be emitted.
    this.prependListener('hook end', getOnHookEndHandler(config, {
      onStart: incrementPendingRootFinalization,
      onFinish: function (test) {
        finishRootSuiteAfterFinalAttempt(test)
        decrementPendingRootFinalization(test)
      },
    }))

    this.prependListener('fail', function (testOrHook) {
      if (testOrHook.type !== 'hook') return
      const test = testOrHook.ctx?.currentTest
      if (!test) return
      finishRootSuiteAfterFinalAttempt(test)
    })
    this.prependListener('fail', getOnFailHandler(true, config))

    this.prependListener('pending', getOnPendingHandler())

    this.prependListener('suite', function (suite) {
      if (suite.root || !suite.tests.length) {
        // This branch can be triggered when we have top level it(...) inside test files.
        // In that case, they all (even if they are from different files) are going to be
        // children of the root suite.
        // Note: We could have suites that contain top level it(...) and also it(...) nested
        // inside describe(...) ("mixed case"). Duplication is avoided by the context guard
        // below. Since 'suite' fires for root first, in the mixed case the ctx is created
        // here and the describe-based handler finds it already set.
        if (suite.root && suite.tests.length > 0) {
          const files = new Set(suite.tests.map(test => test.file).filter(Boolean))
          for (const file of files) {
            const testsForFile = suite.tests.filter(t => t.file === file)
            rootTestsByFile.set(file, testsForFile)
            // Only track the countdown for pure root-level files.
            // Mixed files are finished by the normal 'suite end' path.
            if (!suitesByTestFile[file]) {
              rootPendingCountByFile.set(file, testsForFile.length)
            }
            if (testFileToSuiteCtx.get(file)) continue
            const isUnskippable = unskippableSuites.includes(file)
            isForcedToRun = isUnskippable && suitesToSkip.includes(getTestSuitePath(file, process.cwd()))
            const ctx = {
              testSuiteAbsolutePath: file,
              isUnskippable,
              isForcedToRun,
              itrCorrelationId,
              _pendingRootStart: true, // Now the suite start fires lazily on the first test event for this file
            }
            testFileToSuiteCtx.set(file, ctx)
          }
        }
        return
      }
      let ctx = testFileToSuiteCtx.get(suite.file)
      if (!ctx) {
        const isUnskippable = unskippableSuites.includes(suite.file)
        isForcedToRun = isUnskippable && suitesToSkip.includes(getTestSuitePath(suite.file, process.cwd()))
        ctx = {
          testSuiteAbsolutePath: suite.file,
          isUnskippable,
          isForcedToRun,
          itrCorrelationId,
        }
        testFileToSuiteCtx.set(suite.file, ctx)
        testSuiteStartCh.runStores(ctx, () => {})
      }
    })

    // Reporters are registered before Runner#run, so this must run first when one throws.
    this.prependListener('suite end', function (suite) {
      if (suite.root) {
        // Normal case: pure root-level files are finished by the 'test end' / 'hook end'
        // listeners via finishRootSuiteForFile. Two edge cases remain here:
        //
        // 1. All-pending: no 'test' event fired, _pendingRootStart is still true.
        //    Start and immediately finish with 'skip'.
        //
        // 2. Aborted mid-run (e.g. a beforeEach hook failure): Mocha skips remaining
        //    tests and jumps straight to 'suite end'. rootPendingCountByFile still has
        //    a nonzero count for the file because the last tests never ran. Finish it
        //    as failed now.
        //
        // 3. Async finalization lagged behind Mocha's synchronous events (e.g. DI retry
        //    wait): all tests have Mocha terminal state, but the final-attempt callback
        //    did not run before root 'suite end'. Finish from the observed test states.
        const processedFiles = new Set()
        for (const test of suite.tests) {
          if (!test.file || processedFiles.has(test.file)) continue
          processedFiles.add(test.file)
          if (suitesByTestFile[test.file]) continue // mixed: handled by normal path
          const ctx = testFileToSuiteCtx.get(test.file)
          if (!ctx) continue
          if (ctx._pendingRootStart) {
            ctx._pendingRootStart = false
            testSuiteStartCh.runStores(ctx, () => {})
            testSuiteFinishCh.publish({ status: 'skip', ...ctx.currentStore }, () => {})
          } else if (rootPendingCountByFile.has(test.file)) {
            if (rootFinalizationPendingCountByFile.has(test.file)) {
              rootFallbackPendingFiles.add(test.file)
              continue
            }

            finishRootSuiteFallbackForFile(test.file)
          }
        }
        return
      }
      const suitesInTestFile = suitesByTestFile[suite.file]

      const isLastSuite = --numSuitesByTestFile[suite.file] === 0
      if (!isLastSuite) {
        return
      }

      const rootTests = rootTestsByFile.get(suite.file) || []
      let status = 'pass'
      if (suitesInTestFile.every(suite => suite.pending) && rootTests.every(test => test.isPending())) {
        status = 'skip'
      } else {
        // has to check every test in the test file
        suitesInTestFile.forEach(suite => {
          suite.eachTest(test => {
            if (test.state === 'failed' || test.timedOut) {
              status = 'fail'
            }
          })
        })
        for (const test of rootTests) {
          if (test.state === 'failed' || test.timedOut) {
            status = 'fail'
          }
        }
      }

      if (global.__coverage__) {
        const coverageFiles = getCoveredFilesFromCoverage(global.__coverage__)

        testSuiteCodeCoverageCh.publish({
          coverageFiles,
          suiteFile: suite.file,
        })
        // We need to reset coverage to get a code coverage per suite
        // Before that, we preserve the original coverage
        mergeCoverage(global.__coverage__, originalCoverageMap)
        runnersWithPendingCoverageReset.add(this)
      }

      const ctx = testFileToSuiteCtx.get(suite.file)
      if (ctx) {
        testSuiteFinishCh.publish({ status, ...ctx.currentStore }, () => {})
      } else {
        log.warn('No ctx found for suite', suite.file)
      }
    })

    return run.apply(this, args)
  })

  return Runner
})

// Used both in serial and parallel mode, and by both the main process and the workers
// Used to set the correct async resource to the test.
addHook({
  name: 'mocha',
  versions: [MINIMUM_MOCHA_VERSION],
  file: 'lib/runnable.js',
}, (runnablePackage) => runnableWrapper(runnablePackage, config))

function onMessage (message) {
  if (Array.isArray(message)) {
    const [messageCode, payload] = message
    if (messageCode === MOCHA_WORKER_TRACE_PAYLOAD_CODE) {
      collectTestOptimizationSummariesFromTraces(payload, {
        newTestsWithDynamicNames,
        attemptToFixExecutions,
      })
      workerReportTraceCh.publish(payload)
    } else if (messageCode === MOCHA_WORKER_TELEMETRY_PAYLOAD_CODE) {
      workerReportTelemetryCh.publish(payload)
    }
  }
}

// Only used in parallel mode (--parallel flag is passed)
// Used to generate suite events and receive test payloads from workers
addHook({
  name: 'workerpool',
  // mocha@8.0.0 added parallel support and uses workerpool for it
  // The version they use is 6.0.0:
  // https://github.com/mochajs/mocha/blob/612fa31228c695f16173ac675f40ccdf26b4cfb5/package.json#L75
  versions: ['>=6.0.0'],
  file: 'src/WorkerHandler.js',
}, (workerHandlerPackage) => {
  shimmer.wrap(workerHandlerPackage.prototype, 'exec', exec => function (_, path) {
    if (!testFinishCh.hasSubscribers) {
      return exec.apply(this, arguments)
    }
    if (!path?.length) {
      return exec.apply(this, arguments)
    }
    const [testSuiteAbsolutePath] = path
    const testSuiteContext = {}

    this.worker.on('message', onMessage)

    testSuiteContext.testSuiteAbsolutePath = testSuiteAbsolutePath
    testSuiteStartCh.runStores(testSuiteContext, () => {})

    try {
      const promise = exec.apply(this, arguments)
      promise.then(
        (result) => {
          const status = result.failureCount === 0 ? 'pass' : 'fail'
          testSuiteFinishCh.publish({ status, ...testSuiteContext.currentStore }, () => {})
          this.worker.off('message', onMessage)
        },
        (err) => {
          testSuiteContext.error = err
          testSuiteErrorCh.runStores(testSuiteContext, () => {})
          testSuiteFinishCh.publish({ status: 'fail', ...testSuiteContext.currentStore }, () => {})
          this.worker.off('message', onMessage)
        }
      )
      return promise
    } catch (err) {
      testSuiteContext.error = err
      testSuiteErrorCh.runStores(testSuiteContext, () => {})
      testSuiteFinishCh.publish({ status: 'fail', ...testSuiteContext.currentStore }, () => {})
      this.worker.off('message', onMessage)
      throw err
    }
  })

  return workerHandlerPackage
})

// Only used in parallel mode (--parallel flag is passed)
// Used to start and finish test session and test module
addHook({
  name: 'mocha',
  versions: ['>=8.0.0'],
  filePattern: String.raw`lib/nodejs/parallel-buffered-runner\.(?:c?js)$`,
}, (ParallelBufferedRunner, frameworkVersion) => {
  shimmer.wrap(ParallelBufferedRunner.prototype, 'run', run => function (cb, { files, options = {} }) {
    if (!testFinishCh.hasSubscribers) {
      return run.apply(this, arguments)
    }

    const { onRunDone, onFlushDone } = getRunCompletionCallbacks(cb)
    runnerFailuresAdjusted.delete(this)
    runnerFrameworkErrors.delete(this)
    runnerStarted.delete(this)
    parallelRunners.add(this)
    arguments[0] = () => {
      adjustRunnerFailuresOnce(this)
      if (!this.failures && runnerFrameworkErrors.has(this)) this.failures = 1
      onRunDone(this.failures)
      runnerFrameworkErrors.delete(this)
    }

    this.prependOnceListener('start', getOnStartHandler(frameworkVersion))
    runnerEndHandlers.set(this, getOnEndHandler(true, onFlushDone))

    // Populate unskippable suites before config is fetched (matches serial mode at Mocha.prototype.run)
    for (const filePath of files) {
      if (isMarkedAsUnskippable({ path: filePath })) {
        unskippableSuites.push(filePath)
      }
    }

    const localSuites = files.map(file => getTestSuitePath(file, process.cwd()))
    getExecutionConfiguration(this, true, frameworkVersion, () => {
      if (config.isKnownTestsEnabled) {
        const isFaulty = getIsFaultyEarlyFlakeDetection(
          localSuites,
          config.knownTests?.mocha || {},
          config.earlyFlakeDetectionFaultyThreshold
        )
        if (isFaulty) {
          config.isKnownTestsEnabled = false
          config.isEarlyFlakeDetectionEnabled = false
          config.isEarlyFlakeDetectionFaulty = true
        }
      }
      if (config.isSuitesSkippingEnabled && suitesToSkip.length) {
        const filteredFiles = []
        const skippedFiles = []
        for (const file of files) {
          const testPath = getTestSuitePath(file, process.cwd())
          const shouldSkip = suitesToSkip.includes(testPath)
          const isUnskippable = unskippableSuites.includes(file)
          if (shouldSkip && !isUnskippable) {
            skippedFiles.push(testPath)
          } else {
            filteredFiles.push(file)
          }
        }
        isSuitesSkipped = skippedFiles.length > 0
        areAllSuitesSkipped = options.grep === undefined && files.length > 0 && filteredFiles.length === 0
        skippedSuites = skippedFiles
        skippedSuitesCoverage = getSkippedSuitesCoverageForRun()
        writeCoverageBackfillToCache(skippedSuitesCoverage, getCoverageRootDir())
        run.apply(this, [onRunDone, { files: filteredFiles, options }])
      } else {
        run.apply(this, arguments)
      }
    }, localSuites)

    return this
  })

  return ParallelBufferedRunner
})

// Only in parallel mode: BufferedWorkerPool#run is used to run a test file in a worker
// If Early Flake Detection is enabled,
// In this hook we pass the known tests to the worker and collect the new tests that run
addHook({
  name: 'mocha',
  versions: ['>=8.0.0'],
  filePattern: String.raw`lib/nodejs/buffered-worker-pool\.(?:c?js)$`,
}, (BufferedWorkerPoolPackage, frameworkVersion) => {
  const { BufferedWorkerPool } = BufferedWorkerPoolPackage

  if (satisfies(frameworkVersion, '<9.2.0')) {
    // Shimmer is required because the worker environment must be changed before workerpool forks,
    // before any test lifecycle hook can run. Mocha added this worker ID itself in 9.2.0.
    shimmer.wrap(BufferedWorkerPool, 'create', create => function () {
      const pool = create.apply(this, arguments)

      if (!testFinishCh.hasSubscribers) return pool

      let workerId = 0
      shimmer.wrap(pool._pool, '_createWorkerHandler', createWorkerHandler => function () {
        this.forkOpts = {
          ...this.forkOpts,
          env: {
            // eslint-disable-next-line eslint-rules/eslint-process-env
            ...(this.forkOpts.env || process.env),
            MOCHA_WORKER_ID: String(workerId++),
          },
        }
        return createWorkerHandler.apply(this, arguments)
      })

      return pool
    })
  }

  shimmer.wrap(BufferedWorkerPool.prototype, 'run', run => async function (testSuiteAbsolutePath, workerArgs) {
    if (!testFinishCh.hasSubscribers ||
        (!config.isKnownTestsEnabled &&
        !config.isTestManagementTestsEnabled &&
        !config.isImpactedTestsEnabled &&
        !config.isFlakyTestRetriesEnabled &&
        !isFailedTestReplayEnabled())) {
      return run.apply(this, arguments)
    }

    const testPath = getTestSuitePath(testSuiteAbsolutePath, process.cwd())

    const newWorkerArgs = { ...workerArgs }

    if (config.isKnownTestsEnabled) {
      if (config.knownTests?.mocha) {
        const testSuiteKnownTests = config.knownTests.mocha[testPath] || []
        newWorkerArgs._ddEfdRetryPolicy = config.earlyFlakeDetectionRetryPolicy
        newWorkerArgs._ddIsEfdEnabled = config.isEarlyFlakeDetectionEnabled
        newWorkerArgs._ddIsKnownTestsEnabled = true
        newWorkerArgs._ddKnownTests = {
          mocha: {
            [testPath]: testSuiteKnownTests,
          },
        }
      } else {
        config.isEarlyFlakeDetectionEnabled = false
        config.isKnownTestsEnabled = false
        newWorkerArgs._ddIsKnownTestsEnabled = false
        newWorkerArgs._ddIsEfdEnabled = false
        newWorkerArgs._ddKnownTests = {}
      }
    }
    if (config.isTestManagementTestsEnabled) {
      const testSuiteTestManagementTests = config.testManagementTests?.mocha?.suites?.[testPath] || {}
      newWorkerArgs._ddIsTestManagementTestsEnabled = true
      newWorkerArgs._ddTestManagementAttemptToFixRetries = config.testManagementAttemptToFixRetries
      newWorkerArgs._ddTestManagementTests = {
        mocha: {
          suites: {
            [testPath]: testSuiteTestManagementTests,
          },
        },
      }
    }

    if (config.isImpactedTestsEnabled) {
      newWorkerArgs._ddIsImpactedTestsEnabled = true
      newWorkerArgs._ddModifiedFiles = config.modifiedFiles || {}
    }

    if (config.isFlakyTestRetriesEnabled) {
      newWorkerArgs._ddIsFlakyTestRetriesEnabled = true
      newWorkerArgs._ddFlakyTestRetriesCount = config.flakyTestRetriesCount
    }

    if (isFailedTestReplayEnabled()) {
      newWorkerArgs._ddIsFailedTestReplayEnabled = true
    }

    // We pass the known tests for the test file to the worker
    const testFileResult = await run.apply(
      this,
      [
        testSuiteAbsolutePath,
        newWorkerArgs,
      ]
    )

    const tests = testFileResult
      .events
      .filter(event => event.eventName === 'test end')
      .map(event => event.data)
    const isModified = config.isImpactedTestsEnabled && isModifiedTestSuite(testSuiteAbsolutePath)

    for (const test of tests) {
      const testProperties = getTestProperties(test, config.testManagementTests)
      const isAttemptToFix = config.isTestManagementTestsEnabled && testProperties.isAttemptToFix

      // `newTests` is filled in the worker process, so we need to use the test results to fill it here too.
      const isNew = config.isKnownTestsEnabled && isNewTest(test, config.knownTests)
      if (isNew) {
        const testFullName = getTestFullName(test)
        const tests = newTests[testFullName]

        if (tests) {
          tests.push(test)
        } else {
          newTests[testFullName] = [test]
        }
      }
      // `efdTests` is filled in the worker process, so we need to use the test results to fill it here too.
      if (!isAttemptToFix && (isNew || isModified)) {
        const testFullName = getTestFullName(test)
        const tests = efdTests[testFullName]

        if (tests) {
          tests.push(test)
        } else {
          efdTests[testFullName] = [test]
        }
      }
      // `testsQuarantined` is filled in the worker process, so we need to use the test results to fill it here too.
      if (config.isTestManagementTestsEnabled && testProperties.isQuarantined && !testProperties.isAttemptToFix) {
        testsQuarantined.add(test)
      }
    }
    return testFileResult
  })

  return BufferedWorkerPoolPackage
})
