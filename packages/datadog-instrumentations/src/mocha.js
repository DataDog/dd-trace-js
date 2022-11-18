const { createCoverageMap } = require('istanbul-lib-coverage')

const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')
const {
  getCoveredFilenamesFromCoverage,
  resetCoverage,
  mergeCoverage,
  getTestSuitePath,
  fromCoverageMapToCoverage
} = require('../../dd-trace/src/plugins/util/test')

const testStartCh = channel('ci:mocha:test:start')
const errorCh = channel('ci:mocha:test:error')
const skipCh = channel('ci:mocha:test:skip')
const testFinishCh = channel('ci:mocha:test:finish')
const parameterizedTestCh = channel('ci:mocha:test:parameterize')

const configurationCh = channel('ci:mocha:configuration')
const skippableSuitesCh = channel('ci:mocha:test-suite:skippable')

const testSessionStartCh = channel('ci:mocha:session:start')
const testSessionFinishCh = channel('ci:mocha:session:finish')

const testSuiteStartCh = channel('ci:mocha:test-suite:start')
const testSuiteFinishCh = channel('ci:mocha:test-suite:finish')
const testSuiteErrorCh = channel('ci:mocha:test-suite:error')
const testSuiteCodeCoverageCh = channel('ci:mocha:test-suite:code-coverage')

// TODO: remove when root hooks and fixtures are implemented
const patched = new WeakSet()

const testToAr = new WeakMap()
const originalFns = new WeakMap()
const testFileToSuiteAr = new Map()

// We'll preserve the original coverage here
const originalCoverageMap = createCoverageMap()

let suitesToSkip = []

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

function getTestStatus (test) {
  if (test.isPending()) {
    return 'skip'
  }
  if (test.isFailed() || test.timedOut) {
    return 'fail'
  }
  return 'pass'
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

    const { suitesByTestFile, numSuitesByTestFile } = getSuitesByTestFile(this.suite)

    const testRunAsyncResource = new AsyncResource('bound-anonymous-fn')

    this.once('end', testRunAsyncResource.bind(function () {
      let status = 'pass'
      if (this.stats) {
        status = this.stats.failures === 0 ? 'pass' : 'fail'
      } else if (this.failures !== 0) {
        status = 'fail'
      }
      testFileToSuiteAr.clear()
      testSessionFinishCh.publish(status)
      // restore the original coverage
      global.__coverage__ = fromCoverageMapToCoverage(originalCoverageMap)
    }))

    this.once('start', testRunAsyncResource.bind(function () {
      const processArgv = process.argv.slice(2).join(' ')
      const command = `mocha ${processArgv}`
      testSessionStartCh.publish(command)
    }))

    this.on('suite', function (suite) {
      if (suite.root || !suite.tests.length) {
        return
      }
      let asyncResource = testFileToSuiteAr.get(suite.file)
      if (!asyncResource) {
        asyncResource = new AsyncResource('bound-anonymous-fn')
        testFileToSuiteAr.set(suite.file, asyncResource)
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

      const isLastSuite = --numSuitesByTestFile[suite.file] === 0
      if (!isLastSuite) {
        return
      }

      let status = 'pass'
      if (suitesInTestFile.every(suite => suite.pending)) {
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
      }

      if (global.__coverage__) {
        const coverageFiles = getCoveredFilenamesFromCoverage(global.__coverage__)

        testSuiteCodeCoverageCh.publish({
          coverageFiles,
          suiteFile: suite.file
        })
        // We need to reset coverage to get a code coverage per suite
        // Before that, we preserve the original coverage
        mergeCoverage(global.__coverage__, originalCoverageMap)
        resetCoverage(global.__coverage__)
      }

      const asyncResource = testFileToSuiteAr.get(suite.file)
      asyncResource.runInAsyncScope(() => {
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
      if (asyncResource && !test.parent._afterEach.length) {
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
    })

    this.on('pending', (test) => {
      const asyncResource = getTestAsyncResource(test)
      if (asyncResource) {
        asyncResource.runInAsyncScope(() => {
          skipCh.publish(test)
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
          skipCh.publish(test)
        })
      }
    })

    // We remove the suites that we skip through ITR
    this.suite.suites = this.suite.suites.filter(suite =>
      !suitesToSkip.includes(getTestSuitePath(suite.file, process.cwd()))
    )

    return run.apply(this, arguments)
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
  file: 'lib/mocha.js'
}, (Mocha) => {
  const mochaRunAsyncResource = new AsyncResource('bound-anonymous-fn')

  /**
   * Get ITR configuration and skippable suites
   * If ITR is disabled, `onDone` is called immediately on the subscriber
   */
  shimmer.wrap(Mocha.prototype, 'run', run => function () {
    const onReceivedSkippableSuites = (err, skippableSuites) => {
      if (err) {
        log.error(err)
        suitesToSkip = []
      } else {
        suitesToSkip = skippableSuites
      }
      run.apply(this, arguments)
    }

    const onReceivedConfiguration = (err) => {
      if (err) {
        log.error(err)
        return run.apply(this, arguments)
      }

      skippableSuitesCh.publish({
        onDone: mochaRunAsyncResource.bind(onReceivedSkippableSuites)
      })
    }

    mochaRunAsyncResource.runInAsyncScope(() => {
      configurationCh.publish({
        onDone: mochaRunAsyncResource.bind(onReceivedConfiguration)
      })
    })
  })
  return Mocha
})

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
    if (!testStartCh.hasSubscribers) {
      return run.apply(this, arguments)
    }
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

      if (asyncResource) {
        // we bind the test fn to the correct async resource
        const newFn = asyncResource.bind(this.fn)

        // we store the original function, not to lose it
        originalFns.set(newFn, this.fn)

        this.fn = newFn
      }
    }

    return run.apply(this, arguments)
  })
  return Runnable
})

addHook({
  name: 'mocha-each',
  versions: ['>=2.0.1']
}, mochaEachHook)
