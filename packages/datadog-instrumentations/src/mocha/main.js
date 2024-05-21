const { createCoverageMap } = require('istanbul-lib-coverage')
const { addHook, channel, AsyncResource } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const { isMarkedAsUnskippable } = require('../../../datadog-plugin-jest/src/util')
const log = require('../../../dd-trace/src/log')
const {
  getTestSuitePath,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  fromCoverageMapToCoverage,
  getCoveredFilenamesFromCoverage,
  mergeCoverage,
  resetCoverage
} = require('../../../dd-trace/src/plugins/util/test')

const {
  isNewTest,
  retryTest,
  getSuitesByTestFile,
  isMochaRetry,
  getTestFullName,
  getTestStatus
} = require('./utils')
const { testToStartLine } = require('./common')

const testSessionAsyncResource = new AsyncResource('bound-anonymous-fn')
const patched = new WeakSet()
const newTests = {}
const testToAr = new WeakMap()
const originalFns = new WeakMap()
let suitesToSkip = []
const unskippableSuites = []
let isSuitesSkipped = false
let skippedSuites = []
let isEarlyFlakeDetectionEnabled = false
let isSuitesSkippingEnabled = false
let earlyFlakeDetectionNumRetries = 0
let knownTests = []
let itrCorrelationId = ''
const testFileToSuiteAr = new Map()
let isForcedToRun = false

// We'll preserve the original coverage here
const originalCoverageMap = createCoverageMap()

// test channels
const testStartCh = channel('ci:mocha:test:start')
const testFinishCh = channel('ci:mocha:test:finish')
const errorCh = channel('ci:mocha:test:error')
const skipCh = channel('ci:mocha:test:skip')

// test suite channels
const testSuiteStartCh = channel('ci:mocha:test-suite:start')
const testSuiteFinishCh = channel('ci:mocha:test-suite:finish')
const testSuiteErrorCh = channel('ci:mocha:test-suite:error')
const testSuiteCodeCoverageCh = channel('ci:mocha:test-suite:code-coverage')

// session channels
const libraryConfigurationCh = channel('ci:mocha:library-configuration')
const knownTestsCh = channel('ci:mocha:known-tests')
const skippableSuitesCh = channel('ci:mocha:test-suite:skippable')
const workerReportTraceCh = channel('ci:mocha:worker-report:trace')
const testSessionStartCh = channel('ci:mocha:session:start')
const testSessionFinishCh = channel('ci:mocha:session:finish')
const itrSkippedSuitesCh = channel('ci:mocha:itr:skipped-suites')

function getFilteredSuites (originalSuites) {
  return originalSuites.reduce((acc, suite) => {
    const testPath = getTestSuitePath(suite.file, process.cwd())
    const shouldSkip = suitesToSkip.includes(testPath)
    const isUnskippable = unskippableSuites.includes(suite.file)
    if (shouldSkip && !isUnskippable) {
      acc.skippedSuites.add(testPath)
    } else {
      acc.suitesToRun.push(suite)
    }
    return acc
  }, { suitesToRun: [], skippedSuites: new Set() })
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

// In this hook we delay the execution with options.delay to grab library configuration,
// skippable and known tests.
// It is called but skipped in parallel mode.
addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/mocha.js'
}, (Mocha) => {
  const mochaRunAsyncResource = new AsyncResource('bound-anonymous-fn')
  shimmer.wrap(Mocha.prototype, 'run', run => function () {
    // Workers do not need to request any data, just run the tests
    if (!testStartCh.hasSubscribers || process.env.MOCHA_WORKER_ID || this.options.parallel) {
      return run.apply(this, arguments)
    }

    // `options.delay` does not work in parallel mode, so ITR and EFD can't work.
    // TODO: use `lib/cli/run-helpers.js#runMocha` to get the data in parallel mode.
    this.options.delay = true

    const runner = run.apply(this, arguments)

    this.files.forEach(path => {
      const isUnskippable = isMarkedAsUnskippable({ path })
      if (isUnskippable) {
        unskippableSuites.push(path)
      }
    })

    const onReceivedSkippableSuites = ({ err, skippableSuites, itrCorrelationId: responseItrCorrelationId }) => {
      if (err) {
        suitesToSkip = []
      } else {
        suitesToSkip = skippableSuites
        itrCorrelationId = responseItrCorrelationId
      }
      // We remove the suites that we skip through ITR
      const filteredSuites = getFilteredSuites(runner.suite.suites)
      const { suitesToRun } = filteredSuites

      isSuitesSkipped = suitesToRun.length !== runner.suite.suites.length

      log.debug(
        () => `${suitesToRun.length} out of ${runner.suite.suites.length} suites are going to run.`
      )

      runner.suite.suites = suitesToRun

      skippedSuites = Array.from(filteredSuites.skippedSuites)

      global.run()
    }

    const onReceivedKnownTests = ({ err, knownTests: receivedKnownTests }) => {
      if (err) {
        knownTests = []
        isEarlyFlakeDetectionEnabled = false
      } else {
        knownTests = receivedKnownTests
      }

      if (isSuitesSkippingEnabled) {
        skippableSuitesCh.publish({
          onDone: mochaRunAsyncResource.bind(onReceivedSkippableSuites)
        })
      } else {
        global.run()
      }
    }

    const onReceivedConfiguration = ({ err, libraryConfig }) => {
      if (err || !skippableSuitesCh.hasSubscribers || !knownTestsCh.hasSubscribers) {
        return global.run()
      }

      isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
      isSuitesSkippingEnabled = libraryConfig.isSuitesSkippingEnabled
      earlyFlakeDetectionNumRetries = libraryConfig.earlyFlakeDetectionNumRetries

      if (isEarlyFlakeDetectionEnabled) {
        knownTestsCh.publish({
          onDone: mochaRunAsyncResource.bind(onReceivedKnownTests)
        })
      } else if (isSuitesSkippingEnabled) {
        skippableSuitesCh.publish({
          onDone: mochaRunAsyncResource.bind(onReceivedSkippableSuites)
        })
      } else {
        global.run()
      }
    }

    mochaRunAsyncResource.runInAsyncScope(() => {
      libraryConfigurationCh.publish({
        onDone: mochaRunAsyncResource.bind(onReceivedConfiguration)
      })
    })

    return runner
  })
  return Mocha
})

// Only used to set `mocha.options.delay` to true in serial mode. When the mocha CLI is used,
// setting options.delay in Mocha#run is not enough to delay the execution.
// TODO: modify this hook to grab the data in parallel mode, so that ITR and EFD can work.
addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/cli/run-helpers.js'
}, (run) => {
  shimmer.wrap(run, 'runMocha', runMocha => async function () {
    if (!testStartCh.hasSubscribers) {
      return runMocha.apply(this, arguments)
    }
    const mocha = arguments[0]
    /**
     * This attaches `run` to the global context, which we'll call after
     * our configuration and skippable suites requests
     */
    if (!mocha.options.parallel) {
      mocha.options.delay = true
    }
    return runMocha.apply(this, arguments)
  })
  return run
})

// Only used in serial mode (no --parallel flag is passed)
// This hook is used to generate session, module, suite and test events
addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/runner.js'
}, function (Runner, frameworkVersion) {
  if (patched.has(Runner)) return Runner

  patched.add(Runner)

  shimmer.wrap(Runner.prototype, 'runTests', runTests => function (suite, fn) {
    if (isEarlyFlakeDetectionEnabled) {
      // by the time we reach `this.on('test')`, it is too late. We need to add retries here
      suite.tests.forEach(test => {
        if (!test.isPending() && isNewTest(test, knownTests)) {
          test._ddIsNew = true
          retryTest(test, earlyFlakeDetectionNumRetries)
        }
      })
    }
    return runTests.apply(this, arguments)
  })

  shimmer.wrap(Runner.prototype, 'run', run => function () {
    if (!testStartCh.hasSubscribers) {
      return run.apply(this, arguments)
    }

    const { suitesByTestFile, numSuitesByTestFile } = getSuitesByTestFile(this.suite)

    this.once('start', testSessionAsyncResource.bind(function () {
      const processArgv = process.argv.slice(2).join(' ')
      const command = `mocha ${processArgv}`
      testSessionStartCh.publish({ command, frameworkVersion })
      if (skippedSuites.length) {
        itrSkippedSuitesCh.publish({ skippedSuites, frameworkVersion })
      }
    }))

    this.once('end', testSessionAsyncResource.bind(function () {
      let status = 'pass'
      let error
      if (this.stats) {
        status = this.stats.failures === 0 ? 'pass' : 'fail'
        if (this.stats.tests === 0) {
          status = 'skip'
        }
      } else if (this.failures !== 0) {
        status = 'fail'
      }

      if (isEarlyFlakeDetectionEnabled) {
        /**
         * If Early Flake Detection (EFD) is enabled the logic is as follows:
         * - If all attempts for a test are failing, the test has failed and we will let the test process fail.
         * - If just a single attempt passes, we will prevent the test process from failing.
         * The rationale behind is the following: you may still be able to block your CI pipeline by gating
         * on flakiness (the test will be considered flaky), but you may choose to unblock the pipeline too.
         */
        for (const tests of Object.values(newTests)) {
          const failingNewTests = tests.filter(test => test.isFailed())
          const areAllNewTestsFailing = failingNewTests.length === tests.length
          if (failingNewTests.length && !areAllNewTestsFailing) {
            this.stats.failures -= failingNewTests.length
            this.failures -= failingNewTests.length
          }
        }
      }

      if (status === 'fail') {
        error = new Error(`Failed tests: ${this.failures}.`)
      }

      testFileToSuiteAr.clear()

      let testCodeCoverageLinesTotal
      if (global.__coverage__) {
        try {
          testCodeCoverageLinesTotal = originalCoverageMap.getCoverageSummary().lines.pct
        } catch (e) {
          // ignore errors
        }
        // restore the original coverage
        global.__coverage__ = fromCoverageMapToCoverage(originalCoverageMap)
      }

      testSessionFinishCh.publish({
        status,
        isSuitesSkipped,
        testCodeCoverageLinesTotal,
        numSkippedSuites: skippedSuites.length,
        hasForcedToRunSuites: isForcedToRun,
        hasUnskippableSuites: !!unskippableSuites.length,
        error,
        isEarlyFlakeDetectionEnabled
      })
    }))

    this.on('test', (test) => {
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
        isNew,
        isEfdRetry,
        testStartLine
      }

      // We want to store the result of the new tests
      if (isNew) {
        const testFullName = getTestFullName(test)
        if (newTests[testFullName]) {
          newTests[testFullName].push(test)
        } else {
          newTests[testFullName] = [test]
        }
      }

      asyncResource.runInAsyncScope(() => {
        testStartCh.publish(testInfo)
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
    })

    this.on('suite', function (suite) {
      if (suite.root || !suite.tests.length) {
        return
      }
      let asyncResource = testFileToSuiteAr.get(suite.file)
      if (!asyncResource) {
        asyncResource = new AsyncResource('bound-anonymous-fn')
        testFileToSuiteAr.set(suite.file, asyncResource)
        const isUnskippable = unskippableSuites.includes(suite.file)
        isForcedToRun = isUnskippable && suitesToSkip.includes(getTestSuitePath(suite.file, process.cwd()))
        asyncResource.runInAsyncScope(() => {
          testSuiteStartCh.publish({
            testSuiteAbsolutePath: suite.file,
            isUnskippable,
            isForcedToRun,
            itrCorrelationId
          })
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

    return run.apply(this, arguments)
  })

  return Runner
})

// Used both in serial and parallel mode:
// In serial mode, this hook is used to set the correct async resource to the test.
// In parallel mode, the same hook is executed in the worker, so this needs to be repeated in
// mocha/worker.js
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

        // Temporarily keep functionality when .asyncResource is removed from node
        // in https://github.com/nodejs/node/pull/46432
        if (!this.fn.asyncResource) {
          this.fn.asyncResource = asyncResource
        }
      }
    }

    return run.apply(this, arguments)
  })
  return Runnable
})

// Only used in parallel mode (--parallel flag is passed)
// Used to generate suite events and receive test payloads from workers
addHook({
  name: 'workerpool',
  // mocha@8.0.0 added parallel support and uses workerpool for it
  // The version they use is 6.0.0:
  // https://github.com/mochajs/mocha/blob/612fa31228c695f16173ac675f40ccdf26b4cfb5/package.json#L75
  versions: ['>=6.0.0'],
  file: 'src/WorkerHandler.js'
}, (workerHandlerPackage) => {
  shimmer.wrap(workerHandlerPackage.prototype, 'exec', exec => async function (message, [testSuiteAbsolutePath]) {
    if (!testStartCh.hasSubscribers) {
      return exec.apply(this, arguments)
    }
    this.worker.on('message', function (message) {
      if (Array.isArray(message)) {
        const [messageCode, payload] = message
        if (messageCode === MOCHA_WORKER_TRACE_PAYLOAD_CODE) {
          testSessionAsyncResource.runInAsyncScope(() => {
            workerReportTraceCh.publish(payload)
          })
        }
      }
    })

    const testSuiteAsyncResource = new AsyncResource('bound-anonymous-fn')
    testSuiteAsyncResource.runInAsyncScope(() => {
      testSuiteStartCh.publish({
        testSuiteAbsolutePath
      })
    })

    const result = await exec.apply(this, arguments)

    const status = result.failureCount === 0 ? 'pass' : 'fail'
    testSuiteAsyncResource.runInAsyncScope(() => {
      testSuiteFinishCh.publish(status)
    })

    return result
  })

  return workerHandlerPackage
})

// Only used in parallel mode (--parallel flag is passed)
// Used to start and finish test session and test module
addHook({
  name: 'mocha',
  versions: ['>=8.0.0'],
  file: 'lib/nodejs/parallel-buffered-runner.js'
}, (ParallelBufferedRunner, frameworkVersion) => {
  shimmer.wrap(ParallelBufferedRunner.prototype, 'run', run => function () {
    if (!testStartCh.hasSubscribers) {
      return run.apply(this, arguments)
    }
    this.once('start', testSessionAsyncResource.bind(function () {
      const processArgv = process.argv.slice(2).join(' ')
      const command = `mocha ${processArgv}`
      testSessionStartCh.publish({ command, frameworkVersion })
    }))

    this.once('end', testSessionAsyncResource.bind(function () {
      let status = 'pass'
      let error
      if (this.stats) {
        status = this.stats.failures === 0 ? 'pass' : 'fail'
        if (this.stats.tests === 0) {
          status = 'skip'
        }
      } else if (this.failures !== 0) {
        status = 'fail'
      }

      if (status === 'fail') {
        error = new Error(`Failed tests: ${this.failures}.`)
      }

      testFileToSuiteAr.clear()

      let testCodeCoverageLinesTotal
      if (global.__coverage__) {
        try {
          testCodeCoverageLinesTotal = originalCoverageMap.getCoverageSummary().lines.pct
        } catch (e) {
          // ignore errors
        }
        // restore the original coverage
        global.__coverage__ = fromCoverageMapToCoverage(originalCoverageMap)
      }

      testSessionFinishCh.publish({
        status,
        testCodeCoverageLinesTotal,
        error,
        isParallel: true
      })
    }))

    return run.apply(this, arguments)
  })

  return ParallelBufferedRunner
})
