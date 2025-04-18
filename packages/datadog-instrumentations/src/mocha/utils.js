'use strict'

const {
  getTestSuitePath,
  removeEfdStringFromTestName,
  addEfdStringToTestName,
  addAttemptToFixStringToTestName,
  removeAttemptToFixStringFromTestName
} = require('../../../dd-trace/src/plugins/util/test')
const { channel, AsyncResource } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

// test channels
const testStartCh = channel('ci:mocha:test:start')
const testFinishCh = channel('ci:mocha:test:finish')
// after a test has failed, we'll publish to this channel
const testRetryCh = channel('ci:mocha:test:retry')
const errorCh = channel('ci:mocha:test:error')
const skipCh = channel('ci:mocha:test:skip')

// suite channels
const testSuiteErrorCh = channel('ci:mocha:test-suite:error')

const BREAKPOINT_HIT_GRACE_PERIOD_MS = 200
const testToAr = new WeakMap()
const originalFns = new WeakMap()
const testToStartLine = new WeakMap()
const testFileToSuiteAr = new Map()
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

function getTestToArKey (test) {
  if (!test.fn) {
    return test
  }
  if (!wrappedFunctions.has(test.fn)) {
    return test.fn
  }
  const originalFn = originalFns.get(test.fn)
  return originalFn
}

function getTestAsyncResource (test) {
  const key = getTestToArKey(test)
  return testToAr.get(key)
}

function runnableWrapper (RunnablePackage, libraryConfig) {
  shimmer.wrap(RunnablePackage.prototype, 'run', run => function () {
    if (!testStartCh.hasSubscribers) {
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
      const asyncResource = getTestAsyncResource(test)

      if (asyncResource) {
        // we bind the test fn to the correct async resource
        const newFn = asyncResource.bind(this.fn)

        // we store the original function, not to lose it
        originalFns.set(newFn, this.fn)
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
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    // This may be a retry. If this is the case, `test.fn` is already wrapped,
    // so we need to restore it.
    if (wrappedFunctions.has(test.fn)) {
      const originalFn = originalFns.get(test.fn)
      test.fn = originalFn
      wrappedFunctions.delete(test.fn)
    }
    testToAr.set(test.fn, asyncResource)

    const {
      file: testSuiteAbsolutePath,
      title,
      _ddIsNew: isNew,
      _ddIsEfdRetry: isEfdRetry,
      _ddIsAttemptToFix: isAttemptToFix,
      _ddIsDisabled: isDisabled,
      _ddIsQuarantined: isQuarantined
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

    asyncResource.runInAsyncScope(() => {
      testStartCh.publish(testInfo)
    })
  }
}

function getOnTestEndHandler (config) {
  return async function (test) {
    const asyncResource = getTestAsyncResource(test)
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

    const testName = getTestFullName(test)

    if (!testsStatuses.get(testName)) {
      testsStatuses.set(testName, [status])
    } else {
      testsStatuses.get(testName).push(status)
    }
    const testStatuses = testsStatuses.get(testName)

    const isLastAttempt = testStatuses.length === config.testManagementAttemptToFixRetries + 1

    if (test._ddIsAttemptToFix && isLastAttempt) {
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
    if (asyncResource && !getAfterEachHooks(test).length) {
      asyncResource.runInAsyncScope(() => {
        testFinishCh.publish({
          status,
          hasBeenRetried: isMochaRetry(test),
          isLastRetry: getIsLastRetry(test),
          hasFailedAllRetries,
          attemptToFixPassed,
          isAttemptToFixRetry,
          isAtrRetry
        })
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
        const asyncResource = getTestAsyncResource(test)
        if (asyncResource) {
          asyncResource.runInAsyncScope(() => {
            testFinishCh.publish({ status, hasBeenRetried: isMochaRetry(test), isLastRetry: getIsLastRetry(test) })
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
    let testAsyncResource
    if (test) {
      testAsyncResource = getTestAsyncResource(test)
    }
    if (testAsyncResource) {
      testAsyncResource.runInAsyncScope(() => {
        if (isHook) {
          err.message = `${testOrHook.fullTitle()}: ${err.message}`
          errorCh.publish(err)
          // if it's a hook and it has failed, 'test end' will not be called
          testFinishCh.publish({ status: 'fail', hasBeenRetried: isMochaRetry(test) })
        } else {
          errorCh.publish(err)
        }
      })
    }

    if (isMain) {
      const testSuiteAsyncResource = testFileToSuiteAr.get(testFile)

      if (testSuiteAsyncResource) {
        // we propagate the error to the suite
        const testSuiteError = new Error(
          `"${testOrHook.parent.fullTitle()}" failed with message "${err.message}"`
        )
        testSuiteError.stack = err.stack
        testSuiteAsyncResource.runInAsyncScope(() => {
          testSuiteErrorCh.publish(testSuiteError)
        })
      }
    }
  }
}

function getOnTestRetryHandler (config) {
  return function (test, err) {
    const asyncResource = getTestAsyncResource(test)
    if (asyncResource) {
      const isFirstAttempt = test._currentRetry === 0
      const willBeRetried = test._currentRetry < test._retries
      const isAtrRetry = !isFirstAttempt &&
        config.isFlakyTestRetriesEnabled &&
        !test._ddIsAttemptToFix &&
        !test._ddIsEfdRetry
      asyncResource.runInAsyncScope(() => {
        testRetryCh.publish({ isFirstAttempt, err, willBeRetried, test, isAtrRetry })
      })
    }
    const key = getTestToArKey(test)
    testToAr.delete(key)
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

    const asyncResource = getTestAsyncResource(test)
    if (asyncResource) {
      asyncResource.runInAsyncScope(() => {
        skipCh.publish(testInfo)
      })
    } else {
      // if there is no async resource, the test has been skipped through `test.skip`
      // or the parent suite is skipped
      const skippedTestAsyncResource = new AsyncResource('bound-anonymous-fn')
      if (test.fn) {
        testToAr.set(test.fn, skippedTestAsyncResource)
      } else {
        testToAr.set(test, skippedTestAsyncResource)
      }
      skippedTestAsyncResource.runInAsyncScope(() => {
        skipCh.publish(testInfo)
      })
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

    if (config.isKnownTestsEnabled) {
      // by the time we reach `this.on('test')`, it is too late. We need to add retries here
      suite.tests.forEach(test => {
        if (!test.isPending() && isNewTest(test, config.knownTests)) {
          test._ddIsNew = true
          if (config.isEarlyFlakeDetectionEnabled) {
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
  testToAr,
  originalFns,
  getTestAsyncResource,
  testToStartLine,
  getOnTestHandler,
  getOnTestEndHandler,
  getOnTestRetryHandler,
  getOnHookEndHandler,
  getOnFailHandler,
  getOnPendingHandler,
  testFileToSuiteAr,
  getRunTestsWrapper,
  newTests,
  testsQuarantined,
  testsAttemptToFix,
  testsStatuses
}
