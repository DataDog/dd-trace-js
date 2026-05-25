'use strict'

// Capture real timers at module load time, before any test can install fake timers.
const realSetTimeout = setTimeout

const { existsSync, readFileSync } = require('node:fs')
const { builtinModules, createRequire } = require('node:module')
const path = require('path')
const satisfies = require('../../../vendor/dist/semifies')
const { DD_MAJOR } = require('../../../version')
const shimmer = require('../../datadog-shimmer')
const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const { writeCoverageBackfillToCache } = require('../../dd-trace/src/ci-visibility/test-optimization-cache')
const log = require('../../dd-trace/src/log')
const {
  getCoveredFilesFromCoverage,
  getExecutableFilesFromCoverage,
  JEST_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_COVERAGE_PAYLOAD_CODE,
  JEST_WORKER_TELEMETRY_PAYLOAD_CODE,
  JEST_WORKER_QUARANTINE_PAYLOAD_CODE,
  getTestLineStart,
  getTestSuitePath,
  getTestParametersString,
  getIsFaultyEarlyFlakeDetection,
  JEST_WORKER_LOGS_PAYLOAD_CODE,
  getTestEndLine,
  isModifiedTest,
  DYNAMIC_NAME_RE,
  collectDynamicNamesFromTraces,
  recordAttemptToFixExecution,
  logAttemptToFixTestExecution,
  logTestOptimizationSummary,
  getEfdRetryCount,
  getTestCoverageLinesPercentage,
  applySkippedCoverageToCoverage,
  getSafeSkippableSuites,
  getSkippedSuitesCoverage,
  getTestOptimizationRequestResults,
} = require('../../dd-trace/src/plugins/util/test')
const {
  getFormattedJestTestParameters,
  getJestTestName,
  getRawJestTestName,
  getJestSuitesToRun,
  removeSeedSuffixFromTestName,
} = require('../../datadog-plugin-jest/src/util')
const { addHook, channel } = require('./helpers/instrument')

const testSessionStartCh = channel('ci:jest:session:start')
const testSessionFinishCh = channel('ci:jest:session:finish')
const codeCoverageReportCh = channel('ci:jest:coverage-report')

const testSessionConfigurationCh = channel('ci:jest:session:configuration')

const testSuiteStartCh = channel('ci:jest:test-suite:start')
const testSuiteFinishCh = channel('ci:jest:test-suite:finish')
const testSuiteErrorCh = channel('ci:jest:test-suite:error')

const workerReportTraceCh = channel('ci:jest:worker-report:trace')
const workerReportCoverageCh = channel('ci:jest:worker-report:coverage')
const workerReportLogsCh = channel('ci:jest:worker-report:logs')
const workerReportTelemetryCh = channel('ci:jest:worker-report:telemetry')

const testSuiteCodeCoverageCh = channel('ci:jest:test-suite:code-coverage')

const testStartCh = channel('ci:jest:test:start')
const testSkippedCh = channel('ci:jest:test:skip')
const testFinishCh = channel('ci:jest:test:finish')
const testErrCh = channel('ci:jest:test:err')
const testFnCh = channel('ci:jest:test:fn')
const testSuiteHookFnCh = channel('ci:jest:test-suite:hook:fn')

const skippableSuitesCh = channel('ci:jest:test-suite:skippable')
const libraryConfigurationCh = channel('ci:jest:library-configuration')
const knownTestsCh = channel('ci:jest:known-tests')
const testManagementTestsCh = channel('ci:jest:test-management-tests')
const modifiedFilesCh = channel('ci:jest:modified-files')

const itrSkippedSuitesCh = channel('ci:jest:itr:skipped-suites')

// Message sent by jest's main process to workers to run a test suite (=test file)
// https://github.com/jestjs/jest/blob/1d682f21c7a35da4d3ab3a1436a357b980ebd0fa/packages/jest-worker/src/types.ts#L37
const CHILD_MESSAGE_CALL = 1

// Maximum time we'll wait for the tracer to flush
const FLUSH_TIMEOUT = 10_000
const isJestWorker = !!getEnvironmentVariable('JEST_WORKER_ID')

// https://github.com/jestjs/jest/blob/41f842a46bb2691f828c3a5f27fc1d6290495b82/packages/jest-circus/src/types.ts#L9C8-L9C54
const RETRY_TIMES = Symbol.for('RETRY_TIMES')

let skippableSuites = []
let skippableSuitesCoverage = {}
let skippedSuitesCoverage = {}
let knownTests = {}
let isCodeCoverageEnabled = false
let isCodeCoverageEnabledBecauseOfUs = false
let isSuitesSkippingEnabled = false
let isUserCodeCoverageEnabled = false
let isSuitesSkipped = false
let numSkippedSuites = 0
let hasUnskippableSuites = false
let hasForcedToRunSuites = false
let isEarlyFlakeDetectionEnabled = false
let earlyFlakeDetectionNumRetries = 0
let earlyFlakeDetectionSlowTestRetries = {}
let earlyFlakeDetectionFaultyThreshold = 30
let isEarlyFlakeDetectionFaulty = false
let hasFilteredSkippableSuites = false
let isKnownTestsEnabled = false
let isTestManagementTestsEnabled = false
let testManagementTests = {}
let testManagementAttemptToFixRetries = 0
let isImpactedTestsEnabled = false
let modifiedFiles = {}
let repositoryRoot
let lastCoverageMap
let lastCoverageMapRootDir
let coverageBackfillCollectCoverageFrom
let activeTestSuiteAbsolutePath
let isConsoleErrorWrapped = false

const testContexts = new WeakMap()
const originalTestFns = new WeakMap()
const originalHookFns = new WeakMap()
const retriedTestsToNumAttempts = new Map()
const newTestsTestStatuses = new Map()
const attemptToFixRetriedTestsStatuses = new Map()
const wrappedWorkerChannels = new WeakMap()
// New tests whose names contain likely dynamic data (timestamps, UUIDs, etc.)
// Populated in-process for runInBand, and via worker-report:trace for parallel mode.
const newTestsWithDynamicNames = new Set()
const loggedAttemptToFixTests = new Set()
const testSuiteMockedFiles = new Map()
const testsToBeRetried = new Set()
// Per-test: how many EFD retries were determined after the first execution.
const efdDeterminedRetries = new Map()
// Tests whose first run exceeded the 5-min threshold — tagged "slow".
const efdSlowAbortedTests = new Set()
// Tests added as EFD new-test candidates (not ATF, not impacted).
const efdNewTestCandidates = new Set()
// Tests that are genuinely new (not in known tests list).
const newTests = new Set()
const testSuiteJestObjects = new Map()
const wrappedJestGlobals = new WeakSet()
const wrappedJestObjects = new WeakSet()
const wrappedWorkerInitializers = new WeakSet()
const publishedRuntimeReferenceErrors = new WeakMap()
const wrappedCoverageReporters = new WeakSet()

const BREAKPOINT_HIT_GRACE_PERIOD_MS = 200
const ATR_RETRY_SUPPRESSION_FLAG = '_ddDisableAtrRetry'
const MINIMUM_JEST_VERSION = DD_MAJOR >= 6 ? '>=28.0.0' : '>=24.8.0'
const MINIMUM_JEST_VERSION_BEFORE_30 = DD_MAJOR >= 6 ? '>=28.0.0 <30.0.0' : '>=24.8.0 <30.0.0'
const MINIMUM_JEST_WORKER_VERSION_BEFORE_30 = DD_MAJOR >= 6 ? '>=28.0.0 <30.0.0' : '>=24.9.0 <30.0.0'
const MINIMUM_JEST_CONFIG_ASYNC_VERSION = DD_MAJOR >= 6 ? '>=28.0.0' : '>=25.1.0'
const MINIMUM_JEST_TEST_SCHEDULER_VERSION = DD_MAJOR >= 6 ? '>=28.0.0' : '>=27.0.0'
const atrSuppressedErrors = new Map()
let hasWarnedDeprecatedJestVersion = false
const COVERAGE_BACKFILL_SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?|less|pegjs)$/
const COVERAGE_BACKFILL_DECLARATION_FILE_RE = /\.d\.[cm]?ts$/
const COVERAGE_BACKFILL_TEST_FILE_RE = /\.(?:integration|spec|test|unit)\.[cm]?[jt]sx?$/
const COVERAGE_BACKFILL_HASH_RE = /^[0-9a-f]{64}$/
const COVERAGE_BACKFILL_ANCHOR_SUITE_COUNT = 10

// Track quarantined tests whose errors were suppressed, keyed by "suite › testName"
const quarantinedFailingTests = new Set()

function getJestRepositoryRoot (readConfigsResult) {
  const configuredRepositoryRoot = readConfigsResult.configs
    ?.find(config => config.testEnvironmentOptions?._ddRepositoryRoot)
    ?.testEnvironmentOptions._ddRepositoryRoot

  return configuredRepositoryRoot || process.cwd()
}

/**
 * Sends suppressed quarantine test names from a worker process to the main process.
 * Supports both child_process (process.send) and worker_threads (parentPort.postMessage).
 * Returns true if the data was sent (worker mode), false if in main process (runInBand).
 *
 * @param {string[]} testNames
 * @returns {boolean}
 */
function sendQuarantineInfoToMainProcess (testNames) {
  const payload = [JEST_WORKER_QUARANTINE_PAYLOAD_CODE, JSON.stringify(testNames)]

  if (process.send) {
    process.send(payload)
    return true
  }

  try {
    const { isMainThread, parentPort } = require('node:worker_threads')
    if (!isMainThread && parentPort) {
      parentPort.postMessage(payload)
      return true
    }
  } catch {
    // Not in a worker context
  }

  return false
}

// based on https://github.com/facebook/jest/blob/main/packages/jest-circus/src/formatNodeAssertErrors.ts#L41
function formatJestError (errors) {
  let error
  if (Array.isArray(errors)) {
    const [originalError, asyncError] = errors
    if (originalError === null || !originalError.stack) {
      error = asyncError
      error.message = originalError
    } else {
      error = originalError
    }
  } else {
    error = errors
  }
  return error
}

function warnDeprecatedJestVersion (frameworkVersion) {
  if (DD_MAJOR >= 6 || hasWarnedDeprecatedJestVersion || !frameworkVersion ||
      !satisfies(frameworkVersion, '<28.0.0')) {
    return
  }

  hasWarnedDeprecatedJestVersion = true
  // eslint-disable-next-line no-console
  console.warn(
    'dd-trace support for Jest<28.0.0 is deprecated and will be removed in dd-trace v6. ' +
      'Please upgrade Jest to >=28.0.0.'
  )
}

function getTestEnvironmentOptions (config) {
  if (config.projectConfig && config.projectConfig.testEnvironmentOptions) { // newer versions
    return config.projectConfig.testEnvironmentOptions
  }
  if (config.testEnvironmentOptions) {
    return config.testEnvironmentOptions
  }
  return {}
}

const MAX_IGNORED_TEST_NAMES = 10

function getTestStats (testStatuses) {
  return testStatuses.reduce((acc, testStatus) => {
    acc[testStatus]++
    return acc
  }, { pass: 0, fail: 0 })
}

/**
 * Formats the ignored-failure section for the Test Optimization summary.
 *
 * @param {{ efdNames: string[], quarantineNames: string[], totalCount: number } | undefined} ignoredFailures
 * @returns {string}
 */
function formatIgnoredFailuresSummary (ignoredFailures) {
  if (!ignoredFailures) return ''

  const items = []

  for (const n of ignoredFailures.efdNames) {
    items.push({ text: n, suffix: 'Early Flake Detection' })
  }
  for (const n of ignoredFailures.quarantineNames) {
    items.push({ text: n, suffix: 'Quarantine' })
  }

  if (items.length === 0 || ignoredFailures.totalCount <= 0) return ''

  const shown = items.slice(0, MAX_IGNORED_TEST_NAMES)
  const more = items.length - shown.length
  const moreSuffix = more > 0 ? `\n  ... and ${more} more` : ''
  const formattedItems = shown
    .map(({ text, suffix }) => `  • ${text}${suffix ? ` (${suffix})` : ''}`)
    .join('\n') + moreSuffix

  return `${ignoredFailures.totalCount} test failure(s) were ignored. Exit code set to 0.\n\n${formattedItems}`
}

/**
 * Logs a single "Datadog Test Optimization" summary at session end.
 *
 * @param {{ efdNames: string[], quarantineNames: string[], totalCount: number } | undefined} ignoredFailures
 */
function logSessionSummary (ignoredFailures, attemptToFixExecutions) {
  logTestOptimizationSummary({
    attemptToFixExecutions,
    extraSections: [formatIgnoredFailuresSummary(ignoredFailures)],
    newTestsWithDynamicNames,
  })
  loggedAttemptToFixTests.clear()
}

function getTestStatusFromJestResult (status) {
  if (status === 'failed') return 'fail'
  if (status === 'passed') return 'pass'
}

function getAttemptToFixExecutionsFromJestResults (result) {
  const executions = new Map()
  const rootDir = result.globalConfig?.rootDir || process.cwd()

  for (const { testResults, testFilePath } of result.results.testResults) {
    const testSuite = getTestSuitePath(testFilePath, rootDir)
    const testManagementTestsForSuite = testManagementTests
      ?.jest
      ?.suites
      ?.[testSuite]
      ?.tests
    if (!testManagementTestsForSuite) continue

    for (const { fullName, status } of testResults) {
      const testName = removeSeedSuffixFromTestName(fullName)
      const testStatus = getTestStatusFromJestResult(status)
      if (!testStatus) continue

      const testManagementTest = testManagementTestsForSuite[testName]?.properties
      if (!testManagementTest?.attempt_to_fix) continue

      recordAttemptToFixExecution(executions, {
        testSuite,
        testName,
        status: testStatus,
        isDisabled: testManagementTest.disabled,
        isQuarantined: testManagementTest.quarantined,
      })
    }
  }

  return executions
}

function wrapConsoleErrorForJestReferenceErrors () {
  if (isConsoleErrorWrapped) return

  isConsoleErrorWrapped = true
  // eslint-disable-next-line no-console
  const originalConsoleError = console.error
  // eslint-disable-next-line no-console
  console.error = function () {
    const [message] = arguments
    if (
      typeof message === 'string' &&
      message.includes('Jest environment has been torn down') &&
      activeTestSuiteAbsolutePath
    ) {
      publishRuntimeReferenceError({ _testPath: activeTestSuiteAbsolutePath }, message)
    }
    return originalConsoleError.apply(this, arguments)
  }
}

function getWrappedEnvironment (BaseEnvironment, jestVersion) {
  return class DatadogEnvironment extends BaseEnvironment {
    constructor (config, context) {
      super(config, context)
      const rootDir = config.globalConfig ? config.globalConfig.rootDir : config.rootDir
      this.rootDir = rootDir
      this.nameToParams = {}
      this.global._ddtrace = global._ddtrace
      this.hasSnapshotTests = undefined
      this.testSuiteAbsolutePath = context.testPath
      activeTestSuiteAbsolutePath = this.testSuiteAbsolutePath
      wrapConsoleErrorForJestReferenceErrors()
      this.globalConfig = config.globalConfig

      this.displayName = config.projectConfig?.displayName?.name || config.displayName
      this.testEnvironmentOptions = getTestEnvironmentOptions(config)

      const repositoryRoot = this.testEnvironmentOptions._ddRepositoryRoot
      this.testSuite = getTestSuitePath(context.testPath, rootDir)

      // TODO: could we grab testPath from `this.getVmContext().expect.getState()` instead?
      // so we don't rely on context being passed (some custom test environment do not pass it)
      if (repositoryRoot) {
        this.testSourceFile = getTestSuitePath(context.testPath, repositoryRoot)
        this.repositoryRoot = repositoryRoot
      }

      this.isEarlyFlakeDetectionEnabled = this.testEnvironmentOptions._ddIsEarlyFlakeDetectionEnabled
      this.isFlakyTestRetriesEnabled = this.testEnvironmentOptions._ddIsFlakyTestRetriesEnabled
      this.flakyTestRetriesCount = this.testEnvironmentOptions._ddFlakyTestRetriesCount
      this.isDiEnabled = this.testEnvironmentOptions._ddIsDiEnabled
      this.isKnownTestsEnabled = this.testEnvironmentOptions._ddIsKnownTestsEnabled
      this.isTestManagementTestsEnabled = this.testEnvironmentOptions._ddIsTestManagementTestsEnabled
      this.isImpactedTestsEnabled = this.testEnvironmentOptions._ddIsImpactedTestsEnabled

      if (this.isKnownTestsEnabled) {
        earlyFlakeDetectionSlowTestRetries = this.testEnvironmentOptions._ddEarlyFlakeDetectionSlowTestRetries ?? {}
        try {
          this.knownTestsForThisSuite = this.getKnownTestsForSuite(this.testEnvironmentOptions._ddKnownTests)

          if (!Array.isArray(this.knownTestsForThisSuite)) {
            log.warn('this.knownTestsForThisSuite is not an array so new test and Early Flake detection is disabled.')
            this.isEarlyFlakeDetectionEnabled = false
            this.isKnownTestsEnabled = false
          }
        } catch {
          // If there has been an error parsing the tests, we'll disable Early Flake Deteciton
          this.isEarlyFlakeDetectionEnabled = false
          this.isKnownTestsEnabled = false
        }
      }

      if (this.isFlakyTestRetriesEnabled) {
        const currentNumRetries = this.global[RETRY_TIMES]
        if (!currentNumRetries) {
          this.global[RETRY_TIMES] = this.flakyTestRetriesCount
        }
      }

      if (this.isTestManagementTestsEnabled) {
        try {
          const hasTestManagementTests = !!testManagementTests?.jest
          testManagementAttemptToFixRetries = this.testEnvironmentOptions._ddTestManagementAttemptToFixRetries
          this.testManagementTestsForThisSuite = hasTestManagementTests
            ? this.getTestManagementTestsForSuite(testManagementTests?.jest?.suites?.[this.testSuite]?.tests)
            : this.getTestManagementTestsForSuite(this.testEnvironmentOptions._ddTestManagementTests)
        } catch (e) {
          log.error('Error parsing test management tests', e)
          this.isTestManagementTestsEnabled = false
        }
      }

      if (this.isImpactedTestsEnabled) {
        try {
          const hasImpactedTests = Object.keys(modifiedFiles).length > 0
          this.modifiedFiles = hasImpactedTests ? modifiedFiles : this.testEnvironmentOptions._ddModifiedFiles
        } catch (e) {
          log.error('Error parsing impacted tests', e)
          this.isImpactedTestsEnabled = false
        }
      }
    }

    /**
     * Jest snapshot counter issue during test retries
     *
     * Problem:
     * - Jest tracks snapshot calls using an internal counter per test name
     * - Each `toMatchSnapshot()` call increments this counter
     * - When a test is retried, it keeps the same name but the counter continues from where it left off
     *
     * Example Issue:
     * Original test run creates: `exports["test can do multiple snapshots 1"] = "hello"`
     * Retried test expects:      `exports["test can do multiple snapshots 2"] = "hello"`
     *
     * This mismatch causes snapshot tests to fail on retry because Jest is looking
     * for the wrong snapshot number. The solution is to reset the snapshot state.
     */
    resetSnapshotState () {
      try {
        const expectGlobal = this.getVmContext().expect
        const { snapshotState: { _counters: counters } } = expectGlobal.getState()
        if (counters) {
          counters.clear()
        }
      } catch (e) {
        log.warn('Error resetting snapshot state', e)
      }
    }

    /**
     * Jest mock state issue during test retries
     *
     * Problem:
     * - Jest tracks mock function calls using internal state (call count, call arguments, etc.)
     * - When a test is retried, the mock state is not automatically reset
     * - This causes assertions like `toHaveBeenCalledTimes(1)` to fail because the call count
     *   accumulates across retries
     *
     * The solution is to clear all mocks before each retry attempt.
     */
    resetMockState () {
      try {
        if (this.moduleMocker?.clearAllMocks) {
          this.moduleMocker.clearAllMocks()
          return
        }
        const jestObject = testSuiteJestObjects.get(this.testSuiteAbsolutePath)
        if (jestObject?.clearAllMocks) {
          jestObject.clearAllMocks()
        }
      } catch (e) {
        log.warn('Error resetting mock state', e)
      }
    }

    // This function returns an array if the known tests are valid and null otherwise.
    getKnownTestsForSuite (suiteKnownTests) {
      // `suiteKnownTests` is `this.testEnvironmentOptions._ddKnownTests`,
      // which is only set if jest is configured to run in parallel.
      if (suiteKnownTests) {
        return suiteKnownTests
      }
      // Global variable `knownTests` is set only in the main process.
      // If jest is configured to run serially, the tests run in the same process, so `knownTests` is set.
      // The assumption is that if the key `jest` is defined in the dictionary, the response is valid.
      if (knownTests?.jest) {
        return knownTests.jest[this.testSuite] || []
      }
      return null
    }

    getTestManagementTestsForSuite (testManagementTests) {
      if (this.testManagementTestsForThisSuite) {
        return this.testManagementTestsForThisSuite
      }
      if (!testManagementTests) {
        return {
          attemptToFix: [],
          disabled: [],
          quarantined: [],
        }
      }
      let testManagementTestsForSuite = testManagementTests
      // If jest is using workers, test management tests are serialized to json.
      // If jest runs in band, they are not.
      if (typeof testManagementTestsForSuite === 'string') {
        testManagementTestsForSuite = JSON.parse(testManagementTestsForSuite)
      }

      const result = {
        attemptToFix: [],
        disabled: [],
        quarantined: [],
      }

      for (const [testName, { properties }] of Object.entries(testManagementTestsForSuite)) {
        if (properties?.attempt_to_fix) {
          result.attemptToFix.push(testName)
        }
        if (properties?.disabled) {
          result.disabled.push(testName)
        }
        if (properties?.quarantined) {
          result.quarantined.push(testName)
        }
      }

      return result
    }

    // Generic function to handle test retries
    retryTest ({
      jestEvent,
      retryCount,
      retryType,
    }) {
      const { testName, fn, timeout } = jestEvent
      for (let retryIndex = 0; retryIndex < retryCount; retryIndex++) {
        if (this.global.test) {
          this.global.test(testName, fn, timeout)
        } else {
          log.error('%s could not retry test because global.test is undefined', retryType)
        }
      }
    }

    // At the `add_test` event we don't have the test object yet, so we can't use it
    getTestNameFromAddTestEvent (event, state) {
      const describeSuffix = getRawJestTestName(state.currentDescribeBlock)
      const testName = describeSuffix ? `${describeSuffix} ${event.testName}` : event.testName
      return removeSeedSuffixFromTestName(testName)
    }

    async handleTestEvent (event, state) {
      if (super.handleTestEvent) {
        await super.handleTestEvent(event, state)
      }

      const setNameToParams = (name, params) => { this.nameToParams[name] = [...params] }

      if (event.name === 'setup' && this.global.test) {
        shimmer.wrap(this.global.test, 'each', each => function (...args) {
          const testParameters = getFormattedJestTestParameters(args)
          const eachBind = each.apply(this, args)
          return function (...args) {
            const [testName] = args
            setNameToParams(testName, testParameters)
            return eachBind.apply(this, args)
          }
        })
      }
      if (event.name === 'test_start') {
        const testName = getJestTestName(event.test)
        if (testsToBeRetried.has(testName)) {
          // This is needed because we're retrying tests with the same name
          this.resetSnapshotState()
          this.resetMockState()
        }

        let isNewTest = false
        let numEfdRetry = null
        let numOfAttemptsToFixRetries = null
        const testParameters = getTestParametersString(this.nameToParams, event.test.name)

        let isAttemptToFix = false
        let isDisabled = false
        let isQuarantined = false
        if (this.isTestManagementTestsEnabled) {
          isAttemptToFix = this.testManagementTestsForThisSuite?.attemptToFix?.includes(testName)
          isDisabled = this.testManagementTestsForThisSuite?.disabled?.includes(testName)
          isQuarantined = this.testManagementTestsForThisSuite?.quarantined?.includes(testName)
          if (isAttemptToFix) {
            numOfAttemptsToFixRetries = retriedTestsToNumAttempts.get(testName)
            retriedTestsToNumAttempts.set(testName, numOfAttemptsToFixRetries + 1)
          } else if (isDisabled) {
            event.test.mode = 'skip'
          }
        }

        let isModified = false
        if (this.isImpactedTestsEnabled) {
          const testStartLine = getTestLineStart(event.test.asyncError, this.testSuite)
          const testEndLine = getTestEndLine(event.test.fn, testStartLine)
          isModified = isModifiedTest(
            this.testSourceFile,
            testStartLine,
            testEndLine,
            this.modifiedFiles,
            'jest'
          )
        }

        if (this.isKnownTestsEnabled) {
          isNewTest = newTests.has(testName)
        }

        const willRunEfd = this.isEarlyFlakeDetectionEnabled && (isNewTest || isModified)
        event.test[ATR_RETRY_SUPPRESSION_FLAG] = Boolean(isAttemptToFix || willRunEfd)

        if (!isAttemptToFix && willRunEfd) {
          numEfdRetry = retriedTestsToNumAttempts.get(testName)
          retriedTestsToNumAttempts.set(testName, numEfdRetry + 1)
        }

        const isJestRetry = event.test?.invocations > 1
        const hasDynamicName = isNewTest && DYNAMIC_NAME_RE.test(testName)
        const ctx = {
          name: testName,
          suite: this.testSuite,
          testSourceFile: this.testSourceFile,
          displayName: this.displayName,
          testParameters,
          frameworkVersion: jestVersion,
          isNew: isNewTest,
          isEfdRetry: numEfdRetry > 0,
          isAttemptToFix,
          isAttemptToFixRetry: numOfAttemptsToFixRetries > 0,
          isJestRetry,
          isDisabled,
          isQuarantined,
          isModified,
          hasDynamicName,
          testSuiteAbsolutePath: this.testSuiteAbsolutePath,
        }
        testContexts.set(event.test, ctx)

        if (isAttemptToFix) {
          logAttemptToFixTestExecution(this.testSuite, testName, loggedAttemptToFixTests)
        }

        testStartCh.runStores(ctx, () => {
          let p = event.test.parent
          const hooks = []
          while (p != null) {
            hooks.push(...p.hooks)
            p = p.parent
          }
          for (const hook of hooks) {
            let hookFn = hook.fn
            if (originalHookFns.has(hook)) {
              hookFn = originalHookFns.get(hook)
            } else {
              originalHookFns.set(hook, hookFn)
            }
            const newHookFn = shimmer.wrapFunction(hookFn, hookFn => function (...args) {
              return testFnCh.runStores(ctx, () => hookFn.apply(this, args))
            })
            hook.fn = newHookFn
          }
          const originalFn = event.test.fn
          originalTestFns.set(event.test, originalFn)

          const newFn = shimmer.wrapFunction(event.test.fn, testFn => function (...args) {
            return testFnCh.runStores(ctx, () => testFn.apply(this, args))
          })

          event.test.fn = newFn
        })
      }

      if (event.name === 'hook_start' && (event.hook.type === 'beforeAll' || event.hook.type === 'afterAll')) {
        const ctx = { testSuiteAbsolutePath: this.testSuiteAbsolutePath }
        let hookFn = event.hook.fn
        if (originalHookFns.has(event.hook)) {
          hookFn = originalHookFns.get(event.hook)
        } else {
          originalHookFns.set(event.hook, hookFn)
        }
        event.hook.fn = shimmer.wrapFunction(hookFn, hookFn => function (...args) {
          return testSuiteHookFnCh.runStores(ctx, () => hookFn.apply(this, args))
        })
      }

      if (event.name === 'add_test') {
        if (event.failing) {
          return
        }

        const testFullName = this.getTestNameFromAddTestEvent(event, state)
        const isSkipped = event.mode === 'todo' || event.mode === 'skip'
        const isAttemptToFix = this.isTestManagementTestsEnabled &&
          this.testManagementTestsForThisSuite?.attemptToFix?.includes(testFullName)
        if (
          isAttemptToFix &&
          !isSkipped &&
          !retriedTestsToNumAttempts.has(testFullName)
        ) {
          retriedTestsToNumAttempts.set(testFullName, 0)
          testsToBeRetried.add(testFullName)
          this.retryTest({
            jestEvent: event,
            retryCount: testManagementAttemptToFixRetries,
            retryType: 'Test Management (Attempt to Fix)',
          })
        }
        if (!isAttemptToFix && this.isImpactedTestsEnabled) {
          const testStartLine = getTestLineStart(event.asyncError, this.testSuite)
          const testEndLine = getTestEndLine(event.fn, testStartLine)
          const isModified = isModifiedTest(
            this.testSourceFile,
            testStartLine,
            testEndLine,
            this.modifiedFiles,
            'jest'
          )
          if (isModified && !retriedTestsToNumAttempts.has(testFullName) && this.isEarlyFlakeDetectionEnabled) {
            retriedTestsToNumAttempts.set(testFullName, 0)
            testsToBeRetried.add(testFullName)
            this.retryTest({
              jestEvent: event,
              retryCount: earlyFlakeDetectionNumRetries,
              retryType: 'Impacted tests',
            })
          }
        }
        if (!isAttemptToFix && this.isKnownTestsEnabled) {
          const isNew = !this.knownTestsForThisSuite.includes(testFullName)
          if (isNew && !isSkipped) {
            newTests.add(testFullName)
          }
          if (isNew && !isSkipped && !retriedTestsToNumAttempts.has(testFullName)) {
            if (DYNAMIC_NAME_RE.test(testFullName)) {
              // Populated directly for runInBand; for parallel workers the main process
              // collects these from the TEST_HAS_DYNAMIC_NAME span tag via worker-report:trace.
              newTestsWithDynamicNames.add(`${this.testSuite} › ${testFullName}`)
            }
            retriedTestsToNumAttempts.set(testFullName, 0)
            if (this.isEarlyFlakeDetectionEnabled) {
              testsToBeRetried.add(testFullName)
              efdNewTestCandidates.add(testFullName)
              // Cloning is deferred to test_done after the first execution,
              // when we know the duration and can choose the right retry count.
            }
          }
        }
      }
      if (event.name === 'test_done') {
        const originalError = event.test?.errors?.[0]
        let status = 'pass'
        if (event.test.errors && event.test.errors.length) {
          status = 'fail'
        }
        // restore in case it is retried
        event.test.fn = originalTestFns.get(event.test)
        // If ATR retry is being suppressed for this test (due to EFD or Attempt to Fix taking precedence)
        // and the test has errors for this attempt, store the errors temporarily and clear them
        // so Jest won't treat this attempt as failed (the real status will be reported after retries).
        if (event.test?.[ATR_RETRY_SUPPRESSION_FLAG] && event.test.errors?.length) {
          atrSuppressedErrors.set(event.test, event.test.errors)
          event.test.errors = []
        }

        let attemptToFixPassed = false
        let attemptToFixFailed = false
        let failedAllTests = false
        let isAttemptToFix = false
        const testName = getJestTestName(event.test)
        if (this.isTestManagementTestsEnabled) {
          isAttemptToFix = this.testManagementTestsForThisSuite?.attemptToFix?.includes(testName)
          if (isAttemptToFix) {
            if (attemptToFixRetriedTestsStatuses.has(testName)) {
              attemptToFixRetriedTestsStatuses.get(testName).push(status)
            } else {
              attemptToFixRetriedTestsStatuses.set(testName, [status])
            }
            const testStatuses = attemptToFixRetriedTestsStatuses.get(testName)
            // Check if this is the last attempt to fix.
            // If it is, we'll set the failedAllTests flag to true if all the tests failed
            // If all tests passed, we'll set the attemptToFixPassed flag to true
            if (testStatuses.length === testManagementAttemptToFixRetries + 1) {
              if (testStatuses.includes('fail')) {
                attemptToFixFailed = true
              }
              if (testStatuses.every(status => status === 'fail')) {
                failedAllTests = true
              } else if (testStatuses.every(status => status === 'pass')) {
                attemptToFixPassed = true
              }
            }
          }
        }

        // EFD dynamic cloning: on first execution of a new EFD candidate,
        // determine the retry count from the test's duration.
        if (
          this.isEarlyFlakeDetectionEnabled &&
          this.isKnownTestsEnabled &&
          efdNewTestCandidates.has(testName) &&
          event.test.invocations === 1 &&
          !efdDeterminedRetries.has(testName)
        ) {
          const durationMs = event.test.duration ?? 0
          const retryCount = getEfdRetryCount(durationMs, earlyFlakeDetectionSlowTestRetries)
          efdDeterminedRetries.set(testName, retryCount)
          if (retryCount > 0) {
            // Temporarily adjust jest-circus state so that retry tests are registered
            // into the correct describe block and bypass the "tests have started" guard.
            //
            // Problem 1 (jest-circus ≤24): currentDescribeBlock points to ROOT during
            // execution, and ROOT's tests loop already finished before children ran.
            //
            // Problem 2 (jest-circus ≥27): `hasStarted = true` causes `test()` to throw
            // "Cannot add a test after tests have started running".
            //
            // Fix: temporarily point currentDescribeBlock to the test's parent (so retries
            // land in the still-iterating children array) and set hasStarted = false (so the
            // guard is bypassed). Both are restored immediately after scheduling the retries.
            const originalDescribeBlock = state.currentDescribeBlock
            const originalHasStarted = state.hasStarted
            state.currentDescribeBlock = event.test.parent ?? originalDescribeBlock
            state.hasStarted = false
            this.retryTest({
              jestEvent: {
                testName: event.test.name,
                fn: event.test.fn,
                timeout: event.test.timeout,
              },
              retryCount,
              retryType: 'Early flake detection',
            })
            state.currentDescribeBlock = originalDescribeBlock
            state.hasStarted = originalHasStarted
          } else {
            efdSlowAbortedTests.add(testName)
          }
        }

        let isEfdRetry = false
        // We'll store the test statuses of the retries
        if (this.isKnownTestsEnabled) {
          const isNewTest = newTests.has(testName)
          if (isNewTest) {
            if (newTestsTestStatuses.has(testName)) {
              newTestsTestStatuses.get(testName).push(status)
              isEfdRetry = true
            } else {
              newTestsTestStatuses.set(testName, [status])
            }
            const testStatuses = newTestsTestStatuses.get(testName)
            // Check if this is the last EFD retry.
            // If it is, we'll set the failedAllTests flag to true if all the tests failed
            const efdRetryCount = efdDeterminedRetries.get(testName) ?? 0
            if (efdRetryCount > 0 && testStatuses.length === efdRetryCount + 1 &&
              testStatuses.every(status => status === 'fail')) {
              failedAllTests = true
            }
          }
        }

        // ATR: set failedAllTests when all auto test retries were exhausted and every attempt failed
        if (this.isFlakyTestRetriesEnabled && !isAttemptToFix && !isEfdRetry) {
          const maxRetries = Number(this.global[RETRY_TIMES]) || 0
          if (event.test?.invocations === maxRetries + 1 && status === 'fail') {
            failedAllTests = true
          }
        }

        const promises = {}
        const numRetries = this.global[RETRY_TIMES]
        const numTestExecutions = event.test?.invocations
        const willBeRetriedByFailedTestReplay = numRetries > 0 && numTestExecutions - 1 < numRetries
        const mightHitBreakpoint = this.isDiEnabled && numTestExecutions >= 2

        // For quarantined tests, track failures so the session can be marked as passing later,
        // and suppress errors so Jest does not mark the test suite as failing.
        // The actual status ('fail') is already captured above for dd-trace reporting.
        // Only suppress on the final execution — not when ATR/EFD/ATF will retry the test.
        if (!event.test?.[ATR_RETRY_SUPPRESSION_FLAG] && !willBeRetriedByFailedTestReplay) {
          const quarantineCtx = testContexts.get(event.test)
          if (quarantineCtx?.isQuarantined && !quarantineCtx.isAttemptToFix && event.test.errors?.length) {
            quarantinedFailingTests.add(`${quarantineCtx.suite} › ${quarantineCtx.name}`)
            event.test.errors = []
          }
        }

        const ctx = testContexts.get(event.test)
        if (!ctx) {
          log.warn('"ci:jest:test_done": no context found for test "%s"', testName)
          return
        }

        const finalStatus = this.getFinalStatus(testName,
          status,
          !!ctx.isNew,
          !!ctx.isModified,
          isEfdRetry,
          isAttemptToFix,
          numTestExecutions)

        if (status === 'fail') {
          const shouldSetProbe = this.isDiEnabled && willBeRetriedByFailedTestReplay && numTestExecutions === 1
          testErrCh.publish({
            ...ctx.currentStore,
            error: formatJestError(originalError),
            shouldSetProbe,
            promises,
          })
        }

        // After finishing it might take a bit for the snapshot to be handled.
        // This means that tests retried with DI are BREAKPOINT_HIT_GRACE_PERIOD_MS slower at least.
        if (status === 'fail' && mightHitBreakpoint) {
          await new Promise(resolve => {
            realSetTimeout(() => {
              resolve()
            }, BREAKPOINT_HIT_GRACE_PERIOD_MS)
          })
        }

        let isAtrRetry = false
        if (this.isFlakyTestRetriesEnabled && event.test?.invocations > 1 && !isAttemptToFix && !isEfdRetry) {
          isAtrRetry = true
        }

        testFinishCh.publish({
          ...ctx.currentStore,
          status,
          testStartLine: getTestLineStart(event.test.asyncError, this.testSuite),
          attemptToFixPassed,
          failedAllTests,
          attemptToFixFailed,
          isAtrRetry,
          finalStatus,
          earlyFlakeAbortReason: efdSlowAbortedTests.has(testName) ? 'slow' : undefined,
        })

        if (promises.isProbeReady) {
          await promises.isProbeReady
        }
      }
      if (event.name === 'run_finish') {
        for (const [test, errors] of atrSuppressedErrors) {
          // Do not restore errors for non-ATF quarantined tests — they should stay suppressed
          // so Jest doesn't see the failure (prevents --bail from stopping the run).
          const ctx = testContexts.get(test)
          if (ctx?.isQuarantined && !ctx.isAttemptToFix) {
            const testName = getJestTestName(test)
            quarantinedFailingTests.add(`${ctx.suite} › ${testName}`)
          } else {
            test.errors = errors
          }
        }
        atrSuppressedErrors.clear()

        // In parallel mode, send suppressed quarantine info to the main process
        // so it can include them in the session summary.
        // In runInBand mode, keep the set — it will be consumed by the session-level code directly.
        if (quarantinedFailingTests.size > 0 && sendQuarantineInfoToMainProcess([...quarantinedFailingTests])) {
          quarantinedFailingTests.clear()
        }

        efdDeterminedRetries.clear()
        efdSlowAbortedTests.clear()
        efdNewTestCandidates.clear()
        newTests.clear()
        retriedTestsToNumAttempts.clear()
        attemptToFixRetriedTestsStatuses.clear()
        testsToBeRetried.clear()
      }
      if (event.name === 'test_skip' || event.name === 'test_todo') {
        const testName = getJestTestName(event.test)
        testSkippedCh.publish({
          test: {
            name: testName,
            suite: this.testSuite,
            testSourceFile: this.testSourceFile,
            displayName: this.displayName,
            frameworkVersion: jestVersion,
            testStartLine: getTestLineStart(event.test.asyncError, this.testSuite),
          },
          isDisabled: this.testManagementTestsForThisSuite?.disabled?.includes(testName),
        })
      }
    }

    getEfdResult ({ testName, isNewTest, isModifiedTest, isEfdRetry, numberOfExecutedRetries }) {
      const isEfdEnabled = this.isEarlyFlakeDetectionEnabled
      const isEfdActive = isEfdEnabled && (isNewTest || isModifiedTest)
      const retryCount = efdDeterminedRetries.get(testName) ?? 0
      const isSlowAbort = efdSlowAbortedTests.has(testName)
      const isLastEfdRetry = (isEfdRetry && numberOfExecutedRetries >= (retryCount + 1)) || isSlowAbort
      const isFinalEfdTestExecution = isEfdActive && isLastEfdRetry

      let finalStatus
      if (isEfdActive && isFinalEfdTestExecution) {
        // For EFD: The framework reports 'pass' if ANY attempt passed (flaky but not failing)
        const testStatuses = newTestsTestStatuses.get(testName)
        finalStatus = testStatuses && testStatuses.includes('pass') ? 'pass' : 'fail'
      }

      return { isEfdEnabled, isEfdActive, isFinalEfdTestExecution, finalStatus }
    }

    getAtrResult ({ status, isEfdRetry, isAttemptToFix, numberOfTestInvocations }) {
      const isAtrEnabled =
        this.isFlakyTestRetriesEnabled &&
        !isEfdRetry &&
        !isAttemptToFix &&
        Number.isFinite(this.global[RETRY_TIMES])
      const isLastAtrRetry =
        status === 'pass' || numberOfTestInvocations >= (Number(this.global[RETRY_TIMES]) + 1)
      const isFinalAtrTestExecution = isAtrEnabled && isLastAtrRetry

      // For ATR: The last execution's status is what the framework reports
      return { isAtrEnabled, isFinalAtrTestExecution, finalStatus: status }
    }

    getAttemptToFixResult ({ testName, isAttemptToFix, numberOfExecutedRetries }) {
      const isAttemptToFixEnabled =
        this.isTestManagementTestsEnabled &&
        isAttemptToFix &&
        Number.isFinite(testManagementAttemptToFixRetries)
      const isFinalAttemptToFixExecution = isAttemptToFixEnabled &&
        numberOfExecutedRetries >= (testManagementAttemptToFixRetries + 1)

      let finalStatus
      if (isAttemptToFixEnabled && isFinalAttemptToFixExecution) {
        // For Attempt to Fix: 'pass' only if ALL attempts passed, 'fail' if ANY failed
        const testStatuses = attemptToFixRetriedTestsStatuses.get(testName)
        finalStatus = testStatuses && testStatuses.every(status => status === 'pass') ? 'pass' : 'fail'
      }

      return { isAttemptToFixEnabled, isFinalAttemptToFixExecution, finalStatus }
    }

    getFinalStatus (testName, status, isNewTest, isModifiedTest, isEfdRetry, isAttemptToFix, numberOfTestInvocations) {
      const numberOfExecutedRetries = retriedTestsToNumAttempts.get(testName) ?? 0

      const efdResult = this.getEfdResult({
        testName,
        isNewTest,
        isModifiedTest,
        isEfdRetry,
        numberOfExecutedRetries,
      })
      const atrResult = this.getAtrResult({ status, isEfdRetry, isAttemptToFix, numberOfTestInvocations })
      const attemptToFixResult = this.getAttemptToFixResult({
        testName,
        isAttemptToFix,
        numberOfExecutedRetries,
      })

      // When no retry features are active, every test execution is final
      const noRetryFeaturesActive =
        !efdResult.isEfdActive &&
        !atrResult.isAtrEnabled &&
        !attemptToFixResult.isAttemptToFixEnabled
      const isFinalTestExecution = noRetryFeaturesActive ||
        efdResult.isFinalEfdTestExecution ||
        atrResult.isFinalAtrTestExecution ||
        attemptToFixResult.isFinalAttemptToFixExecution

      if (!isFinalTestExecution) {
        return
      }

      // If the test is quarantined, regardless of its actual execution result,
      // the final status of its last execution should be reported as 'skip'.
      if (!attemptToFixResult.isAttemptToFixEnabled &&
        this.isTestManagementTestsEnabled &&
        this.testManagementTestsForThisSuite?.quarantined?.includes(testName)) {
        return 'skip'
      }

      return efdResult.finalStatus || attemptToFixResult.finalStatus || atrResult.finalStatus
    }

    teardown () {
      if (this._globalProxy?.propertyToValue) {
        for (const [key] of this._globalProxy.propertyToValue) {
          if (typeof key === 'string' && key.startsWith('_dd')) {
            this._globalProxy.propertyToValue.delete(key)
          }
        }
      }
      const clearActiveTestSuite = () => {
        realSetTimeout(() => {
          if (activeTestSuiteAbsolutePath === this.testSuiteAbsolutePath) {
            activeTestSuiteAbsolutePath = undefined
          }
        }, 0)
      }
      const result = super.teardown()
      if (result?.then) {
        return result.finally(clearActiveTestSuite)
      }
      clearActiveTestSuite()
      return result
    }
  }
}

function getTestEnvironment (pkg, jestVersion) {
  if (pkg.default) {
    const wrappedTestEnvironment = getWrappedEnvironment(pkg.default, jestVersion)
    return new Proxy(pkg, {
      get (target, prop) {
        if (prop === 'default') {
          return wrappedTestEnvironment
        }
        if (prop === 'TestEnvironment') {
          return wrappedTestEnvironment
        }
        return target[prop]
      },
    })
  }
  return getWrappedEnvironment(pkg, jestVersion)
}

function getRepositoryRootFromConfig (config, fallbackRootDir) {
  return config?.testEnvironmentOptions?._ddRepositoryRoot || repositoryRoot || fallbackRootDir || process.cwd()
}

function getRepositoryRootFromContexts (contexts, fallbackRootDir) {
  const firstContext = contexts?.[Symbol.iterator]?.().next().value
  return getRepositoryRootFromConfig(firstContext?.config, fallbackRootDir)
}

function getRepositoryRootFromTest (test, fallbackRootDir) {
  return getRepositoryRootFromConfig(test?.context?.config, fallbackRootDir)
}

function getCoverageBackfillRelativeFile (file, rootDir) {
  if (!file || !file.startsWith(rootDir)) return

  const relativeFile = getTestSuitePath(file, rootDir)
  if (
    relativeFile.startsWith('.') ||
    relativeFile.startsWith('node_modules/') ||
    relativeFile.includes('/node_modules/') ||
    !COVERAGE_BACKFILL_SOURCE_FILE_RE.test(relativeFile) ||
    COVERAGE_BACKFILL_DECLARATION_FILE_RE.test(relativeFile)
  ) {
    return
  }

  return relativeFile
}

function getCoverageBackfillFilePattern (file, rootDir) {
  const relativeFile = getCoverageBackfillRelativeFile(file, rootDir)
  if (!relativeFile || COVERAGE_BACKFILL_TEST_FILE_RE.test(relativeFile)) return

  return relativeFile
}

function getCoverageBackfillCoveredFiles (rootDir) {
  const coveredFiles = new Set()
  for (const filename of Object.keys(skippableSuitesCoverage || {})) {
    if (COVERAGE_BACKFILL_HASH_RE.test(filename)) continue

    const relativeFilename = path.isAbsolute(filename)
      ? getTestSuitePath(filename, rootDir)
      : filename
    const absoluteFilename = path.join(rootDir, relativeFilename)
    const coverageFilePattern = getCoverageBackfillFilePattern(absoluteFilename, rootDir)
    if (coverageFilePattern) {
      coveredFiles.add(coverageFilePattern)
    }
  }
  return coveredFiles
}

function getCoverageBackfillCollectCoverageFrom ({
  skippedSuites,
  rootDir,
}) {
  if (!skippedSuites.length) return

  // Backend coverage is an aggregate for the skippable response. Seed every local
  // source file it names so Istanbul can apply covered-line bitmaps to files that
  // did not run in this Jest process.
  const coveredFiles = getCoverageBackfillCoveredFiles(rootDir)
  return coveredFiles.size ? [...coveredFiles] : undefined
}

function getCoverageBackfillAbsoluteFiles (rootDir, contextRootDir) {
  const absoluteFiles = []
  for (const file of coverageBackfillCollectCoverageFrom || []) {
    const absoluteFile = path.join(rootDir, file)
    if (
      absoluteFile.startsWith(contextRootDir) &&
      existsSync(absoluteFile)
    ) {
      absoluteFiles.push(absoluteFile)
    }
  }
  return absoluteFiles
}

function getCoverageBackfillConfig (config) {
  if (!config?.cacheDirectory) return config

  return {
    ...config,
    cacheDirectory: path.join(config.cacheDirectory, 'dd-trace-coverage-backfill'),
  }
}

function extractCoverageDataObject (code) {
  const marker = 'var coverageData = '
  const start = code.indexOf(marker)
  if (start === -1) return

  let depth = 0
  let quote
  let escaped = false
  let index = start + marker.length
  for (; index < code.length; index++) {
    const char = code[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) {
        index++
        break
      }
    }
  }
  if (depth !== 0) return

  try {
    // SWC's coverage plugin emits a plain object literal that istanbul-lib-instrument
    // does not currently recognize via readInitialCoverage.
    // eslint-disable-next-line no-new-func
    return new Function(`return (${code.slice(start + marker.length, index)})`)()
  } catch {}
}

function getCoverageDataFromCode (code, readInitialCoverage) {
  return readInitialCoverage(code)?.coverageData || extractCoverageDataObject(code)
}

async function addCoverageBackfillUntestedFiles (coverageReporter, testContexts, rootDir, CoverageReporter) {
  if (!coverageBackfillCollectCoverageFrom?.length || !coverageReporter?._coverageMap || !rootDir) return

  const coverageWorkerRequire = createRequire(
    `${path.join(path.dirname(CoverageReporter.filename), 'CoverageWorker')}.js`
  )
  const { createScriptTransformer } = coverageWorkerRequire('@jest/transform')
  const { readInitialCoverage } = coverageWorkerRequire('istanbul-lib-instrument')
  const { createFileCoverage } = coverageWorkerRequire('istanbul-lib-coverage')
  const processedFiles = new Set()

  for (const context of testContexts || []) {
    const contextRootDir = context.config?.rootDir || rootDir
    const files = getCoverageBackfillAbsoluteFiles(rootDir, contextRootDir)
    if (files.length === 0) continue

    const config = getCoverageBackfillConfig(context.config)
    // eslint-disable-next-line no-await-in-loop
    const transformer = await createScriptTransformer(config)

    for (const file of files) {
      if (processedFiles.has(file) || coverageReporter._coverageMap.data[file]) continue
      processedFiles.add(file)

      try {
        // eslint-disable-next-line no-await-in-loop
        const { code } = await transformer.transformSourceAsync(file, readFileSync(file, 'utf8'), {
          instrument: true,
          supportsDynamicImport: true,
          supportsExportNamespaceFrom: true,
          supportsStaticESM: true,
          supportsTopLevelAwait: true,
        })
        const coverageData = getCoverageDataFromCode(code, readInitialCoverage)
        if (coverageData) {
          coverageReporter._coverageMap.addFileCoverage(createFileCoverage(coverageData))
        }
      } catch (err) {
        log.warn('Error generating coverage backfill for %s: %s', file, err.message)
      }
    }
  }
}

function applySuiteSkipping (originalTests, rootDir, frameworkVersion) {
  const suitePathRoot = getRepositoryRootFromTest(originalTests[0], rootDir)
  const localSuites = originalTests.map(test => getTestSuitePath(test.path, suitePathRoot))
  const safeSkippableSuites = getSafeSkippableSuites({
    skippableSuites,
    skippedCoverage: skippableSuitesCoverage,
    localSuites,
    isCodeCoverageEnabled,
  })
  let jestSuitesToRun = getJestSuitesToRun(safeSkippableSuites, originalTests, suitePathRoot)
  let coverageBackfillSuites = jestSuitesToRun.skippedSuites
  if (isCodeCoverageEnabled && jestSuitesToRun.suitesToRun.length === 0) {
    // Jest does not run its coverage reporter when zero suites are scheduled. Keep a small
    // anchor sample so setup files and the reporter run, but backfill every skippable suite.
    // TODO: replace this with a fully synthetic coverage-map/reporting path so all skippable
    // suites can be skipped without relying on anchor tests to initialize Jest coverage.
    const anchorSuiteCount = Math.min(COVERAGE_BACKFILL_ANCHOR_SUITE_COUNT, Math.max(1, localSuites.length - 1))
    const anchorSuites = new Set(localSuites.slice(0, anchorSuiteCount))
    const skippableSuitesWithCoverageAnchor = safeSkippableSuites.filter(suite => !anchorSuites.has(suite))
    jestSuitesToRun = getJestSuitesToRun(skippableSuitesWithCoverageAnchor, originalTests, suitePathRoot)
    coverageBackfillSuites = safeSkippableSuites
  }
  hasFilteredSkippableSuites = true
  log.debug('%d out of %d suites are going to run.', jestSuitesToRun.suitesToRun.length, originalTests.length)
  hasUnskippableSuites = jestSuitesToRun.hasUnskippableSuites
  hasForcedToRunSuites = jestSuitesToRun.hasForcedToRunSuites

  const nextCoverageBackfillCollectCoverageFrom = getCoverageBackfillCollectCoverageFrom({
    skippedSuites: coverageBackfillSuites,
    rootDir: suitePathRoot,
  })
  const nextSkippedSuitesCoverage = getSkippedSuitesCoverage({
    skippedSuites: coverageBackfillSuites,
    skippedCoverage: skippableSuitesCoverage,
    isCodeCoverageEnabled,
  })

  isSuitesSkipped = jestSuitesToRun.suitesToRun.length !== originalTests.length
  numSkippedSuites = jestSuitesToRun.skippedSuites.length
  coverageBackfillCollectCoverageFrom = nextCoverageBackfillCollectCoverageFrom
  skippedSuitesCoverage = nextSkippedSuitesCoverage
  writeCoverageBackfillToCache(skippedSuitesCoverage)

  itrSkippedSuitesCh.publish({ skippedSuites: jestSuitesToRun.skippedSuites, frameworkVersion })

  return jestSuitesToRun.suitesToRun
}

function applySkippedCoverageToJestCoverageMap (coverageMap, rootDir) {
  if (!coverageMap || !isSuitesSkipped || !isCodeCoverageEnabled) return
  applySkippedCoverageToCoverage(
    coverageMap,
    skippedSuitesCoverage,
    rootDir || process.cwd()
  )
}

function reporterDispatcherWrapper (reporterDispatcherPackage) {
  const ReporterDispatcher = reporterDispatcherPackage.default ?? reporterDispatcherPackage
  if (ReporterDispatcher?.prototype?.onRunComplete) {
    shimmer.wrap(ReporterDispatcher.prototype, 'onRunComplete', onRunComplete => function (contexts, results) {
      applySkippedCoverageToJestCoverageMap(results?.coverageMap, getRepositoryRootFromContexts(contexts))
      return onRunComplete.apply(this, arguments)
    })
  }

  return reporterDispatcherPackage
}

function wrapCoverageReporter (CoverageReporter) {
  if (!CoverageReporter?.prototype?.onRunComplete || wrappedCoverageReporters.has(CoverageReporter)) {
    return
  }

  wrappedCoverageReporters.add(CoverageReporter)
  if (CoverageReporter.prototype._addUntestedFiles) {
    shimmer.wrap(CoverageReporter.prototype, '_addUntestedFiles', addUntestedFiles => function (...args) {
      if (isCodeCoverageEnabledBecauseOfUs) {
        return Promise.resolve()
      }

      const rootDir = repositoryRoot || this._globalConfig?.rootDir || process.cwd()
      const result = addUntestedFiles.apply(this, args)
      const applyBackfillAndSkippedCoverage = () => {
        return addCoverageBackfillUntestedFiles(this, args[0], rootDir, CoverageReporter).then(() => {
          applySkippedCoverageToJestCoverageMap(this._coverageMap, rootDir)
        })
      }
      if (result?.then) {
        return result.then(value => {
          return applyBackfillAndSkippedCoverage().then(() => value)
        })
      }
      const backfillResult = applyBackfillAndSkippedCoverage()
      if (backfillResult?.then) {
        return backfillResult.then(() => result)
      }
      applySkippedCoverageToJestCoverageMap(this._coverageMap, rootDir)
      return result
    })
  }

  shimmer.wrap(CoverageReporter.prototype, 'onRunComplete', onRunComplete => function (contexts, results) {
    const rootDir = getRepositoryRootFromContexts(contexts, this._globalConfig?.rootDir)
    const coverageMap = results?.coverageMap || this._coverageMap
    applySkippedCoverageToJestCoverageMap(coverageMap, rootDir)
    lastCoverageMap = coverageMap
    lastCoverageMapRootDir = rootDir
    return onRunComplete.apply(this, arguments)
  })
}

function reportersWrapper (reportersPackage) {
  wrapCoverageReporter(reportersPackage.CoverageReporter)
  return reportersPackage
}

function coverageReporterWrapper (coverageReporterPackage) {
  wrapCoverageReporter(coverageReporterPackage.default ?? coverageReporterPackage)
  return coverageReporterPackage
}

addHook({
  name: 'jest-environment-node',
  versions: [MINIMUM_JEST_VERSION],
}, getTestEnvironment)

addHook({
  name: 'jest-environment-jsdom',
  versions: [MINIMUM_JEST_VERSION],
}, getTestEnvironment)

addHook({
  name: '@happy-dom/jest-environment',
  versions: ['>=10.0.0'],
}, getTestEnvironment)

function getWrappedScheduleTests (scheduleTests, frameworkVersion) {
  // `scheduleTests` is an async function
  return function (tests) {
    if (!isSuitesSkippingEnabled || hasFilteredSkippableSuites) {
      return scheduleTests.apply(this, arguments)
    }
    const [test] = tests
    const rootDir = test?.context?.config?.rootDir

    arguments[0] = applySuiteSkipping(tests, rootDir, frameworkVersion)

    return scheduleTests.apply(this, arguments)
  }
}

function getChannelPromise (channelToPublishTo, payload = {}) {
  return new Promise(resolve => {
    channelToPublishTo.publish({ ...payload, onDone: resolve })
  })
}

function searchSourceWrapper (searchSourcePackage, frameworkVersion) {
  const SearchSource = searchSourcePackage.default ?? searchSourcePackage

  shimmer.wrap(SearchSource.prototype, 'getTestPaths', getTestPaths => async function () {
    const testPaths = await getTestPaths.apply(this, arguments)
    const [{ rootDir, shard }] = arguments

    if (isKnownTestsEnabled) {
      const projectSuites = testPaths.tests.map(test => {
        return getTestSuitePath(test.path, getRepositoryRootFromTest(test, test.context.config.rootDir))
      })

      // If the `jest` key does not exist in the known tests response, we consider the Early Flake detection faulty.
      const isFaulty = !knownTests?.jest ||
        getIsFaultyEarlyFlakeDetection(projectSuites, knownTests.jest, earlyFlakeDetectionFaultyThreshold)

      if (isFaulty) {
        log.error('Early flake detection is disabled because the number of new suites is too high.')
        isEarlyFlakeDetectionEnabled = false
        isKnownTestsEnabled = false
        const testEnvironmentOptions = testPaths.tests[0]?.context?.config?.testEnvironmentOptions
        // Project config is shared among all tests, so we can modify it here
        if (testEnvironmentOptions) {
          testEnvironmentOptions._ddIsEarlyFlakeDetectionEnabled = false
          testEnvironmentOptions._ddIsKnownTestsEnabled = false
        }
        isEarlyFlakeDetectionFaulty = true
      }
    }

    if (shard?.shardCount > 1 || !isSuitesSkippingEnabled || !skippableSuites.length) {
      // If the user is using jest sharding, we want to apply the filtering of tests in the shard process.
      // The reason for this is the following:
      // The tests for different shards are likely being run in different CI jobs so
      // the requests to the skippable endpoint might be done at different times and their responses might be different.
      // If the skippable endpoint is returning different suites and we filter the list of tests here,
      // the base list of tests that is used for sharding might be different,
      // causing the shards to potentially run the same suite.
      return testPaths
    }
    const { tests } = testPaths

    const suitesToRun = applySuiteSkipping(tests, rootDir, frameworkVersion)
    return { ...testPaths, tests: suitesToRun }
  })

  return searchSourcePackage
}

function getCliWrapper (isNewJestVersion) {
  return function cliWrapper (cli, jestVersion) {
    warnDeprecatedJestVersion(jestVersion)

    if (isNewJestVersion) {
      cli = shimmer.wrap(
        cli,
        'SearchSource',
        searchSource => searchSourceWrapper(searchSource, jestVersion),
        { replaceGetter: true }
      )
    }
    return shimmer.wrap(cli, 'runCLI', runCLI => async function () {
      let onDone
      if (!libraryConfigurationCh.hasSubscribers) {
        return runCLI.apply(this, arguments)
      }

      try {
        const { err, libraryConfig } = await getChannelPromise(libraryConfigurationCh, {
          frameworkVersion: jestVersion,
        })
        if (!err) {
          isCodeCoverageEnabled = libraryConfig.isCodeCoverageEnabled
          isSuitesSkippingEnabled = libraryConfig.isSuitesSkippingEnabled
          isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
          earlyFlakeDetectionNumRetries = libraryConfig.earlyFlakeDetectionNumRetries
          earlyFlakeDetectionSlowTestRetries = libraryConfig.earlyFlakeDetectionSlowTestRetries ?? {}
          earlyFlakeDetectionFaultyThreshold = libraryConfig.earlyFlakeDetectionFaultyThreshold
          isKnownTestsEnabled = libraryConfig.isKnownTestsEnabled
          isTestManagementTestsEnabled = libraryConfig.isTestManagementEnabled
          testManagementAttemptToFixRetries = libraryConfig.testManagementAttemptToFixRetries
          isImpactedTestsEnabled = libraryConfig.isImpactedTestsEnabled
        }
      } catch (err) {
        log.error('Jest library configuration error', err)
      }

      const {
        knownTestsResponse,
        testManagementTestsResponse,
        skippableSuitesResponse,
      } = await getTestOptimizationRequestResults({
        isKnownTestsEnabled,
        isTestManagementTestsEnabled,
        isSuitesSkippingEnabled,
        getKnownTests: () => getChannelPromise(knownTestsCh),
        getTestManagementTests: () => getChannelPromise(testManagementTestsCh),
        getSkippableSuites: () => getChannelPromise(skippableSuitesCh),
      })

      if (isKnownTestsEnabled) {
        try {
          const { err, knownTests: receivedKnownTests } = knownTestsResponse || await getChannelPromise(knownTestsCh)
          if (err) {
            // We disable EFD if there has been an error in the known tests request
            isEarlyFlakeDetectionEnabled = false
            isKnownTestsEnabled = false
          } else {
            knownTests = receivedKnownTests
          }
        } catch (err) {
          log.error('Jest known tests error', err)
        }
      }

      if (isSuitesSkippingEnabled) {
        try {
          const {
            err,
            skippableSuites: receivedSkippableSuites,
            skippableSuitesCoverage: receivedSkippableSuitesCoverage,
          } = skippableSuitesResponse || await getChannelPromise(skippableSuitesCh)
          if (err) {
            skippableSuitesCoverage = {}
            skippedSuitesCoverage = {}
          } else {
            skippableSuites = receivedSkippableSuites
            skippableSuitesCoverage = receivedSkippableSuitesCoverage || {}
            skippedSuitesCoverage = {}
          }
        } catch (err) {
          log.error('Jest test-suite skippable error', err)
        }
      }

      if (isTestManagementTestsEnabled) {
        try {
          const { err, testManagementTests: receivedTestManagementTests } =
            testManagementTestsResponse || await getChannelPromise(testManagementTestsCh)
          if (err) {
            isTestManagementTestsEnabled = false
            testManagementTests = {}
          } else {
            testManagementTests = receivedTestManagementTests || {}
          }
        } catch (err) {
          log.error('Jest test management tests error', err)
          isTestManagementTestsEnabled = false
        }
      }

      if (isImpactedTestsEnabled) {
        try {
          const { err, modifiedFiles: receivedModifiedFiles } = await getChannelPromise(modifiedFilesCh)
          if (!err) {
            modifiedFiles = receivedModifiedFiles
          }
        } catch (err) {
          log.error('Jest impacted tests error', err)
        }
      }

      const processArgv = process.argv.slice(2).join(' ')
      testSessionStartCh.publish({
        command: `jest ${processArgv}`,
        frameworkVersion: jestVersion,
      })

      const result = await runCLI.apply(this, arguments)

      const {
        results: {
          coverageMap: resultCoverageMap,
          numFailedTestSuites,
          numFailedTests,
          numRuntimeErrorTestSuites = 0,
          numTotalTests,
          numTotalTestSuites,
          runExecError,
          wasInterrupted,
        },
      } = result

      const hasSuiteLevelFailures = numRuntimeErrorTestSuites > 0
      const hasRunLevelFailure = runExecError != null || wasInterrupted === true
      const mustNotFlipSuccess = hasSuiteLevelFailures || hasRunLevelFailure

      let testCodeCoverageLinesTotal
      let testSessionCoverageFiles

      if (isUserCodeCoverageEnabled) {
        try {
          const coverageMap = resultCoverageMap || lastCoverageMap
          const coverageRootDir = repositoryRoot ||
            lastCoverageMapRootDir ||
            result.globalConfig?.rootDir ||
            process.cwd()
          applySkippedCoverageToJestCoverageMap(coverageMap, coverageRootDir)
          testCodeCoverageLinesTotal = getTestCoverageLinesPercentage(
            coverageMap,
            undefined,
            coverageRootDir
          )
          testSessionCoverageFiles = getExecutableFilesFromCoverage(coverageMap).map(({ filename, bitmap }) => ({
            filename: getTestSuitePath(filename, coverageRootDir),
            bitmap,
          }))
        } catch {
          // ignore errors
        }
      }

      /**
       * If Early Flake Detection (EFD) is enabled the logic is as follows:
       * - If all attempts for a test are failing, the test has failed and we will let the test process fail.
       * - If just a single attempt passes, we will prevent the test process from failing.
       * The rationale behind is the following: you may still be able to block your CI pipeline by gating
       * on flakiness (the test will be considered flaky), but you may choose to unblock the pipeline too.
       */
      let numEfdFailedTestsToIgnore = 0
      const efdIgnoredNames = []
      const quarantineIgnoredNames = []

      // Build fullName -> suite map from results (for EFD display)
      const fullNameToSuite = new Map()
      for (const { testResults, testFilePath } of result.results.testResults) {
        const suite = getTestSuitePath(testFilePath, result.globalConfig.rootDir)
        for (const { fullName } of testResults) {
          const name = removeSeedSuffixFromTestName(fullName)
          fullNameToSuite.set(name, suite)
        }
      }

      /** @type {{ efdNames: string[], quarantineNames: string[], totalCount: number } | undefined} */
      let ignoredFailuresSummary
      if (isEarlyFlakeDetectionEnabled) {
        for (const [testName, testStatuses] of newTestsTestStatuses) {
          const { pass, fail } = getTestStats(testStatuses)
          if (pass > 0) { // as long as one passes, we'll consider the test passed
            numEfdFailedTestsToIgnore += fail
            const suite = fullNameToSuite.get(testName)
            efdIgnoredNames.push(suite ? `${suite} › ${testName}` : testName)
          }
        }
        // If every test that failed was an EFD retry, we'll consider the suite passed
        if (
          !mustNotFlipSuccess &&
          numEfdFailedTestsToIgnore !== 0 &&
          result.results.numFailedTests === numEfdFailedTestsToIgnore
        ) {
          result.results.success = true
          ignoredFailuresSummary = {
            efdNames: efdIgnoredNames,
            quarantineNames: [],
            totalCount: numEfdFailedTestsToIgnore,
          }
        }
      }

      let numFailedQuarantinedTests = 0
      let numSuppressedQuarantinedTests = 0
      if (isTestManagementTestsEnabled) {
        const failedTests = result
          .results
          .testResults.flatMap(({ testResults, testFilePath: testSuiteAbsolutePath }) => (
            testResults.map(({ fullName: testName, status }) => (
              {
                // Strip seed suffix so the name matches what was reported via TEST_NAME.
                testName: removeSeedSuffixFromTestName(testName),
                testSuiteAbsolutePath,
                status,
              }
            ))
          ))
          .filter(({ status }) => status === 'failed')

        for (const { testName, testSuiteAbsolutePath } of failedTests) {
          const testSuite = getTestSuitePath(testSuiteAbsolutePath, result.globalConfig.rootDir)
          const testManagementTest = testManagementTests
            ?.jest
            ?.suites
            ?.[testSuite]
            ?.tests
            ?.[testName]
            ?.properties
          if (testManagementTest?.quarantined && !testManagementTest?.attempt_to_fix) {
            numFailedQuarantinedTests++
            quarantineIgnoredNames.push(`${testSuite} › ${testName}`)
          }
        }

        // Include quarantined tests whose errors were suppressed at test_done time.
        // These tests don't appear as failed in Jest's results because their errors were cleared
        // to prevent --bail from stopping the run, but they should still be counted for the summary.
        for (const name of quarantinedFailingTests) {
          if (!quarantineIgnoredNames.includes(name)) {
            numSuppressedQuarantinedTests++
            quarantineIgnoredNames.push(name)
          }
        }
        quarantinedFailingTests.clear()

        // If every test that failed was quarantined, we'll consider the suite passed
        // Attempt-to-fix tests ignore quarantine/disabled suppression and keep their framework result.
        // Skip if EFD block already flipped (to avoid logging twice)
        // Only use visible failures (from Jest results) for the flip check.
        // Suppressed quarantine failures are not in numFailedTests.
        const visibleQuarantineFailures = numFailedQuarantinedTests
        if (
          !result.results.success &&
          !mustNotFlipSuccess &&
          visibleQuarantineFailures !== 0 &&
          result.results.numFailedTests === visibleQuarantineFailures
        ) {
          result.results.success = true
        }

        const totalQuarantineFailures = visibleQuarantineFailures + numSuppressedQuarantinedTests
        if (totalQuarantineFailures > 0) {
          if (ignoredFailuresSummary) {
            ignoredFailuresSummary.quarantineNames = quarantineIgnoredNames
            ignoredFailuresSummary.totalCount += totalQuarantineFailures
          } else {
            ignoredFailuresSummary = {
              efdNames: [],
              quarantineNames: quarantineIgnoredNames,
              totalCount: totalQuarantineFailures,
            }
          }
        }
      }

      // Combined check: if all failed tests are accounted for by EFD (flaky retries) and/or quarantine,
      // we should consider the suite passed even when neither check alone covers all failures.
      // Only visible failures (in Jest results) are compared — suppressed quarantine failures
      // are already removed from numFailedTests at test_done time.
      if (
        !result.results.success &&
        !mustNotFlipSuccess &&
        (isEarlyFlakeDetectionEnabled || isTestManagementTestsEnabled)
      ) {
        const visibleIgnoredFailures =
          numEfdFailedTestsToIgnore + numFailedQuarantinedTests
        if (
          visibleIgnoredFailures !== 0 &&
          result.results.numFailedTests === visibleIgnoredFailures
        ) {
          result.results.success = true
          ignoredFailuresSummary = {
            efdNames: efdIgnoredNames,
            quarantineNames: quarantineIgnoredNames,
            totalCount: visibleIgnoredFailures + numSuppressedQuarantinedTests,
          }
        }
      }

      // Determine session status after EFD and quarantine checks have potentially modified success
      let status, error
      if (result.results.success) {
        status = numTotalTests === 0 && numTotalTestSuites === 0 ? 'skip' : 'pass'
      } else {
        status = 'fail'
        error = new Error(`Failed test suites: ${numFailedTestSuites}. Failed tests: ${numFailedTests}`)
      }

      let timeoutId

      // Pass the resolve callback to defer it to DC listener
      const flushPromise = new Promise((resolve) => {
        onDone = () => {
          clearTimeout(timeoutId)
          resolve()
        }
      })

      const timeoutPromise = new Promise((resolve) => {
        timeoutId = realSetTimeout(() => {
          resolve('timeout')
        }, FLUSH_TIMEOUT)
        timeoutId.unref?.()
      })

      testSessionFinishCh.publish({
        status,
        isSuitesSkipped,
        isSuitesSkippingEnabled,
        isCodeCoverageEnabled,
        testCodeCoverageLinesTotal,
        testSessionCoverageFiles,
        numSkippedSuites,
        hasUnskippableSuites,
        hasForcedToRunSuites,
        error,
        isEarlyFlakeDetectionEnabled,
        isEarlyFlakeDetectionFaulty,
        isTestManagementTestsEnabled,
        onDone,
      })

      const waitingResult = await Promise.race([flushPromise, timeoutPromise])

      if (waitingResult === 'timeout') {
        log.error('Timeout waiting for the tracer to flush')
      }

      if (codeCoverageReportCh.hasSubscribers) {
        const rootDir = result.globalConfig?.rootDir || process.cwd()
        await new Promise((resolve) => {
          codeCoverageReportCh.publish({ rootDir, onDone: resolve })
        })
      }

      logSessionSummary(ignoredFailuresSummary, getAttemptToFixExecutionsFromJestResults(result))

      numSkippedSuites = 0
      lastCoverageMap = undefined
      lastCoverageMapRootDir = undefined
      coverageBackfillCollectCoverageFrom = undefined

      return result
    }, {
      replaceGetter: true,
    })
  }
}

function shouldWaitForTestSuiteFinish (environment) {
  return isJestWorker && environment.globalConfig?.workerIdleMemoryLimit !== undefined
}

function publishTestSuiteFinish (payload, waitForFinish) {
  if (!testSuiteFinishCh.hasSubscribers) return

  if (!waitForFinish) {
    testSuiteFinishCh.publish(payload)
    return
  }

  return new Promise(resolve => {
    testSuiteFinishCh.publish({
      ...payload,
      waitForFinish,
      onDone: resolve,
    })
  })
}

function cleanupTestSuiteState (testSuiteAbsolutePath) {
  testSuiteMockedFiles.delete(testSuiteAbsolutePath)
  testSuiteJestObjects.delete(testSuiteAbsolutePath)
}

addHook({
  name: '@jest/core',
  file: 'build/TestScheduler.js',
  versions: [MINIMUM_JEST_TEST_SCHEDULER_VERSION],
}, (testSchedulerPackage, frameworkVersion) => {
  const oldCreateTestScheduler = testSchedulerPackage.createTestScheduler
  const newCreateTestScheduler = async function () {
    if (!isSuitesSkippingEnabled || hasFilteredSkippableSuites) {
      return oldCreateTestScheduler.apply(this, arguments)
    }
    // If suite skipping is enabled and has not filtered skippable suites yet, we'll attempt to do it
    const scheduler = await oldCreateTestScheduler.apply(this, arguments)
    shimmer.wrap(scheduler, 'scheduleTests', scheduleTests => getWrappedScheduleTests(scheduleTests, frameworkVersion))
    return scheduler
  }
  testSchedulerPackage.createTestScheduler = newCreateTestScheduler
  return testSchedulerPackage
})

if (DD_MAJOR < 6) {
  addHook({
    name: '@jest/core',
    file: 'build/TestScheduler.js',
    versions: ['>=24.8.0 <27.0.0'],
  }, (testSchedulerPackage, frameworkVersion) => {
    shimmer.wrap(
      testSchedulerPackage.default.prototype,
      'scheduleTests', scheduleTests => getWrappedScheduleTests(scheduleTests, frameworkVersion)
    )
    return testSchedulerPackage
  })
}

addHook({
  name: '@jest/test-sequencer',
  versions: ['>=28'],
}, (sequencerPackage, frameworkVersion) => {
  shimmer.wrap(sequencerPackage.default.prototype, 'shard', shard => function (...args) {
    const shardedTests = shard.apply(this, args)

    if (!shardedTests.length || !isSuitesSkippingEnabled || !skippableSuites.length) {
      return shardedTests
    }
    const [test] = shardedTests
    const rootDir = test?.context?.config?.rootDir

    return applySuiteSkipping(shardedTests, rootDir, frameworkVersion)
  })
  return sequencerPackage
})

function jestRunWrapper (jestPackage) {
  const pkg = jestPackage.default ?? jestPackage
  if (pkg?.run) {
    shimmer.wrap(pkg, 'run', run => function (argv) {
      void argv
      return run.apply(this, arguments)
    }, { replaceGetter: true })
  }
  return jestPackage
}

addHook({
  name: 'jest',
  versions: [MINIMUM_JEST_VERSION],
}, jestRunWrapper)

addHook({
  name: 'jest-cli',
  versions: [MINIMUM_JEST_VERSION],
}, jestRunWrapper)

addHook({
  name: '@jest/core',
  file: 'build/cli/index.js',
  versions: [MINIMUM_JEST_VERSION_BEFORE_30],
}, getCliWrapper(false))

addHook({
  name: '@jest/core',
  versions: ['>=30.0.0'],
}, getCliWrapper(true))

addHook({
  name: '@jest/core',
  file: 'build/ReporterDispatcher.js',
  versions: [MINIMUM_JEST_VERSION],
}, reporterDispatcherWrapper)

addHook({
  name: '@jest/reporters',
  versions: [MINIMUM_JEST_VERSION],
}, reportersWrapper)

addHook({
  name: '@jest/reporters',
  file: 'build/CoverageReporter.js',
  versions: [MINIMUM_JEST_VERSION],
}, coverageReporterWrapper)

function jestAdapterWrapper (jestAdapter, jestVersion) {
  const adapter = jestAdapter.default ?? jestAdapter
  const newAdapter = shimmer.wrapFunction(adapter, adapter => function (...args) {
    const environment = args[2]
    if (!environment || !environment.testEnvironmentOptions) {
      return adapter.apply(this, args)
    }
    testSuiteStartCh.publish({
      testSuite: environment.testSuite,
      testEnvironmentOptions: environment.testEnvironmentOptions,
      testSourceFile: environment.testSourceFile,
      displayName: environment.displayName,
      frameworkVersion: jestVersion,
      testSuiteAbsolutePath: environment.testSuiteAbsolutePath,
    })
    return adapter.apply(this, args).then(suiteResults => {
      const { numFailingTests, skipped, failureMessage: errorMessage } = suiteResults
      let status = 'pass'
      if (skipped) {
        status = 'skipped'
      } else if (numFailingTests !== 0) {
        status = 'fail'
      }

      /**
       * Child processes do not each request ITR configuration, so the jest's parent process
       * needs to pass them the configuration. This is done via _ddTestCodeCoverageEnabled, which
       * controls whether coverage is reported.
       */
      if (environment.testEnvironmentOptions?._ddTestCodeCoverageEnabled) {
        const root = environment.repositoryRoot || environment.rootDir

        const getFilesWithPath = (files) => files.map(file => {
          if (typeof file === 'string') {
            return getTestSuitePath(file, root)
          }
          return {
            ...file,
            filename: getTestSuitePath(file.filename, root),
          }
        })

        const coverageFiles = getFilesWithPath(getCoveredFilesFromCoverage(environment.global.__coverage__))
        const mockedFiles = getFilesWithPath(getMockedFiles(environment.testSuiteAbsolutePath))

        testSuiteCodeCoverageCh.publish({
          coverageFiles,
          testSuite: environment.testSourceFile,
          mockedFiles,
          testSuiteAbsolutePath: environment.testSuiteAbsolutePath,
        })
      }
      const waitForFinish = shouldWaitForTestSuiteFinish(environment)
      const finishPayload = {
        status,
        errorMessage,
        testSuiteAbsolutePath: environment.testSuiteAbsolutePath,
      }
      if (waitForFinish) {
        const finishPromise = publishTestSuiteFinish(finishPayload, waitForFinish)
        if (finishPromise) {
          return finishPromise.then(() => {
            // Cleanup per-suite state to avoid memory leaks
            cleanupTestSuiteState(environment.testSuiteAbsolutePath)

            return suiteResults
          })
        }
      }
      publishTestSuiteFinish(finishPayload, waitForFinish)

      // Cleanup per-suite state to avoid memory leaks
      cleanupTestSuiteState(environment.testSuiteAbsolutePath)

      return suiteResults
    }).catch(error => {
      const waitForFinish = shouldWaitForTestSuiteFinish(environment)
      const finishPayload = {
        status: 'fail',
        error,
        testSuiteAbsolutePath: environment.testSuiteAbsolutePath,
      }
      if (waitForFinish) {
        const finishPromise = publishTestSuiteFinish(finishPayload, waitForFinish)
        if (finishPromise) {
          return finishPromise.then(() => {
            // Cleanup per-suite state to avoid memory leaks
            cleanupTestSuiteState(environment.testSuiteAbsolutePath)

            throw error
          })
        }
      }
      publishTestSuiteFinish(finishPayload, waitForFinish)

      // Cleanup per-suite state to avoid memory leaks
      cleanupTestSuiteState(environment.testSuiteAbsolutePath)

      throw error
    })
  })
  if (jestAdapter.default) {
    jestAdapter.default = newAdapter
  } else {
    jestAdapter = newAdapter
  }

  return jestAdapter
}

addHook({
  name: 'jest-circus',
  file: 'build/runner.js',
  versions: ['>=30.0.0'],
}, jestAdapterWrapper)

addHook({
  name: 'jest-circus',
  file: 'build/legacy-code-todo-rewrite/jestAdapter.js',
  versions: [MINIMUM_JEST_VERSION],
}, jestAdapterWrapper)

function configureTestEnvironment (readConfigsResult) {
  repositoryRoot = getJestRepositoryRoot(readConfigsResult)
  isUserCodeCoverageEnabled = !!readConfigsResult.globalConfig.collectCoverage
  const { configs } = readConfigsResult
  testSessionConfigurationCh.publish(configs.map(config => config.testEnvironmentOptions))
  // We can't directly use isCodeCoverageEnabled when reporting coverage in `jestAdapterWrapper`
  // because `jestAdapterWrapper` runs in a different process. We have to go through `testEnvironmentOptions`
  for (const config of configs) {
    config.testEnvironmentOptions._ddRepositoryRoot = repositoryRoot
    config.testEnvironmentOptions._ddTestCodeCoverageEnabled = isCodeCoverageEnabled
  }

  isCodeCoverageEnabledBecauseOfUs = isCodeCoverageEnabled && !isUserCodeCoverageEnabled

  if (readConfigsResult.globalConfig.forceExit) {
    log.warn("Jest's '--forceExit' flag has been passed. This may cause loss of data.")
  }

  if (isCodeCoverageEnabledBecauseOfUs) {
    const globalConfig = {
      ...readConfigsResult.globalConfig,
      collectCoverage: true,
    }
    readConfigsResult.globalConfig = globalConfig
  }
  if (isSuitesSkippingEnabled) {
    // If suite skipping is enabled, we pass `passWithNoTests` in case every test gets skipped.
    const globalConfig = {
      ...readConfigsResult.globalConfig,
      passWithNoTests: true,
    }
    readConfigsResult.globalConfig = globalConfig
  }

  return readConfigsResult
}

function jestConfigAsyncWrapper (jestConfig) {
  return shimmer.wrap(jestConfig, 'readConfigs', readConfigs => async function () {
    const readConfigsResult = await readConfigs.apply(this, arguments)
    configureTestEnvironment(readConfigsResult)
    return readConfigsResult
  })
}

function jestConfigSyncWrapper (jestConfig) {
  return shimmer.wrap(jestConfig, 'readConfigs', readConfigs => function (...args) {
    const readConfigsResult = readConfigs.apply(this, args)
    configureTestEnvironment(readConfigsResult)
    return readConfigsResult
  })
}

const DD_TEST_ENVIRONMENT_OPTION_KEYS = [
  '_ddTestModuleId',
  '_ddTestSessionId',
  '_ddTestCommand',
  '_ddTestSessionName',
  '_ddForcedToRun',
  '_ddUnskippable',
  '_ddItrCorrelationId',
  '_ddKnownTests',
  '_ddIsEarlyFlakeDetectionEnabled',
  '_ddEarlyFlakeDetectionSlowTestRetries',
  '_ddRepositoryRoot',
  '_ddIsFlakyTestRetriesEnabled',
  '_ddFlakyTestRetriesCount',
  '_ddItrSkippingEnabledTags',
  '_ddIsDiEnabled',
  '_ddIsKnownTestsEnabled',
  '_ddIsTestManagementTestsEnabled',
  '_ddTestManagementTests',
  '_ddTestManagementAttemptToFixRetries',
  '_ddModifiedFiles',
]

function removeDatadogTestEnvironmentOptions (testEnvironmentOptions) {
  const removedEntries = []

  for (const key of DD_TEST_ENVIRONMENT_OPTION_KEYS) {
    if (!Object.hasOwn(testEnvironmentOptions, key)) {
      continue
    }

    removedEntries.push([key, testEnvironmentOptions[key]])
    delete testEnvironmentOptions[key]
  }

  return function restoreDatadogTestEnvironmentOptions () {
    for (const [key, value] of removedEntries) {
      testEnvironmentOptions[key] = value
    }
  }
}

/**
 * Wrap `createScriptTransformer` to temporarily hide Datadog-specific
 * `testEnvironmentOptions` keys while Jest builds its transform config.
 *
 * @param {Function} createScriptTransformer
 * @returns {Function}
 */
function wrapCreateScriptTransformer (createScriptTransformer) {
  return function (config) {
    const testEnvironmentOptions = config?.testEnvironmentOptions

    if (!testEnvironmentOptions) {
      return createScriptTransformer.apply(this, arguments)
    }

    const restoreTestEnvironmentOptions = removeDatadogTestEnvironmentOptions(testEnvironmentOptions)

    try {
      const result = createScriptTransformer.apply(this, arguments)

      if (result?.then) {
        return result.finally(restoreTestEnvironmentOptions)
      }

      restoreTestEnvironmentOptions()
      return result
    } catch (e) {
      restoreTestEnvironmentOptions()
      throw e
    }
  }
}

addHook({
  name: '@jest/transform',
  versions: [MINIMUM_JEST_VERSION_BEFORE_30],
  file: 'build/ScriptTransformer.js',
}, transformPackage => {
  transformPackage.createScriptTransformer = wrapCreateScriptTransformer(transformPackage.createScriptTransformer)

  return transformPackage
})

addHook({
  name: '@jest/transform',
  versions: ['>=30.0.0'],
}, transformPackage => {
  return shimmer.wrap(transformPackage, 'createScriptTransformer', wrapCreateScriptTransformer, { replaceGetter: true })
})

/**
 * Hook to remove the test paths (test suite) that are part of `skippableSuites`
 */
addHook({
  name: '@jest/core',
  versions: [MINIMUM_JEST_VERSION_BEFORE_30],
  file: 'build/SearchSource.js',
}, searchSourceWrapper)

// from 25.1.0 on, readConfigs becomes async
addHook({
  name: 'jest-config',
  versions: [MINIMUM_JEST_CONFIG_ASYNC_VERSION],
}, jestConfigAsyncWrapper)

if (DD_MAJOR < 6) {
  addHook({
    name: 'jest-config',
    versions: ['24.8.0 - 24.9.0'],
  }, jestConfigSyncWrapper)
}

const LIBRARIES_BYPASSING_JEST_REQUIRE_ENGINE = new Set([
  'selenium-webdriver',
  'selenium-webdriver/chrome',
  'selenium-webdriver/edge',
  'selenium-webdriver/safari',
  'selenium-webdriver/firefox',
  'selenium-webdriver/ie',
  'selenium-webdriver/chromium',
  'winston',
])

function recordMockedFile (suiteFilePath, moduleName) {
  if (!suiteFilePath || typeof moduleName !== 'string') return

  const existingMockedFiles = testSuiteMockedFiles.get(suiteFilePath) || []
  const suiteDir = path.dirname(suiteFilePath)
  const mockPath = path.resolve(suiteDir, moduleName)
  existingMockedFiles.push(mockPath)
  testSuiteMockedFiles.set(suiteFilePath, existingMockedFiles)
}

const JEST_STATIC_MOCK_CALL_RE = /\bjest\.(?:mock|doMock|unstable_mockModule)\(\s*(['"`])([^'"`]+)\1/g

function getStaticMockedFiles (suiteFilePath) {
  if (!suiteFilePath) return []

  const mockedFiles = []
  try {
    const source = readFileSync(suiteFilePath, 'utf8')
    let match
    JEST_STATIC_MOCK_CALL_RE.lastIndex = 0
    while ((match = JEST_STATIC_MOCK_CALL_RE.exec(source)) !== null) {
      mockedFiles.push(path.resolve(path.dirname(suiteFilePath), match[2]))
    }
  } catch {
    // ignore errors
  }

  return mockedFiles
}

function getMockedFiles (suiteFilePath) {
  const mockedFiles = testSuiteMockedFiles.get(suiteFilePath)
  const staticMockedFiles = getStaticMockedFiles(suiteFilePath)

  if (mockedFiles?.length) {
    return [...new Set([...mockedFiles, ...staticMockedFiles])]
  }
  return staticMockedFiles
}

function wrapJestObject (jestObject, suiteFilePath) {
  if (!jestObject || !suiteFilePath || wrappedJestObjects.has(jestObject)) return

  testSuiteJestObjects.set(suiteFilePath, jestObject)
  wrappedJestObjects.add(jestObject)

  shimmer.wrap(jestObject, 'mock', mock => function (moduleName) {
    // If the library is mocked with `jest.mock`, we don't want to bypass jest's own require engine
    if (LIBRARIES_BYPASSING_JEST_REQUIRE_ENGINE.has(moduleName)) {
      LIBRARIES_BYPASSING_JEST_REQUIRE_ENGINE.delete(moduleName)
    }
    recordMockedFile(suiteFilePath, moduleName)
    return mock.apply(this, arguments)
  })
}

function wrapJestGlobalsForRuntime (runtime) {
  const jestGlobals = runtime?.jestGlobals
  if (!jestGlobals || wrappedJestGlobals.has(jestGlobals) || typeof jestGlobals.jestObjectFor !== 'function') {
    return
  }

  wrappedJestGlobals.add(jestGlobals)
  shimmer.wrap(jestGlobals, 'jestObjectFor', jestObjectFor => function (from) {
    const jestObject = jestObjectFor.apply(this, arguments)
    wrapJestObject(jestObject, from)
    return jestObject
  })
}

function getLastLoggedReferenceError (runtime) {
  const loggedReferenceErrors = runtime?.loggedReferenceErrors
  if (!loggedReferenceErrors?.size) return
  return [...loggedReferenceErrors].pop()
}

function publishRuntimeReferenceError (runtime, errorMessage) {
  if (!errorMessage || !runtime?._testPath) return

  let publishedErrors = publishedRuntimeReferenceErrors.get(runtime)
  if (!publishedErrors) {
    publishedErrors = new Set()
    publishedRuntimeReferenceErrors.set(runtime, publishedErrors)
  }
  if (publishedErrors.has(errorMessage)) return

  publishedErrors.add(errorMessage)
  testSuiteErrorCh.publish({
    errorMessage,
    testSuiteAbsolutePath: runtime._testPath,
  })
}

function isBetweenTestsReferenceError (error) {
  return error?.name === 'ReferenceError' &&
    typeof error.message === 'string' &&
    error.message.includes('outside of the scope of the test code')
}

function reportBetweenTestsReferenceError (runtime, moduleName, originalErrorMessage) {
  if (typeof moduleName !== 'string') return false

  const fallbackErrorMessage = moduleName.startsWith('node:') || builtinModules.includes(moduleName)
    ? 'You are trying to access a Node.js module outside of the scope of the test code.'
    : 'You are trying to `require` a file after the Jest environment has been torn down.'
  const errorMessage = originalErrorMessage || fallbackErrorMessage

  if (typeof runtime._logFormattedReferenceError === 'function') {
    runtime._logFormattedReferenceError(errorMessage)
  }
  publishRuntimeReferenceError(runtime, getLastLoggedReferenceError(runtime) || errorMessage)
  process.exitCode = 1
  return true
}

function requireOutsideJestRequireEngine (runtime, moduleName) {
  if (typeof runtime._requireCoreModule === 'function') {
    return runtime._requireCoreModule(moduleName)
  }
  return require(moduleName)
}

function formatDefaultStackTrace (error, structuredStackTrace) {
  const errorString = Error.prototype.toString.call(error)
  if (structuredStackTrace.length === 0) return errorString

  return `${errorString}\n    at ${structuredStackTrace.join('\n    at ')}`
}

addHook({
  name: 'jest-runtime',
  versions: [MINIMUM_JEST_VERSION],
}, (runtimePackage) => {
  const Runtime = runtimePackage.default ?? runtimePackage

  if (typeof Runtime.prototype._createJestObjectFor === 'function') {
    shimmer.wrap(Runtime.prototype, '_createJestObjectFor', _createJestObjectFor => function (from) {
      const result = _createJestObjectFor.apply(this, arguments)
      const suiteFilePath = this._testPath || from

      wrapJestObject(result, suiteFilePath)
      return result
    })
  }

  shimmer.wrap(Runtime.prototype, 'requireModule', requireModule => function (from, moduleName) {
    wrapJestGlobalsForRuntime(this)
    try {
      return requireModule.apply(this, arguments)
    } catch (error) {
      if (isBetweenTestsReferenceError(error)) {
        reportBetweenTestsReferenceError(this, moduleName, error.message)
      }
      throw error
    }
  })

  shimmer.wrap(Runtime.prototype, 'requireModuleOrMock', requireModuleOrMock => function (from, moduleName) {
    wrapJestGlobalsForRuntime(this)
    // `requireModuleOrMock` may log errors to the console. If we don't remove ourselves
    // from the stack trace, the user might see a useless stack trace rather than the error
    // that `jest` tries to show.
    const originalPrepareStackTrace = Error.prepareStackTrace
    Error.prepareStackTrace = function (error, structuredStackTrace) {
      const filteredStackTrace = structuredStackTrace
        .filter(callSite => !callSite.getFileName()?.includes('datadog-instrumentations/src/jest.js'))

      if (typeof originalPrepareStackTrace === 'function') {
        return originalPrepareStackTrace(error, filteredStackTrace)
      }
      return formatDefaultStackTrace(error, filteredStackTrace)
    }
    try {
      // TODO: do this for every library that we instrument
      if (LIBRARIES_BYPASSING_JEST_REQUIRE_ENGINE.has(moduleName)) {
        // To bypass jest's own require engine
        return requireOutsideJestRequireEngine(this, moduleName)
      }
      let returnedValue
      try {
        returnedValue = requireModuleOrMock.apply(this, arguments)
      } catch (error) {
        if (isBetweenTestsReferenceError(error)) {
          reportBetweenTestsReferenceError(this, moduleName, error.message)
        }
        throw error
      }
      if (process.exitCode === 1) {
        publishRuntimeReferenceError(
          this,
          getLastLoggedReferenceError(this) || 'An error occurred while importing a module'
        )
      }
      return returnedValue
    } finally {
      // Restore original prepareStackTrace
      Error.prepareStackTrace = originalPrepareStackTrace
    }
  })

  if (Runtime.prototype._logFormattedReferenceError) {
    shimmer.wrap(Runtime.prototype, '_logFormattedReferenceError', logFormattedReferenceError => function () {
      // eslint-disable-next-line no-console
      const originalConsoleError = console.error
      let loggedReferenceError
      // eslint-disable-next-line no-console
      console.error = function () {
        loggedReferenceError = arguments[0]
        return originalConsoleError.apply(this, arguments)
      }
      try {
        const result = logFormattedReferenceError.apply(this, arguments)
        publishRuntimeReferenceError(this, getLastLoggedReferenceError(this) || loggedReferenceError)
        return result
      } finally {
        // eslint-disable-next-line no-console
        console.error = originalConsoleError
      }
    })
  }

  return runtimePackage
})

function onMessageWrapper (onMessage) {
  return function (...args) {
    const response = args[0]
    if (!Array.isArray(response)) {
      return onMessage.apply(this, args)
    }

    const [code, data] = response
    if (code === JEST_WORKER_TRACE_PAYLOAD_CODE) { // datadog trace payload
      collectDynamicNamesFromTraces(data, newTestsWithDynamicNames)
      workerReportTraceCh.publish(data)
      return
    }
    if (code === JEST_WORKER_COVERAGE_PAYLOAD_CODE) { // datadog coverage payload
      workerReportCoverageCh.publish(data)
      return
    }
    if (code === JEST_WORKER_LOGS_PAYLOAD_CODE) { // datadog logs payload
      workerReportLogsCh.publish(data)
      return
    }
    if (code === JEST_WORKER_TELEMETRY_PAYLOAD_CODE) { // datadog telemetry payload
      workerReportTelemetryCh.publish(data)
      return
    }
    if (code === JEST_WORKER_QUARANTINE_PAYLOAD_CODE) { // quarantined test failures suppressed in worker
      for (const name of JSON.parse(data)) {
        quarantinedFailingTests.add(name)
      }
      return
    }
    return onMessage.apply(this, args)
  }
}

function sendWrapper (send) {
  return function (request) {
    if (!isKnownTestsEnabled && !isTestManagementTestsEnabled && !isImpactedTestsEnabled) {
      return send.apply(this, arguments)
    }
    const [type] = request

    // https://github.com/jestjs/jest/blob/1d682f21c7a35da4d3ab3a1436a357b980ebd0fa/packages/jest-worker/src/workers/ChildProcessWorker.ts#L424
    if (type === CHILD_MESSAGE_CALL) {
      // This is the message that the main process sends to the worker to run a test suite (=test file).
      // In here we modify the `config.testEnvironmentOptions` to include the known tests for the suite.
      // This way the suite only knows about the tests that are part of it.
      const args = request.at(-1)
      if (args.length > 1) {
        return send.apply(this, arguments)
      }
      if (!args[0]?.config) {
        return send.apply(this, arguments)
      }
      const [{ globalConfig, config, path: testSuiteAbsolutePath }] = args
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, globalConfig.rootDir || process.cwd())
      const suiteKnownTests = knownTests?.jest?.[testSuite] || []

      const suiteTestManagementTests = testManagementTests?.jest?.suites?.[testSuite]?.tests || {}

      args[0].config = {
        ...config,
        testEnvironmentOptions: {
          ...config.testEnvironmentOptions,
          _ddKnownTests: suiteKnownTests,
          _ddTestManagementTests: suiteTestManagementTests,
          // TODO: figure out if we can reduce the size of the modified files object
          // Can we use `testSuite` (it'd have to be relative to repository root though)
          _ddModifiedFiles: modifiedFiles,
        },
      }
    }
    return send.apply(this, arguments)
  }
}

function wrapWorkerChannel (worker) {
  const workerChannel = worker._child || worker._worker
  if (!workerChannel) return

  shimmer.wrap(workerChannel, worker._child ? 'send' : 'postMessage', sendWrapper)
}

function wrapWorkerInitializer (worker) {
  if (wrappedWorkerInitializers.has(worker) || typeof worker.initialize !== 'function') return

  wrappedWorkerInitializers.add(worker)
  shimmer.wrap(worker, 'initialize', initialize => function () {
    const result = initialize.apply(this, arguments)
    wrapWorkerChannel(this)
    return result
  })
}

function wrapWorker (worker) {
  // ChildProcessWorker uses _child (child_process), ExperimentalWorker uses _worker (worker_threads)
  const workerChannel = worker._child || worker._worker
  if (!workerChannel) return

  wrapWorkerInitializer(worker)
  wrapWorkerChannel(worker)
  shimmer.wrap(worker, '_onMessage', onMessageWrapper)
  workerChannel.removeAllListeners('message')
  workerChannel.on('message', worker._onMessage.bind(worker))
}

function enqueueWrapper (enqueue) {
  return function (...args) {
    shimmer.wrap(args[0], 'onStart', onStart => function (worker) {
      if (worker) {
        const currentChannel = worker._child || worker._worker
        const previousChannel = wrappedWorkerChannels.get(worker)
        if (currentChannel !== previousChannel) {
          if (previousChannel) {
            // Worker restarted — only re-wrap the new child's send/postMessage
            wrapWorkerChannel(worker)
          } else {
            // First time seeing this worker — full setup
            wrapWorker(worker)
          }
          wrappedWorkerChannels.set(worker, currentChannel)
        }
      }
      return onStart.apply(this, arguments)
    })
    return enqueue.apply(this, args)
  }
}

/*
* This hook does three things:
* - Pass known tests to the workers.
* - Pass test management tests to the workers.
* - Receive trace, coverage and logs payloads from the workers.
*/
addHook({
  name: 'jest-worker',
  versions: [MINIMUM_JEST_WORKER_VERSION_BEFORE_30],
  file: 'build/workers/ChildProcessWorker.js',
}, (childProcessWorker) => {
  const ChildProcessWorker = childProcessWorker.default
  shimmer.wrap(ChildProcessWorker.prototype, 'send', sendWrapper)
  if (ChildProcessWorker.prototype._onMessage) {
    shimmer.wrap(ChildProcessWorker.prototype, '_onMessage', onMessageWrapper)
  } else if (ChildProcessWorker.prototype.onMessage) {
    shimmer.wrap(ChildProcessWorker.prototype, 'onMessage', onMessageWrapper)
  }
  return childProcessWorker
})

addHook({
  name: 'jest-worker',
  versions: [MINIMUM_JEST_WORKER_VERSION_BEFORE_30],
  file: 'build/workers/NodeThreadsWorker.js',
}, (nodeThreadsWorker) => {
  const ExperimentalWorker = nodeThreadsWorker.default
  shimmer.wrap(ExperimentalWorker.prototype, 'send', sendWrapper)
  if (ExperimentalWorker.prototype._onMessage) {
    shimmer.wrap(ExperimentalWorker.prototype, '_onMessage', onMessageWrapper)
  } else if (ExperimentalWorker.prototype.onMessage) {
    shimmer.wrap(ExperimentalWorker.prototype, 'onMessage', onMessageWrapper)
  }
  return nodeThreadsWorker
})

addHook({
  name: 'jest-worker',
  versions: ['>=30.0.0'],
}, (jestWorkerPackage) => {
  shimmer.wrap(jestWorkerPackage.FifoQueue.prototype, 'enqueue', enqueueWrapper)
  shimmer.wrap(jestWorkerPackage.PriorityQueue.prototype, 'enqueue', enqueueWrapper)
  return jestWorkerPackage
})
