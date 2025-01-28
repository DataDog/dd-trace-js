'use strict'

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
  resetCoverage,
  getIsFaultyEarlyFlakeDetection
} = require('../../../dd-trace/src/plugins/util/test')

const {
  isNewTest,
  getSuitesByTestFile,
  runnableWrapper,
  getOnTestHandler,
  getOnTestEndHandler,
  getOnTestRetryHandler,
  getOnHookEndHandler,
  getOnFailHandler,
  getOnPendingHandler,
  testFileToSuiteAr,
  newTests,
  getTestFullName,
  getRunTestsWrapper
} = require('./utils')

require('./common')

const testSessionAsyncResource = new AsyncResource('bound-anonymous-fn')
const patched = new WeakSet()

const unskippableSuites = []
let suitesToSkip = []
let isSuitesSkipped = false
let skippedSuites = []
let itrCorrelationId = ''
let isForcedToRun = false
const config = {}

// We'll preserve the original coverage here
const originalCoverageMap = createCoverageMap()
let untestedCoverage

// test channels
const testStartCh = channel('ci:mocha:test:start')

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

const getCodeCoverageCh = channel('ci:nyc:get-coverage')

// Tests from workers do not come with `isFailed` method
function isTestFailed (test) {
  if (test.isFailed) {
    return test.isFailed()
  }
  if (test.isPending) {
    return !test.isPending() && test.state !== 'failed'
  }
  return false
}

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

function getOnStartHandler (isParallel, frameworkVersion) {
  return testSessionAsyncResource.bind(function () {
    const processArgv = process.argv.slice(2).join(' ')
    const command = `mocha ${processArgv}`
    testSessionStartCh.publish({ command, frameworkVersion })
    if (!isParallel && skippedSuites.length) {
      itrSkippedSuitesCh.publish({ skippedSuites, frameworkVersion })
    }
  })
}

function getOnEndHandler (isParallel) {
  return testSessionAsyncResource.bind(function () {
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

    if (config.isEarlyFlakeDetectionEnabled) {
      /**
       * If Early Flake Detection (EFD) is enabled the logic is as follows:
       * - If all attempts for a test are failing, the test has failed and we will let the test process fail.
       * - If just a single attempt passes, we will prevent the test process from failing.
       * The rationale behind is the following: you may still be able to block your CI pipeline by gating
       * on flakiness (the test will be considered flaky), but you may choose to unblock the pipeline too.
       */
      for (const tests of Object.values(newTests)) {
        const failingNewTests = tests.filter(test => isTestFailed(test))
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
        if (untestedCoverage) {
          originalCoverageMap.merge(fromCoverageMapToCoverage(untestedCoverage))
        }
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
      isEarlyFlakeDetectionEnabled: config.isEarlyFlakeDetectionEnabled,
      isEarlyFlakeDetectionFaulty: config.isEarlyFlakeDetectionFaulty,
      isParallel
    })
  })
}

function getExecutionConfiguration (runner, isParallel, onFinishRequest) {
  const mochaRunAsyncResource = new AsyncResource('bound-anonymous-fn')

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

    onFinishRequest()
  }

  const onReceivedKnownTests = ({ err, knownTests }) => {
    if (err) {
      config.knownTests = []
      config.isEarlyFlakeDetectionEnabled = false
      config.isKnownTestsEnabled = false
    } else {
      config.knownTests = knownTests
    }

    if (config.isSuitesSkippingEnabled) {
      skippableSuitesCh.publish({
        onDone: mochaRunAsyncResource.bind(onReceivedSkippableSuites)
      })
    } else {
      onFinishRequest()
    }
  }

  const onReceivedConfiguration = ({ err, libraryConfig }) => {
    if (err || !skippableSuitesCh.hasSubscribers || !knownTestsCh.hasSubscribers) {
      return onFinishRequest()
    }

    config.isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
    config.earlyFlakeDetectionNumRetries = libraryConfig.earlyFlakeDetectionNumRetries
    config.earlyFlakeDetectionFaultyThreshold = libraryConfig.earlyFlakeDetectionFaultyThreshold
    config.isKnownTestsEnabled = libraryConfig.isKnownTestsEnabled
    // ITR and auto test retries are not supported in parallel mode yet
    config.isSuitesSkippingEnabled = !isParallel && libraryConfig.isSuitesSkippingEnabled
    config.isFlakyTestRetriesEnabled = !isParallel && libraryConfig.isFlakyTestRetriesEnabled
    config.flakyTestRetriesCount = !isParallel && libraryConfig.flakyTestRetriesCount

    if (config.isKnownTestsEnabled) {
      knownTestsCh.publish({
        onDone: mochaRunAsyncResource.bind(onReceivedKnownTests)
      })
    } else if (config.isSuitesSkippingEnabled) {
      skippableSuitesCh.publish({
        onDone: mochaRunAsyncResource.bind(onReceivedSkippableSuites)
      })
    } else {
      onFinishRequest()
    }
  }

  libraryConfigurationCh.publish({
    onDone: mochaRunAsyncResource.bind(onReceivedConfiguration)
  })
}

// In this hook we delay the execution with options.delay to grab library configuration,
// skippable and known tests.
// It is called but skipped in parallel mode.
addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/mocha.js'
}, (Mocha) => {
  shimmer.wrap(Mocha.prototype, 'run', run => function () {
    // Workers do not need to request any data, just run the tests
    if (!testStartCh.hasSubscribers || process.env.MOCHA_WORKER_ID || this.options.parallel) {
      return run.apply(this, arguments)
    }

    // `options.delay` does not work in parallel mode, so we can't delay the execution this way
    // This needs to be both here and in `runMocha` hook. Read the comment in `runMocha` hook for more info.
    this.options.delay = true

    const runner = run.apply(this, arguments)

    this.files.forEach(path => {
      const isUnskippable = isMarkedAsUnskippable({ path })
      if (isUnskippable) {
        unskippableSuites.push(path)
      }
    })

    getExecutionConfiguration(runner, false, () => {
      if (config.isKnownTestsEnabled) {
        const testSuites = this.files.map(file => getTestSuitePath(file, process.cwd()))
        const isFaulty = getIsFaultyEarlyFlakeDetection(
          testSuites,
          config.knownTests?.mocha || {},
          config.earlyFlakeDetectionFaultyThreshold
        )
        if (isFaulty) {
          config.isEarlyFlakeDetectionEnabled = false
          config.isEarlyFlakeDetectionFaulty = true
          config.isKnownTestsEnabled = false
        }
      }
      if (getCodeCoverageCh.hasSubscribers) {
        getCodeCoverageCh.publish({
          onDone: (receivedCodeCoverage) => {
            untestedCoverage = receivedCodeCoverage
            global.run()
          }
        })
      } else {
        global.run()
      }
    })

    return runner
  })
  return Mocha
})

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
     * our configuration and skippable suites requests.
     * You need this both here and in Mocha#run hook: the programmatic API
     * does not call `runMocha`, so it needs to be in Mocha#run. When using
     * the CLI, modifying `options.delay` in Mocha#run is not enough (it's too late),
     * so it also needs to be here.
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

  shimmer.wrap(Runner.prototype, 'runTests', runTests => getRunTestsWrapper(runTests, config))

  shimmer.wrap(Runner.prototype, 'run', run => function () {
    if (!testStartCh.hasSubscribers) {
      return run.apply(this, arguments)
    }

    const { suitesByTestFile, numSuitesByTestFile } = getSuitesByTestFile(this.suite)

    this.once('start', getOnStartHandler(false, frameworkVersion))

    this.once('end', getOnEndHandler(false))

    this.on('test', getOnTestHandler(true, newTests))

    this.on('test end', getOnTestEndHandler())

    this.on('retry', getOnTestRetryHandler())

    // If the hook passes, 'hook end' will be emitted. Otherwise, 'fail' will be emitted
    this.on('hook end', getOnHookEndHandler())

    this.on('fail', getOnFailHandler(true))

    this.on('pending', getOnPendingHandler())

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
      if (asyncResource) {
        asyncResource.runInAsyncScope(() => {
          testSuiteFinishCh.publish(status)
        })
      } else {
        log.warn(() => `No AsyncResource found for suite ${suite.file}`)
      }
    })

    return run.apply(this, arguments)
  })

  return Runner
})

// Used both in serial and parallel mode, and by both the main process and the workers
// Used to set the correct async resource to the test.
addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/runnable.js'
}, (runnablePackage) => runnableWrapper(runnablePackage, config))

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
  shimmer.wrap(workerHandlerPackage.prototype, 'exec', exec => function (_, path) {
    if (!testStartCh.hasSubscribers) {
      return exec.apply(this, arguments)
    }
    if (!path?.length) {
      return exec.apply(this, arguments)
    }
    const [testSuiteAbsolutePath] = path
    const testSuiteAsyncResource = new AsyncResource('bound-anonymous-fn')

    function onMessage (message) {
      if (Array.isArray(message)) {
        const [messageCode, payload] = message
        if (messageCode === MOCHA_WORKER_TRACE_PAYLOAD_CODE) {
          testSuiteAsyncResource.runInAsyncScope(() => {
            workerReportTraceCh.publish(payload)
          })
        }
      }
    }

    this.worker.on('message', onMessage)

    testSuiteAsyncResource.runInAsyncScope(() => {
      testSuiteStartCh.publish({
        testSuiteAbsolutePath
      })
    })

    try {
      const promise = exec.apply(this, arguments)
      promise.then(
        (result) => {
          const status = result.failureCount === 0 ? 'pass' : 'fail'
          testSuiteAsyncResource.runInAsyncScope(() => {
            testSuiteFinishCh.publish(status)
          })
          this.worker.off('message', onMessage)
        },
        (err) => {
          testSuiteAsyncResource.runInAsyncScope(() => {
            testSuiteErrorCh.publish(err)
            testSuiteFinishCh.publish('fail')
          })
          this.worker.off('message', onMessage)
        }
      )
      return promise
    } catch (err) {
      testSuiteAsyncResource.runInAsyncScope(() => {
        testSuiteErrorCh.publish(err)
        testSuiteFinishCh.publish('fail')
      })
      this.worker.off('message', onMessage)
      throw err
    }
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
  shimmer.wrap(ParallelBufferedRunner.prototype, 'run', run => function (cb, { files }) {
    if (!testStartCh.hasSubscribers) {
      return run.apply(this, arguments)
    }

    this.once('start', getOnStartHandler(true, frameworkVersion))
    this.once('end', getOnEndHandler(true))

    getExecutionConfiguration(this, true, () => {
      if (config.isKnownTestsEnabled) {
        const testSuites = files.map(file => getTestSuitePath(file, process.cwd()))
        const isFaulty = getIsFaultyEarlyFlakeDetection(
          testSuites,
          config.knownTests?.mocha || {},
          config.earlyFlakeDetectionFaultyThreshold
        )
        if (isFaulty) {
          config.isKnownTestsEnabled = false
          config.isEarlyFlakeDetectionEnabled = false
          config.isEarlyFlakeDetectionFaulty = true
        }
      }
      run.apply(this, arguments)
    })

    return this
  })

  return ParallelBufferedRunner
})

// Only in parallel mode: BufferedWorkerPool#run is used to run a test file in a worker
// If Early Flake Detection is enabled,
// In this hook we pass the known tests to the worker and collect the new tests that run
addHook({
  name: 'mocha',
  versions: ['>=8.0.0'],
  file: 'lib/nodejs/buffered-worker-pool.js'
}, (BufferedWorkerPoolPackage) => {
  const { BufferedWorkerPool } = BufferedWorkerPoolPackage

  shimmer.wrap(BufferedWorkerPool.prototype, 'run', run => async function (testSuiteAbsolutePath, workerArgs) {
    if (!testStartCh.hasSubscribers || !config.isKnownTestsEnabled) {
      return run.apply(this, arguments)
    }

    const testPath = getTestSuitePath(testSuiteAbsolutePath, process.cwd())
    const testSuiteKnownTests = config.knownTests.mocha?.[testPath] || []

    // We pass the known tests for the test file to the worker
    const testFileResult = await run.apply(
      this,
      [
        testSuiteAbsolutePath,
        {
          ...workerArgs,
          _ddEfdNumRetries: config.earlyFlakeDetectionNumRetries,
          _ddIsEfdEnabled: config.isEarlyFlakeDetectionEnabled,
          _ddKnownTests: {
            mocha: {
              [testPath]: testSuiteKnownTests
            }
          }
        }
      ]
    )
    const tests = testFileResult
      .events
      .filter(event => event.eventName === 'test end')
      .map(event => event.data)

    // `newTests` is filled in the worker process, so we need to use the test results to fill it here too.
    for (const test of tests) {
      if (isNewTest(test, config.knownTests)) {
        const testFullName = getTestFullName(test)
        const tests = newTests[testFullName]

        if (!tests) {
          newTests[testFullName] = [test]
        } else {
          tests.push(test)
        }
      }
    }
    return testFileResult
  })

  return BufferedWorkerPoolPackage
})
