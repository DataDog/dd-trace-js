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

function runnableWrapper (RunnablePackage) {
  shimmer.wrap(RunnablePackage.prototype, 'run', run => function () {
    if (!testStartCh.hasSubscribers) {
      return run.apply(this, arguments)
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

function getOnTestHandler (isMain, newTests) {
  return function (test) {
    if (isMochaRetry(test)) {
      return
    }
    const testStartLine = testToStartLine.get(test)
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    testToAr.set(test.fn, asyncResource)

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
      if (isLastAfterEach) {
        const status = getTestStatus(test)
        const asyncResource = getTestAsyncResource(test)
        asyncResource.runInAsyncScope(() => {
          testFinishCh.publish(status)
        })
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
  getOnHookEndHandler,
  getOnFailHandler,
  getOnPendingHandler,
  testFileToSuiteAr
}
