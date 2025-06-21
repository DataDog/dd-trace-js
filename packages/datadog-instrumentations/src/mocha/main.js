'use strict'

const { createCoverageMap } = require('istanbul-lib-coverage')
const { addHook, channel } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const { isMarkedAsUnskippable } = require('../../../datadog-plugin-jest/src/util')
const log = require('../../../dd-trace/src/log')
const { getEnvironmentVariable } = require('../../../dd-trace/src/config-helper')
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
  getTestProperties,
  getSuitesByTestFile,
  runnableWrapper,
  getOnTestHandler,
  getOnTestEndHandler,
  getOnTestRetryHandler,
  getOnHookEndHandler,
  getOnFailHandler,
  getOnPendingHandler,
  testFileToSuiteCtx,
  newTests,
  testsQuarantined,
  getTestFullName,
  getRunTestsWrapper,
  testsAttemptToFix,
  testsStatuses
} = require('./utils')

require('./common')

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
const testFinishCh = channel('ci:mocha:test:finish')

// test suite channels
const testSuiteStartCh = channel('ci:mocha:test-suite:start')
const testSuiteFinishCh = channel('ci:mocha:test-suite:finish')
const testSuiteErrorCh = channel('ci:mocha:test-suite:error')
const testSuiteCodeCoverageCh = channel('ci:mocha:test-suite:code-coverage')

// session channels
const libraryConfigurationCh = channel('ci:mocha:library-configuration')
const knownTestsCh = channel('ci:mocha:known-tests')
const skippableSuitesCh = channel('ci:mocha:test-suite:skippable')
const mochaGlobalRunCh = channel('ci:mocha:global:run')

const testManagementTestsCh = channel('ci:mocha:test-management-tests')
const impactedTestsCh = channel('ci:mocha:modified-tests')
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
    return !test.isPending() && test.state === 'failed'
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
  return function () {
    const processArgv = process.argv.slice(2).join(' ')
    const command = `mocha ${processArgv}`
    testSessionStartCh.publish({ command, frameworkVersion })
    if (!isParallel && skippedSuites.length) {
      itrSkippedSuitesCh.publish({ skippedSuites, frameworkVersion })
    }
  }
}

function getOnEndHandler (isParallel) {
  return function () {
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

    // We substract the errors of attempt to fix tests (quarantined or disabled) from the total number of failures
    // We subtract the errors from quarantined tests from the total number of failures
    if (config.isTestManagementTestsEnabled) {
      let numFailedQuarantinedTests = 0
      let numFailedRetriedQuarantinedOrDisabledTests = 0
      for (const test of testsAttemptToFix) {
        const testName = getTestFullName(test)
        const testProperties = getTestProperties(test, config.testManagementTests)
        if (isTestFailed(test) && (testProperties.isQuarantined || testProperties.isDisabled)) {
          const numFailedTests = testsStatuses.get(testName).filter(status => status === 'fail').length
          numFailedRetriedQuarantinedOrDisabledTests += numFailedTests
        }
      }
      for (const test of testsQuarantined) {
        if (isTestFailed(test)) {
          numFailedQuarantinedTests++
        }
      }
      this.stats.failures -= numFailedQuarantinedTests + numFailedRetriedQuarantinedOrDisabledTests
      this.failures -= numFailedQuarantinedTests + numFailedRetriedQuarantinedOrDisabledTests
    }

    if (status === 'fail') {
      error = new Error(`Failed tests: ${this.failures}.`)
    }

    testFileToSuiteCtx.clear()

    let testCodeCoverageLinesTotal
    if (global.__coverage__) {
      try {
        if (untestedCoverage) {
          originalCoverageMap.merge(fromCoverageMapToCoverage(untestedCoverage))
        }
        testCodeCoverageLinesTotal = originalCoverageMap.getCoverageSummary().lines.pct
      } catch {
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
      isTestManagementEnabled: config.isTestManagementTestsEnabled,
      isParallel
    })
  }
}

function getExecutionConfiguration (runner, isParallel, frameworkVersion, onFinishRequest) {
  const ctx = {
    isParallel,
    frameworkVersion
  }

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

    skippedSuites = [...filteredSuites.skippedSuites]

    mochaGlobalRunCh.runStores(ctx, () => {
      onFinishRequest()
    })
  }

  const onReceivedImpactedTests = ({ err, modifiedTests: receivedModifiedTests }) => {
    if (err) {
      config.modifiedTests = []
      config.isImpactedTestsEnabled = false
    } else {
      config.modifiedTests = receivedModifiedTests
    }
    if (config.isSuitesSkippingEnabled) {
      ctx.onDone = onReceivedSkippableSuites
      skippableSuitesCh.runStores(ctx, () => {})
    } else {
      mochaGlobalRunCh.runStores(ctx, () => {
        onFinishRequest()
      })
    }
  }

  const onReceivedTestManagementTests = ({ err, testManagementTests: receivedTestManagementTests }) => {
    if (err) {
      config.testManagementTests = {}
      config.isTestManagementTestsEnabled = false
      config.testManagementAttemptToFixRetries = 0
    } else {
      config.testManagementTests = receivedTestManagementTests
    }
    if (config.isImpactedTestsEnabled) {
      ctx.onDone = onReceivedImpactedTests
      impactedTestsCh.runStores(ctx, () => {})
    } else if (config.isSuitesSkippingEnabled) {
      ctx.onDone = onReceivedSkippableSuites
      skippableSuitesCh.runStores(ctx, () => {})
    } else {
      mochaGlobalRunCh.runStores(ctx, () => {
        onFinishRequest()
      })
    }
  }

  const onReceivedKnownTests = ({ err, knownTests }) => {
    if (err) {
      config.knownTests = []
      config.isEarlyFlakeDetectionEnabled = false
      config.isKnownTestsEnabled = false
    } else {
      config.knownTests = knownTests
    }
    if (config.isTestManagementTestsEnabled) {
      ctx.onDone = onReceivedTestManagementTests
      testManagementTestsCh.runStores(ctx, () => {})
    } if (config.isImpactedTestsEnabled) {
      ctx.onDone = onReceivedImpactedTests
      impactedTestsCh.runStores(ctx, () => {})
    } else if (config.isSuitesSkippingEnabled) {
      ctx.onDone = onReceivedSkippableSuites
      skippableSuitesCh.runStores(ctx, () => {})
    } else {
      mochaGlobalRunCh.runStores(ctx, () => {
        onFinishRequest()
      })
    }
  }

  const onReceivedConfiguration = ({ err, libraryConfig }) => {
    if (err || !skippableSuitesCh.hasSubscribers || !knownTestsCh.hasSubscribers) {
      return mochaGlobalRunCh.runStores(ctx, () => {
        onFinishRequest()
      })
    }
    config.isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
    config.earlyFlakeDetectionNumRetries = libraryConfig.earlyFlakeDetectionNumRetries
    config.earlyFlakeDetectionFaultyThreshold = libraryConfig.earlyFlakeDetectionFaultyThreshold
    config.isKnownTestsEnabled = libraryConfig.isKnownTestsEnabled
    config.isTestManagementTestsEnabled = libraryConfig.isTestManagementEnabled
    config.testManagementAttemptToFixRetries = libraryConfig.testManagementAttemptToFixRetries
    config.isImpactedTestsEnabled = libraryConfig.isImpactedTestsEnabled
    // ITR and auto test retries are not supported in parallel mode yet
    config.isSuitesSkippingEnabled = !isParallel && libraryConfig.isSuitesSkippingEnabled
    config.isFlakyTestRetriesEnabled = !isParallel && libraryConfig.isFlakyTestRetriesEnabled
    config.flakyTestRetriesCount = !isParallel && libraryConfig.flakyTestRetriesCount

    if (config.isKnownTestsEnabled) {
      ctx.onDone = onReceivedKnownTests
      knownTestsCh.runStores(ctx, () => {})
    } else if (config.isTestManagementTestsEnabled) {
      ctx.onDone = onReceivedTestManagementTests
      testManagementTestsCh.runStores(ctx, () => {})
    } else if (config.isImpactedTestsEnabled) {
      ctx.onDone = onReceivedImpactedTests
      impactedTestsCh.runStores(ctx, () => {})
    } else if (config.isSuitesSkippingEnabled) {
      ctx.onDone = onReceivedSkippableSuites
      skippableSuitesCh.runStores(ctx, () => {})
    } else {
      mochaGlobalRunCh.runStores(ctx, () => {
        onFinishRequest()
      })
    }
  }

  ctx.onDone = onReceivedConfiguration

  libraryConfigurationCh.runStores(ctx, () => {})
}

// In this hook we delay the execution with options.delay to grab library configuration,
// skippable and known tests.
// It is called but skipped in parallel mode.
addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/mocha.js'
}, (Mocha, frameworkVersion) => {
  shimmer.wrap(Mocha.prototype, 'run', run => function () {
    // Workers do not need to request any data, just run the tests
    if (!testFinishCh.hasSubscribers || getEnvironmentVariable('MOCHA_WORKER_ID') || this.options.parallel) {
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

    getExecutionConfiguration(runner, false, frameworkVersion, () => {
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
  // `runMocha` is an async function
  shimmer.wrap(run, 'runMocha', runMocha => function () {
    if (!testFinishCh.hasSubscribers) {
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
    if (!testFinishCh.hasSubscribers) {
      return run.apply(this, arguments)
    }

    const { suitesByTestFile, numSuitesByTestFile } = getSuitesByTestFile(this.suite)

    this.once('start', getOnStartHandler(false, frameworkVersion))

    this.once('end', getOnEndHandler(false))

    this.on('test', getOnTestHandler(true))

    this.on('test end', getOnTestEndHandler(config))

    this.on('retry', getOnTestRetryHandler(config))

    // If the hook passes, 'hook end' will be emitted. Otherwise, 'fail' will be emitted
    this.on('hook end', getOnHookEndHandler())

    this.on('fail', getOnFailHandler(true))

    this.on('pending', getOnPendingHandler())

    this.on('suite', function (suite) {
      if (suite.root || !suite.tests.length) {
        return
      }
      let ctx = testFileToSuiteCtx.get(suite.file)
      if (!ctx) {
        const isUnskippable = unskippableSuites.includes(suite.file)
        isForcedToRun = isUnskippable && suitesToSkip.includes(getTestSuitePath(suite.file, process.cwd()))
        ctx = {
          testSuiteAbsolutePath: suite.file,
          isUnskippable,
          isForcedToRun,
          itrCorrelationId
        }
        testFileToSuiteCtx.set(suite.file, ctx)
        testSuiteStartCh.runStores(ctx, () => {})
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

      const ctx = testFileToSuiteCtx.get(suite.file)
      if (ctx) {
        testSuiteFinishCh.publish({ status, ...ctx.currentStore }, () => {})
      } else {
        log.warn('No ctx found for suite', suite.file)
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

function onMessage (message) {
  if (Array.isArray(message)) {
    const [messageCode, payload] = message
    if (messageCode === MOCHA_WORKER_TRACE_PAYLOAD_CODE) {
      workerReportTraceCh.publish(payload)
    }
  }
}

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
    if (!testFinishCh.hasSubscribers) {
      return exec.apply(this, arguments)
    }
    if (!path?.length) {
      return exec.apply(this, arguments)
    }
    const [testSuiteAbsolutePath] = path
    const testSuiteContext = {}

    this.worker.on('message', onMessage)

    testSuiteContext.testSuiteAbsolutePath = testSuiteAbsolutePath
    testSuiteStartCh.runStores(testSuiteContext, () => {})

    try {
      const promise = exec.apply(this, arguments)
      promise.then(
        (result) => {
          const status = result.failureCount === 0 ? 'pass' : 'fail'
          testSuiteFinishCh.publish({ status, ...testSuiteContext.currentStore }, () => {})
          this.worker.off('message', onMessage)
        },
        (err) => {
          testSuiteContext.error = err
          testSuiteErrorCh.runStores(testSuiteContext, () => {})
          testSuiteFinishCh.publish({ status: 'fail', ...testSuiteContext.currentStore }, () => {})
          this.worker.off('message', onMessage)
        }
      )
      return promise
    } catch (err) {
      testSuiteContext.error = err
      testSuiteErrorCh.runStores(testSuiteContext, () => {})
      testSuiteFinishCh.publish({ status: 'fail', ...testSuiteContext.currentStore }, () => {})
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
    if (!testFinishCh.hasSubscribers) {
      return run.apply(this, arguments)
    }

    this.once('start', getOnStartHandler(true, frameworkVersion))
    this.once('end', getOnEndHandler(true))

    getExecutionConfiguration(this, true, frameworkVersion, () => {
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
    if (!testFinishCh.hasSubscribers ||
        (!config.isKnownTestsEnabled &&
         !config.isTestManagementTestsEnabled &&
         !config.isImpactedTestsEnabled)) {
      return run.apply(this, arguments)
    }

    const testPath = getTestSuitePath(testSuiteAbsolutePath, process.cwd())

    const newWorkerArgs = { ...workerArgs }

    if (config.isKnownTestsEnabled) {
      const testSuiteKnownTests = config.knownTests.mocha?.[testPath] || []
      newWorkerArgs._ddEfdNumRetries = config.earlyFlakeDetectionNumRetries
      newWorkerArgs._ddIsEfdEnabled = config.isEarlyFlakeDetectionEnabled
      newWorkerArgs._ddIsKnownTestsEnabled = true
      newWorkerArgs._ddKnownTests = {
        mocha: {
          [testPath]: testSuiteKnownTests
        }
      }
    }
    if (config.isTestManagementTestsEnabled) {
      const testSuiteTestManagementTests = config.testManagementTests?.mocha?.suites?.[testPath] || {}
      newWorkerArgs._ddIsTestManagementTestsEnabled = true
      // TODO: attempt to fix does not work in parallel mode yet
      // newWorkerArgs._ddTestManagementAttemptToFixRetries = config.testManagementAttemptToFixRetries
      newWorkerArgs._ddTestManagementTests = {
        mocha: {
          suites: {
            [testPath]: testSuiteTestManagementTests
          }
        }
      }
    }

    if (config.isImpactedTestsEnabled) {
      const testSuiteImpactedTests = config.modifiedTests || {}
      newWorkerArgs._ddIsImpactedTestsEnabled = true
      newWorkerArgs._ddModifiedTests = testSuiteImpactedTests
    }

    // We pass the known tests for the test file to the worker
    const testFileResult = await run.apply(
      this,
      [
        testSuiteAbsolutePath,
        newWorkerArgs
      ]
    )

    const tests = testFileResult
      .events
      .filter(event => event.eventName === 'test end')
      .map(event => event.data)

    for (const test of tests) {
      // `newTests` is filled in the worker process, so we need to use the test results to fill it here too.
      if (config.isKnownTestsEnabled && isNewTest(test, config.knownTests)) {
        const testFullName = getTestFullName(test)
        const tests = newTests[testFullName]

        if (tests) {
          tests.push(test)
        } else {
          newTests[testFullName] = [test]
        }
      }
      // `testsQuarantined` is filled in the worker process, so we need to use the test results to fill it here too.
      if (config.isTestManagementTestsEnabled && getTestProperties(test, config.testManagementTests).isQuarantined) {
        testsQuarantined.add(test)
      }
    }
    return testFileResult
  })

  return BufferedWorkerPoolPackage
})
