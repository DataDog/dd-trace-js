'use strict'

const shimmer = require('../../../datadog-shimmer')
const log = require('../../../dd-trace/src/log')
const {
  getTestLineStart,
  getTestSuitePath,
  getTestParametersString,
  getTestEndLine,
  isModifiedTest,
} = require('../../../dd-trace/src/plugins/util/test')
const {
  getFormattedJestTestParameters,
  getJestTestName,
  getJestSuitesToRun,
  getEfdRetryCount,
} = require('../../../datadog-plugin-jest/src/util')
const { addHook } = require('../helpers/instrument')
const {
  testStartCh,
  testSkippedCh,
  testFinishCh,
  testErrCh,
  testFnCh,
  testSuiteHookFnCh,
  itrSkippedSuitesCh,
  RETRY_TIMES,
  BREAKPOINT_HIT_GRACE_PERIOD_MS,
  ATR_RETRY_SUPPRESSION_FLAG,
} = require('./channels')
const {
  state,
  testContexts,
  originalTestFns,
  originalHookFns,
  retriedTestsToNumAttempts,
  newTestsTestStatuses,
  attemptToFixRetriedTestsStatuses,
  testsToBeRetried,
  efdDeterminedRetries,
  efdSlowAbortedTests,
  efdNewTestCandidates,
  testSuiteAbsolutePathsWithFastCheck,
  testSuiteJestObjects,
  atrSuppressedErrors,
  newTestsWithDynamicNames,
} = require('./state')

// Matches patterns that are almost certainly runtime-generated values in test names:
// - Unix timestamps in ms (13 digits, years ~2020-2090) or s (10 digits)
// - UUIDs (8-4-4-4-12 hex)
// - ISO 8601 date-times (2024-03-23T14:30)
// - Random localhost ports (localhost:12345)
const DYNAMIC_NAME_RE = new RegExp(
  String.raw`\b1[6-9]\d{8,11}\b|` +
  String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|` +
  String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|` +
  String.raw`localhost:\d{4,5}\b`,
  'i'
)

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

function getTestEnvironmentOptions (config) {
  if (config.projectConfig && config.projectConfig.testEnvironmentOptions) { // newer versions
    return config.projectConfig.testEnvironmentOptions
  }
  if (config.testEnvironmentOptions) {
    return config.testEnvironmentOptions
  }
  return {}
}

function getWrappedEnvironment (BaseEnvironment, jestVersion) {
  return class DatadogEnvironment extends BaseEnvironment {
    constructor (config, context) {
      super(config, context)
      const rootDir = config.globalConfig ? config.globalConfig.rootDir : config.rootDir
      this.rootDir = rootDir
      this.testSuite = getTestSuitePath(context.testPath, rootDir)
      this.nameToParams = {}
      this.global._ddtrace = global._ddtrace
      this.hasSnapshotTests = undefined
      this.testSuiteAbsolutePath = context.testPath

      this.displayName = config.projectConfig?.displayName?.name || config.displayName
      this.testEnvironmentOptions = getTestEnvironmentOptions(config)

      const repositoryRoot = this.testEnvironmentOptions._ddRepositoryRoot

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

      this._initKnownTests()
      this._initFlakyTestRetries()
      this._initTestManagement()
      this._initImpactedTests()
    }

    _initKnownTests () {
      if (!this.isKnownTestsEnabled) return

      state.earlyFlakeDetectionSlowTestRetries =
        this.testEnvironmentOptions._ddEarlyFlakeDetectionSlowTestRetries ?? {}
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

    _initFlakyTestRetries () {
      if (!this.isFlakyTestRetriesEnabled) return

      const currentNumRetries = this.global[RETRY_TIMES]
      if (!currentNumRetries) {
        this.global[RETRY_TIMES] = this.flakyTestRetriesCount
      }
    }

    _initTestManagement () {
      if (!this.isTestManagementTestsEnabled) return

      try {
        const hasTestManagementTests = !!state.testManagementTests?.jest
        state.testManagementAttemptToFixRetries =
          this.testEnvironmentOptions._ddTestManagementAttemptToFixRetries
        this.testManagementTestsForThisSuite = hasTestManagementTests
          ? this.getTestManagementTestsForSuite(
            state.testManagementTests?.jest?.suites?.[this.testSuite]?.tests
          )
          : this.getTestManagementTestsForSuite(this.testEnvironmentOptions._ddTestManagementTests)
      } catch (e) {
        log.error('Error parsing test management tests', e)
        this.isTestManagementTestsEnabled = false
      }
    }

    _initImpactedTests () {
      if (!this.isImpactedTestsEnabled) return

      try {
        const hasImpactedTests = Object.keys(state.modifiedFiles).length > 0
        this.modifiedFiles = hasImpactedTests ? state.modifiedFiles : this.testEnvironmentOptions._ddModifiedFiles
      } catch (e) {
        log.error('Error parsing impacted tests', e)
        this.isImpactedTestsEnabled = false
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
      if (state.knownTests?.jest) {
        return state.knownTests.jest[this.testSuite] || []
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

    getShouldStripSeedFromTestName () {
      return testSuiteAbsolutePathsWithFastCheck.has(this.testSuiteAbsolutePath)
    }

    // At the `add_test` event we don't have the test object yet, so we can't use it
    getTestNameFromAddTestEvent (event, circusState) {
      const describeSuffix = getJestTestName(
        circusState.currentDescribeBlock, this.getShouldStripSeedFromTestName()
      )
      return describeSuffix ? `${describeSuffix} ${event.testName}` : event.testName
    }

    async handleTestEvent (event, circusState) {
      if (super.handleTestEvent) {
        await super.handleTestEvent(event, circusState)
      }

      switch (event.name) {
        case 'setup':
          return this._onSetup(event)
        case 'test_start':
          return this._onTestStart(event, circusState)
        case 'hook_start':
          return this._onHookStart(event)
        case 'add_test':
          return this._onAddTest(event, circusState)
        case 'test_done':
          return this._onTestDone(event, circusState)
        case 'run_finish':
          return this._onRunFinish()
        case 'test_skip':
        case 'test_todo':
          return this._onTestSkip(event)
      }
    }

    _onSetup (event) {
      if (!this.global.test) return

      const setNameToParams = (name, params) => { this.nameToParams[name] = [...params] }

      shimmer.wrap(this.global.test, 'each', each => function () {
        const testParameters = getFormattedJestTestParameters(arguments)
        const eachBind = each.apply(this, arguments)
        return function () {
          const [testName] = arguments
          setNameToParams(testName, testParameters)
          return eachBind.apply(this, arguments)
        }
      })
    }

    _onTestStart (event, circusState) {
      const testName = getJestTestName(event.test, this.getShouldStripSeedFromTestName())
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
        isNewTest = retriedTestsToNumAttempts.has(testName)
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

      testStartCh.runStores(ctx, () => this._wrapTestAndHookFns(event, ctx))
    }

    _wrapTestAndHookFns (event, ctx) {
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
        const newHookFn = shimmer.wrapFunction(hookFn, hookFn => function () {
          return testFnCh.runStores(ctx, () => hookFn.apply(this, arguments))
        })
        hook.fn = newHookFn
      }
      const originalFn = event.test.fn
      originalTestFns.set(event.test, originalFn)

      const newFn = shimmer.wrapFunction(event.test.fn, testFn => function () {
        return testFnCh.runStores(ctx, () => testFn.apply(this, arguments))
      })

      event.test.fn = newFn
    }

    _onHookStart (event) {
      if (event.hook.type !== 'beforeAll' && event.hook.type !== 'afterAll') return

      const ctx = { testSuiteAbsolutePath: this.testSuiteAbsolutePath }
      let hookFn = event.hook.fn
      if (originalHookFns.has(event.hook)) {
        hookFn = originalHookFns.get(event.hook)
      } else {
        originalHookFns.set(event.hook, hookFn)
      }
      event.hook.fn = shimmer.wrapFunction(hookFn, hookFn => function () {
        return testSuiteHookFnCh.runStores(ctx, () => hookFn.apply(this, arguments))
      })
    }

    _onAddTest (event, circusState) {
      if (event.failing) {
        return
      }

      const testFullName = this.getTestNameFromAddTestEvent(event, circusState)
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
          retryCount: state.testManagementAttemptToFixRetries,
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
            retryCount: state.earlyFlakeDetectionNumRetries,
            retryType: 'Impacted tests',
          })
        }
      }
      if (!isAttemptToFix && this.isKnownTestsEnabled) {
        const isNew = !this.knownTestsForThisSuite.includes(testFullName)
        if (isNew && !isSkipped && !retriedTestsToNumAttempts.has(testFullName)) {
          if (DYNAMIC_NAME_RE.test(testFullName)) {
            // Populated directly for runInBand; for parallel workers the main process
            // collects these from the _dd.has_dynamic_name span tag via worker-report:trace.
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

    _getTestResult (event) {
      let status = 'pass'
      if (event.test.errors?.length) {
        status = 'fail'
      }
      return { status, originalError: event.test?.errors?.[0] }
    }

    // If ATR retry is being suppressed for this test (due to EFD or Attempt to Fix taking precedence)
    // and the test has errors for this attempt, store the errors temporarily and clear them
    // so Jest won't treat this attempt as failed (the real status will be reported after retries).
    _suppressAtrErrors (event) {
      if (event.test?.[ATR_RETRY_SUPPRESSION_FLAG] && event.test.errors?.length) {
        atrSuppressedErrors.set(event.test, event.test.errors)
        event.test.errors = []
      }
    }

    _processAttemptToFixStatus (testName, status) {
      const result = {
        isAttemptToFix: false,
        attemptToFixPassed: false,
        attemptToFixFailed: false,
        failedAllAttemptToFix: false,
      }

      if (!this.isTestManagementTestsEnabled) return result

      result.isAttemptToFix = this.testManagementTestsForThisSuite?.attemptToFix?.includes(testName)
      if (!result.isAttemptToFix) return result

      if (attemptToFixRetriedTestsStatuses.has(testName)) {
        attemptToFixRetriedTestsStatuses.get(testName).push(status)
      } else {
        attemptToFixRetriedTestsStatuses.set(testName, [status])
      }
      const testStatuses = attemptToFixRetriedTestsStatuses.get(testName)
      // Check if this is the last attempt to fix.
      // If it is, we'll set the failedAllAttemptToFix flag to true if all the tests failed
      // If all tests passed, we'll set the attemptToFixPassed flag to true
      if (testStatuses.length === state.testManagementAttemptToFixRetries + 1) {
        if (testStatuses.includes('fail')) {
          result.attemptToFixFailed = true
        }
        if (testStatuses.every(s => s === 'fail')) {
          result.failedAllAttemptToFix = true
        } else if (testStatuses.every(s => s === 'pass')) {
          result.attemptToFixPassed = true
        }
      }

      return result
    }

    // EFD dynamic cloning: on first execution of a new EFD candidate,
    // determine the retry count from the test's duration.
    _scheduleEfdRetries (event, circusState, testName) {
      if (
        !this.isEarlyFlakeDetectionEnabled ||
        !this.isKnownTestsEnabled ||
        !efdNewTestCandidates.has(testName) ||
        event.test.invocations !== 1 ||
        efdDeterminedRetries.has(testName)
      ) {
        return
      }

      const durationMs = event.test.duration ?? 0
      const retryCount = getEfdRetryCount(durationMs, state.earlyFlakeDetectionSlowTestRetries)
      efdDeterminedRetries.set(testName, retryCount)
      if (retryCount > 0) {
        // Temporarily adjust jest-circus state so that retry tests are registered
        // into the correct describe block and bypass the "tests have started" guard.
        //
        // Problem 1 (jest-circus <=24): currentDescribeBlock points to ROOT during
        // execution, and ROOT's tests loop already finished before children ran.
        //
        // Problem 2 (jest-circus >=27): `hasStarted = true` causes `test()` to throw
        // "Cannot add a test after tests have started running".
        //
        // Fix: temporarily point currentDescribeBlock to the test's parent (so retries
        // land in the still-iterating children array) and set hasStarted = false (so the
        // guard is bypassed). Both are restored immediately after scheduling the retries.
        const originalDescribeBlock = circusState.currentDescribeBlock
        const originalHasStarted = circusState.hasStarted
        circusState.currentDescribeBlock = event.test.parent ?? originalDescribeBlock
        circusState.hasStarted = false
        this.retryTest({
          jestEvent: {
            testName: event.test.name,
            fn: event.test.fn,
            timeout: event.test.timeout,
          },
          retryCount,
          retryType: 'Early flake detection',
        })
        circusState.currentDescribeBlock = originalDescribeBlock
        circusState.hasStarted = originalHasStarted
      } else {
        efdSlowAbortedTests.add(testName)
      }
    }

    _processEfdStatus (testName, status) {
      const result = { isEfdRetry: false, failedAllEfd: false }

      if (!this.isKnownTestsEnabled) return result

      const isNewTest = retriedTestsToNumAttempts.has(testName)
      if (!isNewTest) return result

      if (newTestsTestStatuses.has(testName)) {
        newTestsTestStatuses.get(testName).push(status)
        result.isEfdRetry = true
      } else {
        newTestsTestStatuses.set(testName, [status])
      }
      const testStatuses = newTestsTestStatuses.get(testName)
      // Check if this is the last EFD retry.
      // If it is, we'll set the failedAllEfd flag to true if all the tests failed
      const efdRetryCount = efdDeterminedRetries.get(testName) ?? 0
      if (efdRetryCount > 0 && testStatuses.length === efdRetryCount + 1 &&
        testStatuses.every(s => s === 'fail')) {
        result.failedAllEfd = true
      }

      return result
    }

    // ATR: check if all auto test retries were exhausted and every attempt failed
    _checkAtrExhausted (event, status, isAttemptToFix, isEfdRetry) {
      if (!this.isFlakyTestRetriesEnabled || isAttemptToFix || isEfdRetry) return false

      const maxRetries = Number(this.global[RETRY_TIMES]) || 0
      return event.test?.invocations === maxRetries + 1 && status === 'fail'
    }

    async _onTestDone (event, circusState) {
      const { status, originalError } = this._getTestResult(event)
      // restore in case it is retried
      event.test.fn = originalTestFns.get(event.test)
      this._suppressAtrErrors(event)

      const testName = getJestTestName(event.test, this.getShouldStripSeedFromTestName())

      const atf = this._processAttemptToFixStatus(testName, status)
      this._scheduleEfdRetries(event, circusState, testName)
      const efd = this._processEfdStatus(testName, status)
      const failedAllAtr = this._checkAtrExhausted(event, status, atf.isAttemptToFix, efd.isEfdRetry)

      const failedAllTests = atf.failedAllAttemptToFix || efd.failedAllEfd || failedAllAtr

      const promises = {}
      const numRetries = this.global[RETRY_TIMES]
      const numTestExecutions = event.test?.invocations
      const willBeRetriedByFailedTestReplay = numRetries > 0 && numTestExecutions - 1 < numRetries
      const mightHitBreakpoint = this.isDiEnabled && numTestExecutions >= 2

      const ctx = testContexts.get(event.test)
      if (!ctx) {
        log.warn('"ci:jest:test_done": no context found for test "%s"', testName)
        return
      }

      const finalStatus = this.getFinalStatus(testName,
        status,
        !!ctx.isNew,
        !!ctx.isModified,
        efd.isEfdRetry,
        atf.isAttemptToFix,
        numTestExecutions)

      if (status === 'fail') {
        const shouldSetProbe = this.isDiEnabled && willBeRetriedByFailedTestReplay && numTestExecutions === 1
        testErrCh.publish({
          ...ctx.currentStore,
          error: formatJestError(originalError),
          shouldSetProbe,
          promises,
          finalStatus,
        })
      }

      // After finishing it might take a bit for the snapshot to be handled.
      // This means that tests retried with DI are BREAKPOINT_HIT_GRACE_PERIOD_MS slower at least.
      if (status === 'fail' && mightHitBreakpoint) {
        await new Promise(resolve => {
          setTimeout(() => {
            resolve()
          }, BREAKPOINT_HIT_GRACE_PERIOD_MS)
        })
      }

      let isAtrRetry = false
      if (this.isFlakyTestRetriesEnabled && event.test?.invocations > 1 &&
        !atf.isAttemptToFix && !efd.isEfdRetry) {
        isAtrRetry = true
      }

      testFinishCh.publish({
        ...ctx.currentStore,
        status,
        testStartLine: getTestLineStart(event.test.asyncError, this.testSuite),
        attemptToFixPassed: atf.attemptToFixPassed,
        failedAllTests,
        attemptToFixFailed: atf.attemptToFixFailed,
        isAtrRetry,
        finalStatus,
        earlyFlakeAbortReason: efdSlowAbortedTests.has(testName) ? 'slow' : undefined,
      })

      if (promises.isProbeReady) {
        await promises.isProbeReady
      }
    }

    _onRunFinish () {
      for (const [test, errors] of atrSuppressedErrors) {
        test.errors = errors
      }
      atrSuppressedErrors.clear()
      efdDeterminedRetries.clear()
      efdSlowAbortedTests.clear()
      efdNewTestCandidates.clear()
      retriedTestsToNumAttempts.clear()
      attemptToFixRetriedTestsStatuses.clear()
      testsToBeRetried.clear()
    }

    _onTestSkip (event) {
      const testName = getJestTestName(event.test, this.getShouldStripSeedFromTestName())
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
        Number.isFinite(state.testManagementAttemptToFixRetries)
      const isFinalAttemptToFixExecution = isAttemptToFixEnabled &&
        numberOfExecutedRetries >= (state.testManagementAttemptToFixRetries + 1)

      let finalStatus
      if (isAttemptToFixEnabled && isFinalAttemptToFixExecution) {
        // For Attempt to Fix: 'pass' only if ALL attempts passed, 'fail' if ANY failed
        const testStatuses = attemptToFixRetriedTestsStatuses.get(testName)
        finalStatus = testStatuses && testStatuses.every(s => s === 'pass') ? 'pass' : 'fail'
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
      if (this.isTestManagementTestsEnabled &&
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
      return super.teardown()
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

function applySuiteSkipping (originalTests, rootDir, frameworkVersion) {
  const jestSuitesToRun = getJestSuitesToRun(state.skippableSuites, originalTests, rootDir || process.cwd())
  state.hasFilteredSkippableSuites = true
  log.debug('%d out of %d suites are going to run.', jestSuitesToRun.suitesToRun.length, originalTests.length)
  state.hasUnskippableSuites = jestSuitesToRun.hasUnskippableSuites
  state.hasForcedToRunSuites = jestSuitesToRun.hasForcedToRunSuites

  state.isSuitesSkipped = jestSuitesToRun.suitesToRun.length !== originalTests.length
  state.numSkippedSuites = jestSuitesToRun.skippedSuites.length

  itrSkippedSuitesCh.publish({ skippedSuites: jestSuitesToRun.skippedSuites, frameworkVersion })

  return jestSuitesToRun.suitesToRun
}

addHook({
  name: 'jest-environment-node',
  versions: ['>=24.8.0'],
}, getTestEnvironment)

addHook({
  name: 'jest-environment-jsdom',
  versions: ['>=24.8.0'],
}, getTestEnvironment)

addHook({
  name: '@happy-dom/jest-environment',
  versions: ['>=10.0.0'],
}, getTestEnvironment)

module.exports = { applySuiteSkipping }
