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
const errorCh = channel('ci:mocha:test:error')
const skipCh = channel('ci:mocha:test:skip')

// suite channels
const testSuiteErrorCh = channel('ci:mocha:test-suite:error')

const testToAr = new WeakMap()
const originalFns = new WeakMap()
const testToStartLine = new WeakMap()
const testFileToSuiteAr = new Map()
const wrappedFunctions = new WeakSet()

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

function setTestAsyncResource (test, newAsyncResource) {
  const asyncResourceList = getTestAsyncResource(test)
  if (asyncResourceList) {
    asyncResourceList.push(newAsyncResource)
  } else {
    testToAr.set(test.fn, [newAsyncResource])
  }
}

// this does not work well now because there are multiple tests for the same "test" object
function getTestAsyncResource (test) {
  if (!test.fn) {
    return testToAr.get(test)
  }
  if (!wrappedFunctions.has(test.fn)) {
    return testToAr.get(test.fn)
  }
  const originalFn = originalFns.get(test.fn)
  return testToAr.get(originalFn)
}

function runnableWrapper (RunnablePackage, libraryConfig) {
  shimmer.wrap(RunnablePackage.prototype, 'run', run => function () {
    if (!testStartCh.hasSubscribers) {
      return run.apply(this, arguments)
    }
    // TODO: this is probably called multiple times. Maybe we can just do it once
    // where, though?
    if (libraryConfig.isFlakyTestRetriesEnabled) {
      // TODO: change magic number
      this.retries(5)
    }
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
      const asyncResourceList = getTestAsyncResource(test)

      if (asyncResourceList) {
        const asyncResource = asyncResourceList[test._currentRetry]
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

function getOnTestHandler (isMain, newTests) {
  return function (test) {
    const testStartLine = testToStartLine.get(test)
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    setTestAsyncResource(test, asyncResource)

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
    const asyncResourceList = getTestAsyncResource(test)
    const status = getTestStatus(test)

    // if there are afterEach to be run, we don't finish the test yet
    if (asyncResourceList && !test.parent._afterEach.length) {
      const asyncResource = asyncResourceList[test._currentRetry]
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
        const asyncResourceList = getTestAsyncResource(test)
        if (asyncResourceList) {
          const asyncResource = asyncResourceList[test._currentRetry]
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
      testAsyncResource = testAsyncResource[test._currentRetry]
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
    const asyncResourceList = getTestAsyncResource(test)
    const asyncResource = asyncResourceList[test._currentRetry]
    if (asyncResource) {
      asyncResource.runInAsyncScope(() => {
        testFinishCh.publish('fail')
      })
    }
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

    const [asyncResource] = getTestAsyncResource(test)
    if (asyncResource) {
      asyncResource.runInAsyncScope(() => {
        skipCh.publish(testInfo)
      })
    } else {
      // if there is no async resource, the test has been skipped through `test.skip`
      // or the parent suite is skipped
      const skippedTestAsyncResource = new AsyncResource('bound-anonymous-fn')
      if (test.fn) {
        testToAr.set(test.fn, [skippedTestAsyncResource])
      } else {
        testToAr.set(test, [skippedTestAsyncResource])
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
