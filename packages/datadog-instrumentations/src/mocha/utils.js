'use strict'

const {
  getTestSuitePath,
  removeEfdStringFromTestName,
  addEfdStringToTestName
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

const testToAr = new WeakMap()
const originalFns = new WeakMap()
const testToStartLine = new WeakMap()
const testFileToSuiteAr = new Map()
const wrappedFunctions = new WeakSet()

const NUM_FAILED_TEST_RETRIES = 5

function isNewTest (test, knownTests) {
  const testSuite = getTestSuitePath(test.file, process.cwd())
  const testName = removeEfdStringFromTestName(test.fullTitle())
  const testsForSuite = knownTests.mocha?.[testSuite] || []
  return !testsForSuite.includes(testName)
}

function retryTest (test, earlyFlakeDetectionNumRetries) {
  const originalTestName = test.title
  const suite = test.parent
  for (let retryIndex = 0; retryIndex < earlyFlakeDetectionNumRetries; retryIndex++) {
    const clonedTest = test.clone()
    clonedTest.title = addEfdStringToTestName(originalTestName, retryIndex + 1)
    suite.addTest(clonedTest)
    clonedTest._ddIsNew = true
    clonedTest._ddIsEfdRetry = true
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

function isLastRetry (test) {
  return test._currentRetry === test._retries
}

function getTestFullName (test) {
  return `mocha.${getTestSuitePath(test.file, process.cwd())}.${removeEfdStringFromTestName(test.fullTitle())}`
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
    if (libraryConfig?.isFlakyTestRetriesEnabled) {
      this.retries(NUM_FAILED_TEST_RETRIES)
    }
    return run.apply(this, arguments)
  })
  return RunnablePackage
}

function getOnTestHandler (isMain, newTests) {
  return function (test) {
    const testStartLine = testToStartLine.get(test)
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    // maybe something with afterEach or beforeEach hooks?
    if (wrappedFunctions.has(test.fn)) {
      const originalFn = originalFns.get(test.fn)
      test.fn = originalFn
      wrappedFunctions.delete(test.fn)
    }
    // now it's restored
    testToAr.set(test.fn, asyncResource)

    // we bind the test fn to the correct async resource
    const newFn = asyncResource.bind(test.fn)

    // we store the original function, not to lose it
    originalFns.set(newFn, test.fn)
    test.fn = newFn
    wrappedFunctions.add(test.fn)

    const {
      file: testSuiteAbsolutePath,
      title,
      _ddIsNew: isNew,
      _ddIsEfdRetry: isEfdRetry
    } = test

    const testInfo = {
      testName: test.fullTitle(),
      testSuiteAbsolutePath,
      title,
      testStartLine
    }

    if (isMain) {
      testInfo.isNew = isNew
      testInfo.isEfdRetry = isEfdRetry
      // We want to store the result of the new tests
      if (isNew) {
        const testFullName = getTestFullName(test)
        if (newTests[testFullName]) {
          newTests[testFullName].push(test)
        } else {
          newTests[testFullName] = [test]
        }
      }
    } else {
      testInfo.isParallel = true
    }

    asyncResource.runInAsyncScope(() => {
      testStartCh.publish(testInfo)
    })
  }
}

function getOnTestEndHandler () {
  return function (test) {
    const asyncResource = getTestAsyncResource(test)
    const status = getTestStatus(test)

    // if there are afterEach to be run, we don't finish the test yet
    if (asyncResource && !test.parent._afterEach.length) {
      asyncResource.runInAsyncScope(() => {
        testFinishCh.publish(status)
      })
    }
  }
}

function getOnHookEndHandler () {
  return function (hook) {
    const test = hook.ctx.currentTest
    if (test && hook.parent._afterEach.includes(hook)) { // only if it's an afterEach
      const isLastAfterEach = hook.parent._afterEach.indexOf(hook) === hook.parent._afterEach.length - 1
      if (test._retries > 0 && !isLastRetry(test)) {
        return
      }
      if (isLastAfterEach) {
        const status = getTestStatus(test)
        const asyncResource = getTestAsyncResource(test)
        if (asyncResource) {
          asyncResource.runInAsyncScope(() => {
            testFinishCh.publish(status)
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
          testFinishCh.publish('fail')
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

function getOnTestRetryHandler () {
  return function (test) {
    const asyncResource = getTestAsyncResource(test)
    if (asyncResource) {
      asyncResource.runInAsyncScope(() => {
        testRetryCh.publish()
      })
    }
    const key = getTestToArKey(test)
    // could we simply remove the asyncResource here?
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
module.exports = {
  isNewTest,
  retryTest,
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
  testFileToSuiteAr
}
