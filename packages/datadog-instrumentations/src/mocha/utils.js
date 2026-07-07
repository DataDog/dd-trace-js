'use strict'

const { performance } = require('node:perf_hooks')

const {
  getTestSuitePath,
  DYNAMIC_NAME_RE,
  getEfdRetryCount,
  getMaxEfdRetryCount,
  recordAttemptToFixExecution,
  logAttemptToFixTestExecution,
} = require('../../../dd-trace/src/plugins/util/test')
const { channel } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

// test channels
const testStartCh = channel('ci:mocha:test:start')
const testFinishCh = channel('ci:mocha:test:finish')
const testDiWaitCh = channel('ci:mocha:test:di:wait')
// after a test has failed, we'll publish to this channel
const testRetryCh = channel('ci:mocha:test:retry')
const errorCh = channel('ci:mocha:test:error')
const skipCh = channel('ci:mocha:test:skip')
const testFnCh = channel('ci:mocha:test:fn')
const isModifiedCh = channel('ci:mocha:test:is-modified')
// suite channels
const testSuiteErrorCh = channel('ci:mocha:test-suite:error')

const testToContext = new WeakMap()
const originalFns = new WeakMap()
const testToStartLine = new WeakMap()
const testFileToSuiteCtx = new Map()
const wrappedFunctions = new WeakSet()
const newTests = {}
const efdTests = {}
const newTestsWithDynamicNames = new Set()
const testsAttemptToFix = new Set()
const testsQuarantined = new Set()
const testsStatuses = new Map()
const efdRetryCountByTestFullName = new Map()
const efdSlowAbortedTests = new Set()
const attemptToFixExecutions = new Map()

function waitForHitProbe () {
  const promises = {}
  testDiWaitCh.publish({ promises })
  return promises.hitBreakpointPromise
}
const loggedAttemptToFixTests = new Set()

function getAfterEachHooks (testOrHook) {
  const hooks = []

  while (testOrHook.parent) {
    if (testOrHook.parent._afterEach) {
      hooks.push(...testOrHook.parent._afterEach)
    }
    testOrHook = testOrHook.parent
  }
  return hooks
}

function getTestProperties (test, testManagementTests) {
  const testSuite = getTestSuitePath(test.file, process.cwd())
  const testName = test.fullTitle()

  const { attempt_to_fix: isAttemptToFix, disabled: isDisabled, quarantined: isQuarantined } =
    testManagementTests?.mocha?.suites?.[testSuite]?.tests?.[testName]?.properties || {}

  return { isAttemptToFix, isDisabled, isQuarantined }
}

function isNewTest (test, knownTests) {
  if (!knownTests?.mocha) { // invalid response, so we won't consider it as new
    return false
  }
  const testSuite = getTestSuitePath(test.file, process.cwd())
  const testName = test.fullTitle()
  const testsForSuite = knownTests.mocha?.[testSuite] || []
  return !testsForSuite.includes(testName)
}

function setEfdRetryCountForTest (test, duration, slowTestRetries) {
  const testName = getTestFullName(test)
  if (efdRetryCountByTestFullName.has(testName)) {
    return
  }
  const retryCount = getEfdRetryCount(duration, slowTestRetries || {})
  efdRetryCountByTestFullName.set(testName, retryCount)
  if (retryCount === 0) {
    efdSlowAbortedTests.add(testName)
  }
}

function wrapOriginalEfdTest (test, slowTestRetries) {
  if (test._ddEfdDurationWrapped || typeof test.fn !== 'function') {
    return
  }
  test._ddEfdDurationWrapped = true
  const originalFn = test.fn
  test.fn = shimmer.wrapFunction(originalFn, originalFn => function () {
    const start = performance.now()
    const recordDuration = () => {
      setEfdRetryCountForTest(test, performance.now() - start, slowTestRetries)
    }

    if (originalFn.length > 0) {
      const args = Array.prototype.slice.call(arguments)
      args[0] = shimmer.wrapFunction(args[0], done => function (...args) {
        recordDuration()
        return done.apply(this, args)
      })
      return originalFn.apply(this, args)
    }

    try {
      const result = originalFn.apply(this, arguments)
      if (result?.then) {
        return result.then(value => {
          recordDuration()
          return value
        }, error => {
          recordDuration()
          throw error
        })
      }
      recordDuration()
      return result
    } catch (error) {
      recordDuration()
      throw error
    }
  })
}

/**
 * Disables Mocha's native retry mechanism for Datadog-managed clone retries.
 * @param {{ retries?: (count: number) => void }} test
 * @returns {void}
 */
function disableMochaRetries (test) {
  if (typeof test.retries === 'function') {
    test.retries(0)
  }
}

/**
 * Checks whether a runnable belongs to a Datadog-managed clone retry feature.
 * @param {{
 *   _ddIsAttemptToFix?: boolean,
 *   _ddIsEfdRetry?: boolean,
 *   _ddIsModified?: boolean,
 *   _ddIsNew?: boolean
 * }} test
 * @param {{ isEarlyFlakeDetectionEnabled?: boolean }} config
 * @returns {boolean}
 */
function isDatadogManagedRetryTest (test, config) {
  return test._ddIsAttemptToFix ||
    test._ddIsEfdRetry ||
    (config.isEarlyFlakeDetectionEnabled && (test._ddIsNew || test._ddIsModified))
}

/**
 * Checks whether a runnable belongs to an Early Flake Detection execution.
 * @param {{
 *   _ddIsAttemptToFix?: boolean,
 *   _ddIsEfdRetry?: boolean,
 *   _ddIsModified?: boolean,
 *   _ddIsNew?: boolean
 * }} test
 * @param {{ isEarlyFlakeDetectionEnabled?: boolean }} config
 * @returns {boolean}
 */
function isEarlyFlakeDetectionTest (test, config) {
  return !test._ddIsAttemptToFix &&
    config.isEarlyFlakeDetectionEnabled &&
    (test._ddIsEfdRetry || test._ddIsNew || test._ddIsModified)
}

function retryTest (test, numRetries, tags, slowTestRetries) {
  const suite = test.parent
  const isEfdRetry = tags.includes('_ddIsEfdRetry')
  disableMochaRetries(test)
  if (isEfdRetry) {
    wrapOriginalEfdTest(test, slowTestRetries)
  }
  for (let retryIndex = 0; retryIndex < numRetries; retryIndex++) {
    const clonedTest = test.clone()
    disableMochaRetries(clonedTest)
    suite.addTest(clonedTest)
    if (isEfdRetry) {
      clonedTest._ddEfdRetryIndex = retryIndex + 1
      const originalFn = clonedTest.fn
      if (typeof originalFn === 'function') {
        clonedTest.fn = shimmer.wrapFunction(originalFn, originalFn => function (...args) {
          const efdRetryCount = efdRetryCountByTestFullName.get(getTestFullName(clonedTest))
          if (efdRetryCount !== undefined && clonedTest._ddEfdRetryIndex > efdRetryCount) {
            clonedTest._ddShouldSkipEfdRetry = true
            this.skip()
          }
          return originalFn.apply(this, args)
        })
      }
    }
    for (const tag of tags) {
      if (tag) {
        clonedTest[tag] = true
      }
    }
  }
}

function getConfiguredEfdRetryCount (config) {
  const { earlyFlakeDetectionSlowTestRetries } = config
  if (!earlyFlakeDetectionSlowTestRetries || !Object.keys(earlyFlakeDetectionSlowTestRetries).length) {
    return config.earlyFlakeDetectionNumRetries
  }
  return getMaxEfdRetryCount(earlyFlakeDetectionSlowTestRetries)
}

function getSuitesByTestFile (root) {
  const suitesByTestFile = {}
  function getSuites (suite) {
    if (suite.file) {
      if (suitesByTestFile[suite.file]) {
        suitesByTestFile[suite.file].push(suite)
      } else {
        suitesByTestFile[suite.file] = [suite]
      }
    }
    // eslint-disable-next-line unicorn/no-array-for-each
    suite.suites.forEach(suite => {
      getSuites(suite)
    })
  }
  getSuites(root)

  const numSuitesByTestFile = Object.keys(suitesByTestFile).reduce((acc, testFile) => {
    acc[testFile] = suitesByTestFile[testFile].length
    return acc
  }, {})

  return { suitesByTestFile, numSuitesByTestFile }
}

function isMochaRetry (test) {
  return test._currentRetry !== undefined && test._currentRetry !== 0
}

function getIsLastRetry (test) {
  return test._currentRetry === test._retries
}

function getTestFullName (test) {
  return `mocha.${getTestSuitePath(test.file, process.cwd())}.${test.fullTitle()}`
}

/**
 * Records every attempt for a test grouped by its full test name.
 * @param {Record<string, Array<{ file: string, fullTitle: () => string }>>} testsByFullName
 * @param {{ file: string, fullTitle: () => string }} test
 * @returns {void}
 */
function recordTestAttempt (testsByFullName, test) {
  const testFullName = getTestFullName(test)
  if (testsByFullName[testFullName]) {
    testsByFullName[testFullName].push(test)
  } else {
    testsByFullName[testFullName] = [test]
  }
}

function getTestStatus (test) {
  if (test.isPending()) {
    return 'skip'
  }
  if (test.isFailed() || test.timedOut) {
    return 'fail'
  }
  return 'pass'
}

function getTestToContextKey (test) {
  if (!test.fn) {
    return test
  }
  if (!wrappedFunctions.has(test.fn)) {
    return test.fn
  }
  return originalFns.get(test.fn)
}

function getTestContext (test) {
  const key = getTestToContextKey(test)
  return testToContext.get(key)
}

/**
 * Copies Test Management metadata from Mocha's original runnable to its native retry clone.
 * @param {{
 *   _retriedTest?: {
 *     _ddIsDisabled?: boolean,
 *     _ddIsQuarantined?: boolean
 *   },
 *   _ddIsDisabled?: boolean,
 *   _ddIsQuarantined?: boolean
 * }} test
 */
function inheritDatadogPropertiesFromRetriedTest (test) {
  const retriedTest = test._retriedTest
  if (!retriedTest) return

  if (retriedTest._ddIsDisabled) {
    test._ddIsDisabled = true
  }
  if (retriedTest._ddIsQuarantined) {
    test._ddIsQuarantined = true
  }

  if (test._ddIsQuarantined && !test._ddIsAttemptToFix) {
    testsQuarantined.add(test)
  }
}

function runnableWrapper (RunnablePackage, libraryConfig) {
  shimmer.wrap(RunnablePackage.prototype, 'run', run => function (...args) {
    if (!testFinishCh.hasSubscribers) {
      return run.apply(this, args)
    }
    // The reason why the wrapping logic is here is because we need to cover
    // `afterEach` and `beforeEach` hooks as well.
    // It can't be done in `getOnTestHandler` because it's only called for tests.
    const isBeforeEach = this.parent._beforeEach.includes(this)
    const isAfterEach = this.parent._afterEach.includes(this)

    const isTestHook = isBeforeEach || isAfterEach
    const test = isTestHook ? this.ctx.currentTest : this

    // we restore the original user defined function
    if (wrappedFunctions.has(this.fn)) {
      const originalFn = originalFns.get(this.fn)
      this.fn = originalFn
      wrappedFunctions.delete(this.fn)
    }

    if (isDatadogManagedRetryTest(test, libraryConfig)) {
      disableMochaRetries(this)
      if (typeof args[0] === 'function') {
        const onRunnableFinished = args[0]
        args[0] = function () {
          disableMochaRetries(test)
          return onRunnableFinished.apply(this, arguments)
        }
      }
    } else if (libraryConfig?.isFlakyTestRetriesEnabled) {
      this.retries(libraryConfig.flakyTestRetriesCount)
    }

    if (isTestHook || this.type === 'test') {
      const ctx = getTestContext(test)

      if (ctx) {
        // we bind the test fn to the correct context
        const newFn = shimmer.wrapFunction(this.fn, originalFn => function (...args) {
          return testFnCh.runStores(ctx, () => originalFn.apply(this, args))
        })

        // we store the original function, not to lose it
        originalFns.set(newFn, this.fn)
        this.fn = newFn

        wrappedFunctions.add(this.fn)
      }
    }

    return run.apply(this, args)
  })
  return RunnablePackage
}

function getOnTestHandler (isMain) {
  return function (test) {
    const testStartLine = testToStartLine.get(test)

    // This may be a retry. If this is the case, `test.fn` is already wrapped,
    // so we need to restore it.
    if (wrappedFunctions.has(test.fn)) {
      const originalFn = originalFns.get(test.fn)
      test.fn = originalFn
      wrappedFunctions.delete(test.fn)
    }

    inheritDatadogPropertiesFromRetriedTest(test)

    const {
      file: testSuiteAbsolutePath,
      title,
      _ddIsNew: isNew,
      _ddIsEfdRetry: isEfdRetry,
      _ddIsAttemptToFix: isAttemptToFix,
      _ddIsDisabled: isDisabled,
      _ddIsQuarantined: isQuarantined,
      _ddIsModified: isModified,
    } = test

    test._ddStartTime = performance.now()

    if (isEfdRetry) {
      const efdRetryCount = efdRetryCountByTestFullName.get(getTestFullName(test))
      if (efdRetryCount !== undefined && test._ddEfdRetryIndex > efdRetryCount) {
        test.pending = true
        test._ddShouldSkipEfdRetry = true
        return
      }
    }

    const testInfo = {
      testName: test.fullTitle(),
      testSuiteAbsolutePath,
      title,
      testStartLine,
    }

    if (!isMain) {
      testInfo.isParallel = true
    }

    testInfo.isNew = isNew
    testInfo.isEfdRetry = isEfdRetry
    testInfo.isAttemptToFix = isAttemptToFix
    testInfo.isDisabled = isDisabled
    testInfo.isQuarantined = isQuarantined
    testInfo.isModified = isModified
    testInfo.hasDynamicName = isNew && DYNAMIC_NAME_RE.test(test.fullTitle())
    if (testInfo.hasDynamicName) {
      newTestsWithDynamicNames.add(`${getTestSuitePath(test.file, process.cwd())} › ${test.fullTitle()}`)
    }
    if (isAttemptToFix) {
      logAttemptToFixTestExecution(
        getTestSuitePath(test.file, process.cwd()),
        test.fullTitle(),
        loggedAttemptToFixTests
      )
    }
    // We want to store the result of the new tests
    if (isNew) {
      recordTestAttempt(newTests, test)
    }
    if (!isAttemptToFix && (isNew || isModified)) {
      recordTestAttempt(efdTests, test)
    }

    if (!isAttemptToFix && isDisabled) {
      test.pending = true
    }

    const ctx = testInfo
    testToContext.set(test.fn, ctx)
    testStartCh.runStores(ctx, () => {})
  }
}

function getFinalStatus ({
  status,
  hasFailedAllRetries,
  isFlakyTestRetriesEnabled,
  isLastAtrAttempt,
  isEfdRetry,
  isLastEfdRetry,
  isAttemptToFix,
  isLastAttemptToFix,
  attemptToFixPassed,
  hasPassedAnyEfdAttempt,
  isQuarantined,
  isDisabled,
  isFinalAttempt,
}) {
  // Note that intermediate executions DO NOT report a final status tag

  // Intermediate executions must not carry a final status, regardless of quarantine/disabled state
  const isExternalIntermediateExecution = !isEfdRetry && !isAttemptToFix && !isFinalAttempt
  const isIntermediateExecution =
    (isEfdRetry && !isLastEfdRetry) ||
    (isAttemptToFix && !isLastAttemptToFix) ||
    isExternalIntermediateExecution
  if (isIntermediateExecution) {
    return
  }

  // If the test is quarantined or disabled, its final status is skip unless attempt-to-fix takes precedence.
  if (!isAttemptToFix && (isQuarantined || isDisabled)) {
    return 'skip'
  }

  const isAtrActive = isFlakyTestRetriesEnabled && !isAttemptToFix && !isEfdRetry

  // When no retry feature is active, every execution is final
  if (!isAtrActive && !isEfdRetry && !isAttemptToFix) {
    return status
  }
  if (isAtrActive && isLastAtrAttempt) {
    return hasFailedAllRetries ? 'fail' : 'pass'
  }
  if (isEfdRetry && isLastEfdRetry) {
    return hasPassedAnyEfdAttempt ? 'pass' : 'fail'
  }
  if (isAttemptToFix && isLastAttemptToFix) {
    return attemptToFixPassed ? 'pass' : 'fail'
  }
}

function getTestFinishInfo (test, status, config, error) {
  let hasFailedAllRetries = false
  let attemptToFixPassed = false
  let attemptToFixFailed = false

  const testName = getTestFullName(test)
  if (
    isEarlyFlakeDetectionTest(test, config) &&
    !test._ddIsEfdRetry &&
    !efdRetryCountByTestFullName.has(testName)
  ) {
    const duration = test.duration > 0 ? test.duration : performance.now() - test._ddStartTime
    setEfdRetryCountForTest(test, duration, config.earlyFlakeDetectionSlowTestRetries)
  }

  if (testsStatuses.get(testName)) {
    testsStatuses.get(testName).push(status)
  } else {
    testsStatuses.set(testName, [status])
  }
  const testStatuses = testsStatuses.get(testName)

  const isLastAttempt = testStatuses.length === config.testManagementAttemptToFixRetries + 1
  const efdRetryCount = efdRetryCountByTestFullName.get(testName) ?? getConfiguredEfdRetryCount(config)
  const isLastEfdRetry = testStatuses.length === efdRetryCount + 1
  const isLastAtrAttempt = getIsLastRetry(test) || (config.isFlakyTestRetriesEnabled && status === 'pass')

  // Needed for the getFinalStatus call. This is because EFD does NOT tag as
  // EFD retry the first run of the test. It only tags as retries the clones
  const isEfdRetry = isEarlyFlakeDetectionTest(test, config)

  if (test._ddIsAttemptToFix && isLastAttempt) {
    if (testStatuses.includes('fail')) {
      attemptToFixFailed = true
    }
    if (testStatuses.every(status => status === 'fail')) {
      hasFailedAllRetries = true
    } else if (testStatuses.every(status => status === 'pass')) {
      attemptToFixPassed = true
    }
  }

  if (test._ddIsEfdRetry && efdRetryCount > 0 && isLastEfdRetry &&
    testStatuses.every(status => status === 'fail')) {
    hasFailedAllRetries = true
  }

  // ATR: set hasFailedAllRetries when all auto test retries were exhausted and every attempt failed
  if (config.isFlakyTestRetriesEnabled && !test._ddIsAttemptToFix && !test._ddIsEfdRetry &&
    getIsLastRetry(test) && testStatuses.every(status => status === 'fail')) {
    hasFailedAllRetries = true
  }

  const isAttemptToFixRetry = test._ddIsAttemptToFix && testStatuses.length > 1
  const isAtrRetry = config.isFlakyTestRetriesEnabled &&
    !test._ddIsAttemptToFix &&
    !test._ddIsEfdRetry
  const isFinalAttempt = status !== 'fail' || test._currentRetry >= test._retries

  const { isFlakyTestRetriesEnabled } = config
  const { _ddIsAttemptToFix, _ddIsQuarantined, _ddIsDisabled } = test

  const finalStatus = getFinalStatus({
    status,
    hasFailedAllRetries,
    isFlakyTestRetriesEnabled,
    isLastAtrAttempt,
    isEfdRetry,
    isLastEfdRetry,
    isAttemptToFix: _ddIsAttemptToFix,
    isLastAttemptToFix: isLastAttempt,
    attemptToFixPassed,
    hasPassedAnyEfdAttempt: testStatuses.includes('pass'),
    isQuarantined: _ddIsQuarantined,
    isDisabled: _ddIsDisabled,
    isFinalAttempt,
  })

  if (_ddIsAttemptToFix) {
    recordAttemptToFixExecution(attemptToFixExecutions, {
      testSuite: getTestSuitePath(test.file, process.cwd()),
      testName: test.fullTitle(),
      status,
      isDisabled: _ddIsDisabled,
      isQuarantined: _ddIsQuarantined,
    })
  }

  return {
    hasFailedAllRetries,
    attemptToFixPassed,
    attemptToFixFailed,
    isAttemptToFixRetry,
    isAtrRetry,
    finalStatus,
    earlyFlakeAbortReason: efdSlowAbortedTests.has(testName) ? 'slow' : undefined,
  }
}

function getOnTestEndHandler (config, finalAttemptHandlers) {
  return async function (test) {
    if (test._ddShouldSkipEfdRetry) {
      return
    }
    const ctx = getTestContext(test)
    const status = getTestStatus(test)
    const shouldFinishTest = ctx && (!getAfterEachHooks(test).length || (test._ddIsDisabled && !test._ddIsAttemptToFix))
    let testFinishInfo
    let isFinalAttempt = false

    // If there are afterEach to be run, we don't finish the test yet.
    // Disabled tests (marked pending by us) are finished immediately without waiting for afterEach hooks.
    // In older mocha versions, pending tests don't run afterEach hooks, so we can't rely on
    // getOnHookEndHandler to finish the test. This mirrors Jest's approach where the skip handler
    // directly sets finalStatus without waiting for hooks
    if (!ctx && test.isPending()) {
      test._ddIsFinalAttempt = true
      isFinalAttempt = true
    }

    if (shouldFinishTest) {
      testFinishInfo = getTestFinishInfo(test, status, config, ctx.err || test.err)
      if (testFinishInfo.finalStatus !== undefined) {
        test._ddIsFinalAttempt = true
        isFinalAttempt = true
      }
    }

    if (isFinalAttempt) {
      finalAttemptHandlers?.onStart?.(test)
    }

    if (test._retriedTest?._ddShouldWaitForHitProbe) {
      await waitForHitProbe()
    }

    if (shouldFinishTest) {
      testFinishCh.publish({
        status,
        hasBeenRetried: isMochaRetry(test),
        isLastRetry: getIsLastRetry(test),
        ...testFinishInfo,
        ...ctx.currentStore,
      })
    }

    if (isFinalAttempt) {
      finalAttemptHandlers?.onFinish?.(test)
    }
  }
}

function getOnHookEndHandler (config, finalAttemptHandlers) {
  return function (hook) {
    const test = hook.ctx.currentTest
    const afterEachHooks = getAfterEachHooks(hook)
    if (test && afterEachHooks.includes(hook)) { // only if it's an afterEach
      const isLastAfterEach = afterEachHooks.indexOf(hook) === afterEachHooks.length - 1
      if (isLastAfterEach) {
        const status = getTestStatus(test)
        const ctx = getTestContext(test)
        // Disabled tests are already finished in getOnTestEndHandler,
        // skip to avoid double-publishing
        if (ctx && (!test._ddIsDisabled || test._ddIsAttemptToFix)) {
          const testFinishInfo = getTestFinishInfo(test, status, config, ctx.err || test.err)
          const isFinalAttempt = testFinishInfo.finalStatus !== undefined
          const publishTestFinish = () => {
            testFinishCh.publish({
              status,
              hasBeenRetried: isMochaRetry(test),
              isLastRetry: getIsLastRetry(test),
              ...testFinishInfo,
              ...ctx.currentStore,
            })
            if (isFinalAttempt) {
              test._ddIsFinalAttempt = true
            }
          }
          if (test._retriedTest?._ddShouldWaitForHitProbe) {
            if (isFinalAttempt) {
              finalAttemptHandlers?.onStart?.(test)
            }
            test._ddDeferredHookEnd = {
              waitForHitProbePromise: waitForHitProbe(),
              publishTestFinish,
              onFinish: isFinalAttempt ? () => finalAttemptHandlers?.onFinish?.(test) : undefined,
            }
            return
          }
          publishTestFinish()
        }
      }
    }
  }
}

function finishDeferredHookEnd (test) {
  const deferredHookEnd = test?._ddDeferredHookEnd
  if (!deferredHookEnd) return

  const finish = () => {
    try {
      return deferredHookEnd.publishTestFinish()
    } finally {
      deferredHookEnd.onFinish?.()
    }
  }

  delete test._ddDeferredHookEnd
  if (!deferredHookEnd.waitForHitProbePromise) return finish()

  return deferredHookEnd.waitForHitProbePromise.then(
    finish,
    finish
  )
}

/**
 * Runs a Failed Test Replay hookUp callback after pending DI operations that must happen first.
 *
 * @param {(...args: unknown[]) => unknown} fn - Original hookUp completion callback.
 * @param {object} test - Mocha test currently owning the hook.
 * @param {Promise<void>|undefined} failedTestReplayPromise - Pending Failed Test Replay wait, if any.
 * @param {unknown} hookThis - Callback receiver.
 * @param {IArguments} args - Arguments passed by Mocha.
 * @returns {unknown}
 */
function runFailedTestReplayHookUpCallback (fn, test, failedTestReplayPromise, hookThis, args) {
  const continueAfterProbe = () => {
    const deferredHookEndPromise = finishDeferredHookEnd(test)
    if (deferredHookEndPromise) {
      return deferredHookEndPromise.then(() => fn.apply(hookThis, args), () => fn.apply(hookThis, args))
    }
    return fn.apply(hookThis, args)
  }

  if (failedTestReplayPromise) {
    return failedTestReplayPromise.then(continueAfterProbe, continueAfterProbe)
  }
  return continueAfterProbe()
}

/**
 * Wraps Mocha's hookUp completion callback so retries wait for DI before continuing.
 *
 * @param {(...args: unknown[]) => unknown} fn - Original hookUp completion callback.
 * @param {object} test - Mocha test currently owning the hook.
 * @param {Promise<void>|undefined} failedTestReplayPromise - Pending Failed Test Replay wait, if any.
 * @returns {(...args: unknown[]) => unknown}
 */
function wrapFailedTestReplayHookUpCallback (fn, test, failedTestReplayPromise) {
  return shimmer.wrapCallback(fn, fn => function () {
    return runFailedTestReplayHookUpCallback(fn, test, failedTestReplayPromise, this, arguments)
  })
}

const patchedFailedTestReplayHookUp = new WeakSet()

function patchFailedTestReplayHookUp (Runner) {
  if (patchedFailedTestReplayHookUp.has(Runner)) return

  patchedFailedTestReplayHookUp.add(Runner)
  shimmer.wrap(Runner.prototype, 'hookUp', hookUp => function (name, fn) {
    const test = name === 'afterEach' && this.test
    if (!test) {
      return hookUp.apply(this, arguments)
    }

    const failedTestReplayPromise = test._ddFailedTestReplayPromise
    if (failedTestReplayPromise) {
      delete test._ddFailedTestReplayPromise
    }

    return hookUp.call(this, name, wrapFailedTestReplayHookUpCallback(fn, test, failedTestReplayPromise))
  })
}

function getOnFailHandler (isMain, config) {
  return function (testOrHook, err) {
    const testFile = testOrHook.file
    let test = testOrHook
    const isHook = testOrHook.type === 'hook'
    if (isHook && testOrHook.ctx) {
      test = testOrHook.ctx.currentTest
    }
    let testContext
    if (test) {
      testContext = getTestContext(test)
    }
    if (testContext) {
      if (isHook) {
        err.message = `${testOrHook.fullTitle()}: ${err.message}`
        testContext.err = err
        errorCh.runStores(testContext, () => {})
        const testFinishInfo = getTestFinishInfo(test, 'fail', config, err)
        // ATR never retries hook failures: this.retries(N) is set in runnableWrapper
        // which only runs when the test function executes — hooks bypass that path,
        // so _retries stays at -1 and getIsLastRetry returns false, leaving finalStatus
        // undefined. We must also mark the attempt final when no clone-based retry
        // mechanism (EFD original, EFD clone, ATF) has queued further attempts.
        const noCloneRetries = !test._ddIsEfdRetry &&
          !((test._ddIsNew || test._ddIsModified) && config.isEarlyFlakeDetectionEnabled) &&
          !test._ddIsAttemptToFix
        if (testFinishInfo.finalStatus !== undefined || noCloneRetries) {
          test._ddIsFinalAttempt = true
        }
        // test.state is never set to 'failed' for hook failures (Mocha marks the hook,
        // not the test). Flag it so finishRootSuiteForFile can compute the correct status.
        test._ddHookFailed = true
        testFinishCh.publish({
          status: 'fail',
          hasBeenRetried: isMochaRetry(test),
          ...testFinishInfo,
          ...testContext.currentStore,
        })
      } else {
        testContext.err = err
        errorCh.runStores(testContext, () => {})
      }
    }

    if (isMain) {
      const testSuiteContext = testFileToSuiteCtx.get(testFile)

      if (testSuiteContext) {
        // we propagate the error to the suite
        const testSuiteError = new Error(
          `"${testOrHook.parent.fullTitle()}" failed with message "${err.message}"`
        )
        testSuiteError.stack = err.stack
        testSuiteContext.error = testSuiteError
        testSuiteErrorCh.runStores(testSuiteContext, () => {})
      }
    }
  }
}

function getOnTestRetryHandler (config) {
  return function (test, err) {
    const ctx = getTestContext(test)
    if (ctx) {
      const isFirstAttempt = test._currentRetry === 0
      const willBeRetried = test._currentRetry < test._retries
      const isAtrRetry = !isFirstAttempt &&
        config.isFlakyTestRetriesEnabled &&
        !test._ddIsAttemptToFix &&
        !test._ddIsEfdRetry
      const promises = {}
      testRetryCh.publish({
        isFirstAttempt,
        err,
        willBeRetried,
        test,
        isAtrRetry,
        promises,
        ...ctx.currentStore,
      })
      if (promises.setProbePromise && promises.finishTestPromise) {
        test._ddFailedTestReplayPromise = Promise.all([
          promises.setProbePromise,
          promises.finishTestPromise,
        ]).then(() => {})
      } else if (promises.setProbePromise || promises.finishTestPromise) {
        test._ddFailedTestReplayPromise = promises.setProbePromise || promises.finishTestPromise
      }
    }
    const key = getTestToContextKey(test)
    testToContext.delete(key)
  }
}

function getOnPendingHandler () {
  return function (test) {
    if (test._ddShouldSkipEfdRetry) {
      return
    }
    const testStartLine = testToStartLine.get(test)
    const {
      file: testSuiteAbsolutePath,
      title,
    } = test

    const testInfo = {
      testName: test.fullTitle(),
      testSuiteAbsolutePath,
      title,
      testStartLine,
    }

    const ctx = getTestContext(test)
    if (ctx) {
      skipCh.publish(testInfo)
    } else {
      // if there is no context, the test has been skipped through `test.skip`
      // or the parent suite is skipped
      const testCtx = testInfo
      if (test.fn) {
        testToContext.set(test.fn, testCtx)
      } else {
        testToContext.set(test, testCtx)
      }
      skipCh.runStores(testCtx, () => {})
    }
  }
}

// Hook to add retries to tests if Test Management or EFD is enabled
function getRunTestsWrapper (runTests, config) {
  return function (suite) {
    if (config.isTestManagementTestsEnabled) {
      // eslint-disable-next-line unicorn/no-array-for-each
      suite.tests.forEach((test) => {
        const { isAttemptToFix, isDisabled, isQuarantined } = getTestProperties(test, config.testManagementTests)
        if (isAttemptToFix && !test.isPending()) {
          test._ddIsAttemptToFix = true
          test._ddIsDisabled = isDisabled
          test._ddIsQuarantined = isQuarantined
          // This is needed to know afterwards which ones have been retried to ignore its result
          testsAttemptToFix.add(test)
          retryTest(
            test,
            config.testManagementAttemptToFixRetries,
            ['_ddIsAttemptToFix', isDisabled && '_ddIsDisabled', isQuarantined && '_ddIsQuarantined']
          )
        } else if (isDisabled) {
          test._ddIsDisabled = true
        } else if (isQuarantined) {
          testsQuarantined.add(test)
          test._ddIsQuarantined = true
        }
      })
    }

    if (config.isImpactedTestsEnabled) {
      // eslint-disable-next-line unicorn/no-array-for-each
      suite.tests.forEach((test) => {
        isModifiedCh.publish({
          modifiedFiles: config.modifiedFiles,
          file: suite.file,
          onDone: (isModified) => {
            if (isModified) {
              test._ddIsModified = true
              if (!test.isPending() && !test._ddIsAttemptToFix && config.isEarlyFlakeDetectionEnabled) {
                retryTest(
                  test,
                  getConfiguredEfdRetryCount(config),
                  ['_ddIsModified', '_ddIsEfdRetry'],
                  config.earlyFlakeDetectionSlowTestRetries
                )
              }
            }
          },
        })
      })
    }

    if (config.isKnownTestsEnabled) {
      // by the time we reach `this.on('test')`, it is too late. We need to add retries here
      // eslint-disable-next-line unicorn/no-array-for-each
      suite.tests.forEach((test) => {
        if (!test.isPending() && isNewTest(test, config.knownTests)) {
          test._ddIsNew = true
          if (config.isEarlyFlakeDetectionEnabled && !test._ddIsAttemptToFix && !test._ddIsModified) {
            retryTest(
              test,
              getConfiguredEfdRetryCount(config),
              ['_ddIsNew', '_ddIsEfdRetry'],
              config.earlyFlakeDetectionSlowTestRetries
            )
          }
        }
      })
    }

    return runTests.apply(this, arguments)
  }
}

module.exports = {
  isNewTest,
  getTestProperties,
  getSuitesByTestFile,
  isMochaRetry,
  getTestFullName,
  getTestStatus,
  runnableWrapper,
  testToContext,
  originalFns,
  getTestContext,
  testToStartLine,
  getOnTestHandler,
  getOnTestEndHandler,
  getOnTestRetryHandler,
  getOnHookEndHandler,
  finishDeferredHookEnd,
  wrapFailedTestReplayHookUpCallback,
  patchFailedTestReplayHookUp,
  getOnFailHandler,
  getOnPendingHandler,
  testFileToSuiteCtx,
  getRunTestsWrapper,
  newTests,
  efdTests,
  newTestsWithDynamicNames,
  testsQuarantined,
  testsAttemptToFix,
  testsStatuses,
  attemptToFixExecutions,
  loggedAttemptToFixTests,
}
