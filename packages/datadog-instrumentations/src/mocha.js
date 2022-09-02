const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const testStartCh = channel('ci:mocha:test:start')
const errorCh = channel('ci:mocha:test:error')
const skipCh = channel('ci:mocha:test:skip')
const testFinishCh = channel('ci:mocha:test:finish')
const parameterizedTestCh = channel('ci:mocha:test:parameterize')

const testRunStartCh = channel('ci:mocha:run:start')
const testRunFinishCh = channel('ci:mocha:run:finish')

const testSuiteStartCh = channel('ci:mocha:test-suite:start')
const testSuiteFinishCh = channel('ci:mocha:test-suite:finish')
const testSuiteErrorCh = channel('ci:mocha:test-suite:error')

// TODO: remove when root hooks and fixtures are implemented
const patched = new WeakSet()

const testToAr = new WeakMap()
const originalFns = new WeakMap()
const testFileToAr = new Map()

function getSuitesByTestFile (root) {
  const suitesByTestFile = {}
  function getSuites (suite) {
    if (suitesByTestFile[suite.file]) {
      suitesByTestFile[suite.file].push(suite)
    } else {
      suitesByTestFile[suite.file] = [suite]
    }
    suite.suites.forEach(suite => {
      getSuites(suite)
    })
  }
  getSuites(root)

  return suitesByTestFile
}

function getTestStatus (test) {
  if (test.pending) {
    return 'skip'
  }
  if (test.state !== 'failed' && !test.timedOut) {
    return 'pass'
  }
  return 'fail'
}

function isRetry (test) {
  return test._currentRetry !== undefined && test._currentRetry !== 0
}

function getTestAsyncResource (test) {
  if (!test.fn) {
    return testToAr.get(test)
  }
  if (!test.fn.asyncResource) {
    return testToAr.get(test.fn)
  }
  const originalFn = originalFns.get(test.fn)
  return testToAr.get(originalFn)
}

function mochaHook (Runner) {
  if (patched.has(Runner)) return Runner

  patched.add(Runner)

  shimmer.wrap(Runner.prototype, 'run', run => function () {
    if (!testStartCh.hasSubscribers) {
      return run.apply(this, arguments)
    }

    const suitesByTestFile = getSuitesByTestFile(this.suite)

    const testRunAsyncResource = new AsyncResource('bound-anonymous-fn')

    this.once('end', testRunAsyncResource.bind(function () {
      let status = 'pass'
      if (this.stats) {
        status = this.stats.failures === 0 ? 'pass' : 'fail'
      } else if (this.failures !== 0) {
        status = 'fail'
      }
      testRunFinishCh.publish(status)
    }))

    this.once('start', testRunAsyncResource.bind(function () {
      const processArgv = process.argv.slice(2).join(' ')
      const command = `mocha ${processArgv}`
      testRunStartCh.publish(command)
    }))

    this.on('suite', function (suite) {
      if (suite.root || !suite.tests.length) {
        return
      }
      let asyncResource = testFileToAr.get(suite.file)
      if (!asyncResource) {
        asyncResource = new AsyncResource('bound-anonymous-fn')
        testFileToAr.set(suite.file, asyncResource)
        asyncResource.runInAsyncScope(() => {
          testSuiteStartCh.publish(suite)
        })
      }
    })

    this.on('suite end', function (suite) {
      if (suite.root) {
        return
      }
      const suitesInTestFile = suitesByTestFile[suite.file]

      const isLastSuite = suitesInTestFile.filter(suite => suite._ddFinished).length === suitesInTestFile.length - 1
      suite._ddFinished = true
      if (!isLastSuite) {
        return
      }

      let status = 'pass'
      if (suite.pending) {
        status = 'skip'
      } else {
        suite.eachTest(test => {
          if (test.state === 'failed' || test.timedOut) {
            status = 'fail'
          }
        })
      }

      const asyncResource = testFileToAr.get(suite.file)
      asyncResource.runInAsyncScope(() => {
        // get suite status
        testSuiteFinishCh.publish(status)
      })
    })

    this.on('test', (test) => {
      if (isRetry(test)) {
        return
      }
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      testToAr.set(test.fn, asyncResource)
      asyncResource.runInAsyncScope(() => {
        testStartCh.publish(test)
      })
    })

    this.on('test end', (test) => {
      const asyncResource = getTestAsyncResource(test)
      const status = getTestStatus(test)

      // if there are afterEach to be run, we don't finish the test yet
      if (!test.parent._afterEach.length) {
        asyncResource.runInAsyncScope(() => {
          testFinishCh.publish(status)
        })
      }
    })

    // If the hook passes, 'hook end' will be emitted. Otherwise, 'fail' will be emitted
    this.on('hook end', (hook) => {
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
    })

    this.on('fail', (testOrHook, err) => {
      let test = testOrHook
      const isHook = testOrHook.type === 'hook'
      if (isHook && testOrHook.ctx) {
        test = testOrHook.ctx.currentTest
      }
      let asyncResource
      if (test) {
        asyncResource = getTestAsyncResource(test)
      }
      if (asyncResource) {
        asyncResource.runInAsyncScope(() => {
          if (isHook) {
            err.message = `${testOrHook.title}: ${err.message}`
            errorCh.publish(err)
            // if it's a hook and it has failed, 'test end' will not be called
            testFinishCh.publish('fail')
          } else {
            errorCh.publish(err)
          }
          // we propagate the error to the suite
          const testSuiteAsyncResource = testFileToAr.get(test.parent.file)
          if (testSuiteAsyncResource) {
            const testSuiteError = new Error(`Test "${test.fullTitle()}" failed with message "${err.message}"`)
            testSuiteError.stack = err.stack
            testSuiteAsyncResource.runInAsyncScope(() => {
              testSuiteErrorCh.publish(testSuiteError)
            })
          }
        })
      }
    })

    this.on('pending', (test) => {
      const asyncResource = getTestAsyncResource(test)
      if (asyncResource) {
        asyncResource.runInAsyncScope(() => {
          skipCh.publish(test)
        })
      } else {
        // if there is no async resource, the test has been skipped through `test.skip``
        const skippedTestAsyncResource = new AsyncResource('bound-anonymous-fn')
        testToAr.set(test, skippedTestAsyncResource)
        skippedTestAsyncResource.runInAsyncScope(() => {
          skipCh.publish(test)
        })
      }
    })

    return run.apply(this, arguments)
  })

  shimmer.wrap(Runner.prototype, 'runTests', runTests => function () {
    if (!testRunFinishCh.hasSubscribers) {
      return runTests.apply(this, arguments)
    }
    return runTests.apply(this, arguments)
  })

  return Runner
}

function mochaEachHook (mochaEach) {
  if (patched.has(mochaEach)) return mochaEach

  patched.add(mochaEach)

  return shimmer.wrap(mochaEach, function () {
    const [params] = arguments
    const { it, ...rest } = mochaEach.apply(this, arguments)
    return {
      it: function (name) {
        parameterizedTestCh.publish({ name, params })
        it.apply(this, arguments)
      },
      ...rest
    }
  })
}

addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/runner.js'
}, mochaHook)

addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/runnable.js'
}, (Runnable) => {
  shimmer.wrap(Runnable.prototype, 'run', run => function () {
    const isBeforeEach = this.parent._beforeEach.includes(this)
    const isAfterEach = this.parent._afterEach.includes(this)

    const isTestHook = isBeforeEach || isAfterEach

    // we restore the original user defined function
    if (this.fn.asyncResource) {
      const originalFn = originalFns.get(this.fn)
      this.fn = originalFn
    }

    if (isTestHook || this.type === 'test') {
      const test = isTestHook ? this.ctx.currentTest : this
      const asyncResource = getTestAsyncResource(test)

      // we bind the test fn to the correct async resource
      const newFn = asyncResource.bind(this.fn)

      // we store the original function, not to lose it
      originalFns.set(newFn, this.fn)

      this.fn = newFn
    }

    return run.apply(this, arguments)
  })
  return Runnable
})

addHook({
  name: 'mocha-each',
  versions: ['>=2.0.1']
}, mochaEachHook)

module.exports = { mochaHook, mochaEachHook }
