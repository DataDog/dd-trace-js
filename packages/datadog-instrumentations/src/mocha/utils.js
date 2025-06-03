'use strict'

const {
  getTestSuitePath,
  removeEfdStringFromTestName,
  addEfdStringToTestName,
  addAttemptToFixStringToTestName,
  removeAttemptToFixStringFromTestName
} = require('../../../dd-trace/src/plugins/util/test')
const { channel } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

// test channels
const testStartCh = channel('ci:mocha:test:start')
const testFinishCh = channel('ci:mocha:test:finish')
// after a test has failed, we'll publish to this channel
const testRetryCh = channel('ci:mocha:test:retry')
const errorCh = channel('ci:mocha:test:error')
const skipCh = channel('ci:mocha:test:skip')
const testFnCh = channel('ci:mocha:test:fn')
const isModifiedCh = channel('ci:mocha:test:is-modified')
// suite channels
const testSuiteErrorCh = channel('ci:mocha:test-suite:error')

const BREAKPOINT_HIT_GRACE_PERIOD_MS = 200
const testToContext = new WeakMap()
const originalFns = new WeakMap()
const testToStartLine = new WeakMap()
const testFileToSuiteCtx = new Map()
const wrappedFunctions = new WeakSet()
const newTests = {}
const testsAttemptToFix = new Set()
const testsQuarantined = new Set()
const testsStatuses = new Map()

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
  const testSuite = getTestSuitePath(test.file, process.cwd())
  const testName = removeEfdStringFromTestName(test.fullTitle())
  const testsForSuite = knownTests.mocha?.[testSuite] || []
  return !testsForSuite.includes(testName)
}

function retryTest (test, numRetries, modifyTestName, tags) {
  const originalTestName = test.title
  const suite = test.parent
  for (let retryIndex = 0; retryIndex < numRetries; retryIndex++) {
    const clonedTest = test.clone()
    clonedTest.title = modifyTestName(originalTestName, retryIndex + 1)
    suite.addTest(clonedTest)
    tags.forEach(tag => {
      if (tag) {
        clonedTest[tag] = true
      }
    })
  }
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
  const testName = removeEfdStringFromTestName(
    removeAttemptToFixStringFromTestName(test.fullTitle())
  )
  return `mocha.${getTestSuitePath(test.file, process.cwd())}.${testName}`
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
  const originalFn = originalFns.get(test.fn)
  return originalFn
}

function getTestContext (test) {
  const key = getTestToContextKey(test)
  return testToContext.get(key)
}

function runnableWrapper (RunnablePackage, libraryConfig) {
  shimmer.wrap(RunnablePackage.prototype, 'run', run => function () {
    if (!testFinishCh.hasSubscribers) {
      return run.apply(this, arguments)
    }
    // Flaky test retries does not work in parallel mode
    if (libraryConfig?.isFlakyTestRetriesEnabled) {
      this.retries(libraryConfig?.flakyTestRetriesCount)
    }
    // The reason why the wrapping logic is here is because we need to cover
    // `afterEach` and `beforeEach` hooks as well.
    // It can't be done in `getOnTestHandler` because it's only called for tests.
    const isBeforeEach = this.parent._beforeEach.includes(this)
    const isAfterEach = this.parent._afterEach.includes(this)

    const isTestHook = isBeforeEach || isAfterEach

    // we restore the original user defined function
    if (wrappedFunctions.has(this.fn)) {
      const originalFn = originalFns.get(this.fn)
      this.fn = originalFn
      wrappedFunctions.delete(this.fn)
    }

    if (isTestHook || this.type === 'test') {
      const test = isTestHook ? this.ctx.currentTest : this
      const ctx = getTestContext(test)

      if (ctx) {
        const originalFn = this.fn
        // we bind the test fn to the correct context
        const newFn = function () {
          return testFnCh.runStores(ctx, () => originalFn.apply(this, arguments))
        }

        // we store the original function, not to lose it
        originalFns.set(newFn, originalFn)
        this.fn = newFn

        wrappedFunctions.add(this.fn)
      }
    }

    return run.apply(this, arguments)
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

    const {
      file: testSuiteAbsolutePath,
      title,
      _ddIsNew: isNew,
      _ddIsEfdRetry: isEfdRetry,
      _ddIsAttemptToFix: isAttemptToFix,
      _ddIsDisabled: isDisabled,
      _ddIsQuarantined: isQuarantined,
      _ddIsModified: isModified
    } = test

    const testName = removeEfdStringFromTestName(removeAttemptToFixStringFromTestName(test.fullTitle()))

    const testInfo = {
      testName,
      testSuiteAbsolutePath,
      title,
      testStartLine
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
    // We want to store the result of the new tests
    if (isNew) {
      const testFullName = getTestFullName(test)
      if (newTests[testFullName]) {
        newTests[testFullName].push(test)
      } else {
        newTests[testFullName] = [test]
      }
    }

    if (!isAttemptToFix && isDisabled) {
      test.pending = true
    }

    const ctx = testInfo
    testToContext.set(test.fn, ctx)
    testStartCh.runStores(ctx, () => {})
  }
}

function getOnTestEndHandler (config) {
  return async function (test) {
    const ctx = getTestContext(test)
    const status = getTestStatus(test)

    // After finishing it might take a bit for the snapshot to be handled.
    // This means that tests retried with DI are BREAKPOINT_HIT_GRACE_PERIOD_MS slower at least.
    if (test._ddShouldWaitForHitProbe || test._retriedTest?._ddShouldWaitForHitProbe) {
      await new Promise((resolve) => {
        setTimeout(() => {
          resolve()
        }, BREAKPOINT_HIT_GRACE_PERIOD_MS)
      })
    }

    let hasFailedAllRetries = false
    let attemptToFixPassed = false
    let attemptToFixFailed = false

    const testName = getTestFullName(test)

    if (testsStatuses.get(testName)) {
      testsStatuses.get(testName).push(status)
    } else {
      testsStatuses.set(testName, [status])
    }
    const testStatuses = testsStatuses.get(testName)

    const isLastAttempt = testStatuses.length === config.testManagementAttemptToFixRetries + 1

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

    const isAttemptToFixRetry = test._ddIsAttemptToFix && testStatuses.length > 1
    const isAtrRetry = config.isFlakyTestRetriesEnabled &&
      !test._ddIsAttemptToFix &&
      !test._ddIsEfdRetry

    // if there are afterEach to be run, we don't finish the test yet
    if (ctx && !getAfterEachHooks(test).length) {
      testFinishCh.publish({
        status,
        hasBeenRetried: isMochaRetry(test),
        isLastRetry: getIsLastRetry(test),
        hasFailedAllRetries,
        attemptToFixPassed,
        attemptToFixFailed,
        isAttemptToFixRetry,
        isAtrRetry,
        ...ctx.currentStore
      })
    }
  }
}

function getOnHookEndHandler () {
  return function (hook) {
    const test = hook.ctx.currentTest
    const afterEachHooks = getAfterEachHooks(hook)
    if (test && afterEachHooks.includes(hook)) { // only if it's an afterEach
      const isLastAfterEach = afterEachHooks.indexOf(hook) === afterEachHooks.length - 1
      if (isLastAfterEach) {
        const status = getTestStatus(test)
        const ctx = getTestContext(test)
        if (ctx) {
          testFinishCh.publish({
            status,
            hasBeenRetried: isMochaRetry(test),
            isLastRetry: getIsLastRetry(test),
            ...ctx.currentStore
          })
        }
      }
    }
  }
}

function getOnFailHandler (isMain) {
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
        // if it's a hook and it has failed, 'test end' will not be called
        testFinishCh.publish({ status: 'fail', hasBeenRetried: isMochaRetry(test), ...testContext.currentStore })
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
      testRetryCh.publish({ isFirstAttempt, err, willBeRetried, test, isAtrRetry, ...ctx.currentStore })
    }
    const key = getTestToContextKey(test)
    testToContext.delete(key)
  }
}

function getOnPendingHandler () {
  return function (test) {
    const testStartLine = testToStartLine.get(test)
    const {
      file: testSuiteAbsolutePath,
      title
    } = test

    const testInfo = {
      testName: test.fullTitle(),
      testSuiteAbsolutePath,
      title,
      testStartLine
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
            addAttemptToFixStringToTestName,
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
      suite.tests.forEach((test) => {
        isModifiedCh.publish({
          modifiedTests: config.modifiedTests,
          file: suite.file,
          onDone: (isModified) => {
            if (isModified) {
              test._ddIsModified = true
              if (!test.isPending() && !test._ddIsAttemptToFix && config.isEarlyFlakeDetectionEnabled) {
                retryTest(
                  test,
                  config.earlyFlakeDetectionNumRetries,
                  addEfdStringToTestName,
                  ['_ddIsModified', '_ddIsEfdRetry']
                )
              }
            }
          }
        })
      })
    }

    if (config.isKnownTestsEnabled) {
      // by the time we reach `this.on('test')`, it is too late. We need to add retries here
      suite.tests.forEach(test => {
        if (!test.isPending() && isNewTest(test, config.knownTests)) {
          test._ddIsNew = true
          if (config.isEarlyFlakeDetectionEnabled && !test._ddIsAttemptToFix && !test._ddIsModified) {
            retryTest(
              test,
              config.earlyFlakeDetectionNumRetries,
              addEfdStringToTestName,
              ['_ddIsNew', '_ddIsEfdRetry']
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
  getOnFailHandler,
  getOnPendingHandler,
  testFileToSuiteCtx,
  getRunTestsWrapper,
  newTests,
  testsQuarantined,
  testsAttemptToFix,
  testsStatuses
}
