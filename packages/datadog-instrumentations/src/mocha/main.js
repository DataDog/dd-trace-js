'use strict'

const { createCoverageMap } = require('../../../../vendor/dist/istanbul-lib-coverage')
const satisfies = require('../../../../vendor/dist/semifies')
const { DD_MAJOR } = require('../../../../version')
const { addHook, channel } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const { isMarkedAsUnskippable } = require('../../../datadog-plugin-jest/src/util')
const { writeCoverageBackfillToCache } = require('../../../dd-trace/src/ci-visibility/test-optimization-cache')
const log = require('../../../dd-trace/src/log')
const { getEnvironmentVariable } = require('../../../dd-trace/src/config/helper')
const {
  getTestSuitePath,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  fromCoverageMapToCoverage,
  getCoveredFilesFromCoverage,
  getExecutableFilesFromCoverage,
  applySkippedCoverageToCoverage,
  mergeCoverage,
  resetCoverage,
  getIsFaultyEarlyFlakeDetection,
  getRelativeCoverageFiles,
  getTestCoverageLinesPercentage,
  collectTestOptimizationSummariesFromTraces,
  logTestOptimizationSummary,
  getTestOptimizationRequestResults,
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
  newTestsWithDynamicNames,
  attemptToFixExecutions,
  loggedAttemptToFixTests,
} = require('./utils')

require('./common')

const MINIMUM_MOCHA_VERSION = DD_MAJOR >= 6 ? '>=8.0.0' : '>=5.2.0'

const patched = new WeakSet()
let hasWarnedDeprecatedMochaVersion = false

const unskippableSuites = []
let suitesToSkip = []
let isSuitesSkipped = false
let skippedSuites = []
let skippableSuitesCoverage = {}
let skippedSuitesCoverage = {}
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
const modifiedFilesCh = channel('ci:mocha:modified-files')
const workerReportTraceCh = channel('ci:mocha:worker-report:trace')
const testSessionStartCh = channel('ci:mocha:session:start')
const testSessionFinishCh = channel('ci:mocha:session:finish')
const itrSkippedSuitesCh = channel('ci:mocha:itr:skipped-suites')

const getCodeCoverageCh = channel('ci:nyc:get-coverage')

function warnDeprecatedMochaVersion (frameworkVersion) {
  if (DD_MAJOR >= 6 || hasWarnedDeprecatedMochaVersion || !frameworkVersion ||
      !satisfies(frameworkVersion, '<8.0.0')) {
    return
  }

  hasWarnedDeprecatedMochaVersion = true
  // eslint-disable-next-line no-console
  console.warn(
    'dd-trace support for Mocha<8.0.0 is deprecated and will be removed in dd-trace v6. ' +
      'Please upgrade Mocha to >=8.0.0.'
  )
}

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

function getRootSuiteStatus (rootTests) {
  let status = 'pass'
  if (rootTests.every(t => t.isPending())) {
    status = 'skip'
  } else {
    for (const test of rootTests) {
      if (test.state === 'failed' || test.timedOut || test._ddHookFailed) {
        status = 'fail'
      }
    }
  }
  return status
}

function haveRootTestsFinished (rootTests) {
  for (const test of rootTests) {
    if (!test.isPending() && !test.state && !test.timedOut && !test._ddHookFailed) {
      return false
    }
  }
  return true
}

function getSuitePath (suite) {
  return getTestSuitePath(suite.file, process.cwd())
}

function getSuitesToSkip (originalSuites) {
  return getSuitesToSkipFromPaths(originalSuites.map(getSuitePath))
}

function getSuitesToSkipFromPaths (localSuites) {
  const localSuitesSet = new Set(localSuites)
  const suitesToSkipForRun = []

  for (const suite of suitesToSkip) {
    if (localSuitesSet.has(suite)) {
      suitesToSkipForRun.push(suite)
    }
  }

  return suitesToSkipForRun
}

function getFilteredSuites (originalSuites) {
  const suitesToSkipForRun = getSuitesToSkip(originalSuites)

  return originalSuites.reduce((acc, suite) => {
    const testPath = getSuitePath(suite)
    const shouldSkip = suitesToSkipForRun.includes(testPath)
    const isUnskippable = unskippableSuites.includes(suite.file)
    if (shouldSkip && !isUnskippable) {
      acc.skippedSuites.add(testPath)
    } else {
      acc.suitesToRun.push(suite)
    }
    return acc
  }, { suitesToRun: [], skippedSuites: new Set(), suitesToSkipForRun })
}

function hasSkippableSuitesCoverage () {
  return skippableSuitesCoverage &&
    typeof skippableSuitesCoverage === 'object' &&
    Object.keys(skippableSuitesCoverage).length > 0
}

function isTiaCoverageBackfillEnabled () {
  return config.isItrEnabled && config.isCoverageReportUploadEnabled
}

function getCoverageRootDir () {
  return config.repositoryRoot || process.cwd()
}

function shouldReportCodeCoverageLinesPct (hasBackfilledCoverage) {
  return !isSuitesSkipped || hasBackfilledCoverage
}

function getSkippedSuitesCoverageForRun () {
  return isSuitesSkipped && isTiaCoverageBackfillEnabled() && hasSkippableSuitesCoverage()
    ? skippableSuitesCoverage
    : {}
}

function applySkippedCoverageToMochaCoverageMap () {
  if (!isTiaCoverageBackfillEnabled()) return false
  return applySkippedCoverageToCoverage(originalCoverageMap, skippedSuitesCoverage, getCoverageRootDir())
}

function getMochaTestSessionCoverageFiles () {
  return getRelativeCoverageFiles(getExecutableFilesFromCoverage(originalCoverageMap), getCoverageRootDir())
}

function resetSuiteSkippingRunState () {
  isSuitesSkipped = false
  skippedSuites = []
  skippableSuitesCoverage = {}
  skippedSuitesCoverage = {}
  untestedCoverage = undefined
  config.repositoryRoot = undefined
  writeCoverageBackfillToCache({})
}

function getOnStartHandler (frameworkVersion) {
  return function () {
    const processArgv = process.argv.slice(2).join(' ')
    const command = `mocha ${processArgv}`
    testSessionStartCh.publish({ command, frameworkVersion })
    if (skippedSuites.length) {
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

    // We subtract the errors from quarantined tests from the total number of failures.
    // Attempt-to-fix tests ignore quarantine/disabled suppression and keep their framework result.
    if (config.isTestManagementTestsEnabled) {
      let numFailedQuarantinedTests = 0
      for (const test of testsQuarantined) {
        if (isTestFailed(test)) {
          numFailedQuarantinedTests++
        }
      }
      this.stats.failures -= numFailedQuarantinedTests
      this.failures -= numFailedQuarantinedTests
    }

    // Recompute status after EFD and quarantine adjustments have reduced failure counts
    if (status === 'fail') {
      if (this.stats) {
        status = this.stats.failures === 0 ? 'pass' : 'fail'
      } else {
        status = this.failures === 0 ? 'pass' : 'fail'
      }
    }

    if (status === 'fail') {
      error = new Error(`Failed tests: ${this.failures}.`)
    }

    testFileToSuiteCtx.clear()

    let testCodeCoverageLinesTotal
    let testSessionCoverageFiles
    if (global.__coverage__ || untestedCoverage) {
      try {
        let hasBackfilledCoverage = false
        if (untestedCoverage) {
          originalCoverageMap.merge(fromCoverageMapToCoverage(untestedCoverage))
        }
        hasBackfilledCoverage = applySkippedCoverageToMochaCoverageMap()
        if (shouldReportCodeCoverageLinesPct(hasBackfilledCoverage)) {
          testCodeCoverageLinesTotal = getTestCoverageLinesPercentage(
            originalCoverageMap,
            undefined,
            getCoverageRootDir()
          )
        }
        if (isTiaCoverageBackfillEnabled()) {
          testSessionCoverageFiles = getMochaTestSessionCoverageFiles()
        }
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
      testSessionCoverageFiles,
      numSkippedSuites: skippedSuites.length,
      hasForcedToRunSuites: isForcedToRun,
      hasUnskippableSuites: !!unskippableSuites.length,
      error,
      isEarlyFlakeDetectionEnabled: config.isEarlyFlakeDetectionEnabled,
      isEarlyFlakeDetectionFaulty: config.isEarlyFlakeDetectionFaulty,
      isTestManagementEnabled: config.isTestManagementTestsEnabled,
      isParallel,
    })

    logTestOptimizationSummary({ attemptToFixExecutions, newTestsWithDynamicNames })
    loggedAttemptToFixTests.clear()
  }
}

function getRunStoresPromise (channelToPublishTo, ctx) {
  return new Promise(resolve => {
    channelToPublishTo.runStores({ ...ctx, onDone: resolve }, () => {})
  })
}

function applyKnownTestsResponse ({ err, knownTests }) {
  if (err) {
    config.knownTests = []
    config.isEarlyFlakeDetectionEnabled = false
    config.isKnownTestsEnabled = false
  } else {
    config.knownTests = knownTests
  }
}

function applyTestManagementTestsResponse ({ err, testManagementTests: receivedTestManagementTests }) {
  if (err) {
    config.testManagementTests = {}
    config.isTestManagementTestsEnabled = false
    config.testManagementAttemptToFixRetries = 0
  } else {
    config.testManagementTests = receivedTestManagementTests
  }
}

function getExecutionConfiguration (runner, isParallel, frameworkVersion, onFinishRequest, localSuites) {
  const ctx = {
    isParallel,
    frameworkVersion,
  }
  let skippableSuitesResponse
  resetSuiteSkippingRunState()

  const onReceivedSkippableSuites = ({
    err,
    skippableSuites,
    itrCorrelationId: responseItrCorrelationId,
    skippableSuitesCoverage: responseSkippableSuitesCoverage,
  }) => {
    if (err) {
      suitesToSkip = []
      skippableSuitesCoverage = {}
    } else {
      suitesToSkip = skippableSuites
      itrCorrelationId = responseItrCorrelationId
      skippableSuitesCoverage = responseSkippableSuitesCoverage || {}
    }
    if (localSuites) {
      suitesToSkip = getSuitesToSkipFromPaths(localSuites)
      mochaGlobalRunCh.runStores(ctx, () => {
        onFinishRequest()
      })
      return
    }

    // We remove the suites that we skip through ITR
    const filteredSuites = getFilteredSuites(runner.suite.suites)
    const { suitesToRun, suitesToSkipForRun } = filteredSuites

    isSuitesSkipped = suitesToRun.length !== runner.suite.suites.length

    log.debug('%d out of %d suites are going to run.', suitesToRun.length, runner.suite.suites.length)

    runner.suite.suites = suitesToRun

    skippedSuites = [...filteredSuites.skippedSuites]
    suitesToSkip = suitesToSkipForRun
    skippedSuitesCoverage = getSkippedSuitesCoverageForRun()
    writeCoverageBackfillToCache(skippedSuitesCoverage, getCoverageRootDir())

    mochaGlobalRunCh.runStores(ctx, () => {
      onFinishRequest()
    })
  }

  const requestSkippableSuites = () => {
    if (skippableSuitesResponse) {
      onReceivedSkippableSuites(skippableSuitesResponse)
      return
    }

    ctx.onDone = onReceivedSkippableSuites
    skippableSuitesCh.runStores(ctx, () => {})
  }

  const onReceivedImpactedTests = ({ err, modifiedFiles: receivedModifiedFiles }) => {
    if (err) {
      config.modifiedFiles = []
      config.isImpactedTestsEnabled = false
    } else {
      config.modifiedFiles = receivedModifiedFiles
    }
    if (config.isSuitesSkippingEnabled) {
      requestSkippableSuites()
    } else {
      mochaGlobalRunCh.runStores(ctx, () => {
        onFinishRequest()
      })
    }
  }

  const continueAfterTestRequests = () => {
    if (config.isImpactedTestsEnabled) {
      ctx.onDone = onReceivedImpactedTests
      modifiedFilesCh.runStores(ctx, () => {})
    } else if (config.isSuitesSkippingEnabled) {
      requestSkippableSuites()
    } else {
      mochaGlobalRunCh.runStores(ctx, () => {
        onFinishRequest()
      })
    }
  }

  const onReceivedConfiguration = ({ err, libraryConfig, repositoryRoot }) => {
    if (err || !skippableSuitesCh.hasSubscribers || !knownTestsCh.hasSubscribers) {
      return mochaGlobalRunCh.runStores(ctx, () => {
        onFinishRequest()
      })
    }
    config.repositoryRoot = repositoryRoot
    config.isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
    config.earlyFlakeDetectionNumRetries = libraryConfig.earlyFlakeDetectionNumRetries
    config.earlyFlakeDetectionSlowTestRetries = libraryConfig.earlyFlakeDetectionSlowTestRetries ?? {}
    config.earlyFlakeDetectionFaultyThreshold = libraryConfig.earlyFlakeDetectionFaultyThreshold
    config.isKnownTestsEnabled = libraryConfig.isKnownTestsEnabled
    config.isTestManagementTestsEnabled = libraryConfig.isTestManagementEnabled
    config.testManagementAttemptToFixRetries = libraryConfig.testManagementAttemptToFixRetries
    config.isImpactedTestsEnabled = libraryConfig.isImpactedTestsEnabled
    config.isItrEnabled = libraryConfig.isItrEnabled
    config.isCodeCoverageEnabled = libraryConfig.isCodeCoverageEnabled
    config.isCoverageReportUploadEnabled = libraryConfig.isCoverageReportUploadEnabled
    config.isSuitesSkippingEnabled = config.isItrEnabled && libraryConfig.isSuitesSkippingEnabled
    config.isFlakyTestRetriesEnabled = libraryConfig.isFlakyTestRetriesEnabled
    config.flakyTestRetriesCount = libraryConfig.flakyTestRetriesCount

    getTestOptimizationRequestResults({
      isKnownTestsEnabled: config.isKnownTestsEnabled,
      isTestManagementTestsEnabled: config.isTestManagementTestsEnabled,
      isSuitesSkippingEnabled: config.isSuitesSkippingEnabled,
      getKnownTests: () => getRunStoresPromise(knownTestsCh, ctx),
      getTestManagementTests: () => getRunStoresPromise(testManagementTestsCh, ctx),
      getSkippableSuites: () => getRunStoresPromise(skippableSuitesCh, ctx),
    }).then(requestResults => {
      const {
        knownTestsResponse,
        testManagementTestsResponse,
        skippableSuitesResponse: requestSkippableSuitesResponse,
      } = requestResults

      if (knownTestsResponse) {
        applyKnownTestsResponse(knownTestsResponse)
      }
      if (testManagementTestsResponse) {
        applyTestManagementTestsResponse(testManagementTestsResponse)
      }
      skippableSuitesResponse = requestSkippableSuitesResponse

      continueAfterTestRequests()
    })
  }

  ctx.onDone = onReceivedConfiguration

  libraryConfigurationCh.runStores(ctx, () => {})
}

// In this hook we delay the execution with options.delay to grab library configuration,
// skippable and known tests.
// It is called but skipped in parallel mode.
addHook({
  name: 'mocha',
  versions: [MINIMUM_MOCHA_VERSION],
  file: 'lib/mocha.js',
}, (Mocha, frameworkVersion) => {
  warnDeprecatedMochaVersion(frameworkVersion)

  shimmer.wrap(Mocha.prototype, 'run', run => function (...args) {
    // Workers do not need to request any data, just run the tests
    if (!testFinishCh.hasSubscribers || getEnvironmentVariable('MOCHA_WORKER_ID') || this.options.parallel) {
      return run.apply(this, args)
    }

    // `options.delay` does not work in parallel mode, so we can't delay the execution this way
    // This needs to be both here and in `runMocha` hook. Read the comment in `runMocha` hook for more info.
    this.options.delay = true

    const runner = run.apply(this, args)

    // eslint-disable-next-line unicorn/no-array-for-each
    this.files.forEach((path) => {
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
          },
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
  versions: [MINIMUM_MOCHA_VERSION],
  file: 'lib/cli/run-helpers.js',
}, (run) => {
  // `runMocha` is an async function
  shimmer.wrap(run, 'runMocha', runMocha => function (...args) {
    if (!testFinishCh.hasSubscribers) {
      return runMocha.apply(this, args)
    }
    const mocha = args[0]

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

    return runMocha.apply(this, args)
  })
  return run
})

// Only used in serial mode (no --parallel flag is passed)
// This hook is used to generate session, module, suite and test events
addHook({
  name: 'mocha',
  versions: [MINIMUM_MOCHA_VERSION],
  file: 'lib/runner.js',
}, function (Runner, frameworkVersion) {
  if (patched.has(Runner)) return Runner

  patched.add(Runner)

  shimmer.wrap(Runner.prototype, 'runTests', runTests => getRunTestsWrapper(runTests, config))

  shimmer.wrap(Runner.prototype, 'run', run => function (...args) {
    if (!testFinishCh.hasSubscribers) {
      return run.apply(this, args)
    }

    const { suitesByTestFile, numSuitesByTestFile } = getSuitesByTestFile(this.suite)
    // Root-level tests (direct children of root, no describe wrapper) keyed by file.
    // Populated during the root 'suite' event so the normal finish path can include them
    // in mixed-file status calculation.
    const rootTestsByFile = new Map()
    // Counts how many original tests per pure-root file still need their final attempt.
    // Hits zero when the last test's lifecycle completes, triggering the suite finish.
    const rootPendingCountByFile = new Map()
    const rootFinalizationPendingCountByFile = new Map()
    const rootFallbackPendingFiles = new Set()
    const rootFinalizationPendingTests = new WeakSet()
    let pendingRootFinalizations = 0
    let hasEnded = false
    let hasFinishedRun = false
    let endRunner

    function updateRootTestForFinalAttempt (test) {
      if (!test._retriedTest) return

      const rootTests = rootTestsByFile.get(test.file)
      if (!rootTests) return

      const retriedTestIndex = rootTests.indexOf(test._retriedTest)
      if (retriedTestIndex !== -1) {
        rootTests[retriedTestIndex] = test
      }
    }

    function finishRunIfReady () {
      if (hasFinishedRun) return
      if (hasEnded && pendingRootFinalizations === 0) {
        hasFinishedRun = true
        onEnd.call(endRunner)
      }
    }

    function incrementPendingRootFinalization (test) {
      if (!rootPendingCountByFile.has(test.file) || rootFinalizationPendingTests.has(test)) return

      rootFinalizationPendingTests.add(test)
      pendingRootFinalizations++
      rootFinalizationPendingCountByFile.set(
        test.file,
        (rootFinalizationPendingCountByFile.get(test.file) || 0) + 1
      )
    }

    function decrementPendingRootFinalization (test) {
      if (!rootFinalizationPendingTests.has(test)) return

      rootFinalizationPendingTests.delete(test)
      pendingRootFinalizations--

      const remaining = rootFinalizationPendingCountByFile.get(test.file) - 1
      if (remaining > 0) {
        rootFinalizationPendingCountByFile.set(test.file, remaining)
      } else {
        rootFinalizationPendingCountByFile.delete(test.file)
      }

      if (!rootFinalizationPendingCountByFile.has(test.file) && rootFallbackPendingFiles.delete(test.file)) {
        finishRootSuiteFallbackForFile(test.file)
      }

      finishRunIfReady()
    }

    function finishRootSuiteForFile (file) {
      const remaining = rootPendingCountByFile.get(file) - 1
      if (remaining > 0) {
        rootPendingCountByFile.set(file, remaining)
        return
      }
      rootPendingCountByFile.delete(file)

      const ctx = testFileToSuiteCtx.get(file)
      if (!ctx) {
        log.warn('No ctx found for suite', file)
        return
      }

      const rootTests = rootTestsByFile.get(file) || []
      const status = getRootSuiteStatus(rootTests)

      if (global.__coverage__) {
        const coverageFiles = getCoveredFilesFromCoverage(global.__coverage__)
        testSuiteCodeCoverageCh.publish({ coverageFiles, suiteFile: file })
        mergeCoverage(global.__coverage__, originalCoverageMap)
        resetCoverage(global.__coverage__)
      }

      testSuiteFinishCh.publish({ status, ...ctx.currentStore }, () => {})
    }

    function finishRootSuiteFallbackForFile (file) {
      const ctx = testFileToSuiteCtx.get(file)
      if (!ctx || !rootPendingCountByFile.has(file)) return

      const rootTests = rootTestsByFile.get(file) || []
      const status = haveRootTestsFinished(rootTests) ? getRootSuiteStatus(rootTests) : 'fail'
      rootPendingCountByFile.delete(file)
      testSuiteFinishCh.publish({ status, ...ctx.currentStore }, () => {})
    }

    function finishRootSuiteAfterFinalAttempt (test) {
      if (!test._ddIsFinalAttempt || !rootPendingCountByFile.has(test.file)) return

      updateRootTestForFinalAttempt(test)
      finishRootSuiteForFile(test.file)
    }

    const onEnd = getOnEndHandler(false)

    this.once('start', getOnStartHandler(frameworkVersion))

    this.once('end', function () {
      hasEnded = true
      endRunner = this
      finishRunIfReady()
    })

    // The job of this listener is to
    // initialize the suite span tag in correct order
    // (that is suiteA -> testA ... -> suiteB -> testB
    // instead of suiteA -> suiteB -> testA -> ... -> testB)
    // when the suite has tests that are in the top level
    // (no describe(...))
    this.on('test', function (test) {
      const ctx = testFileToSuiteCtx.get(test.file)
      if (ctx?._pendingRootStart) {
        ctx._pendingRootStart = false
        testSuiteStartCh.runStores(ctx, () => {})
      }
    })

    this.on('test', getOnTestHandler(true))

    this.on('test end', getOnTestEndHandler(config, {
      onStart: incrementPendingRootFinalization,
      onFinish: function (test) {
        finishRootSuiteAfterFinalAttempt(test)
        decrementPendingRootFinalization(test)
      },
    }))

    this.on('retry', getOnTestRetryHandler(config))

    // If the hook passes, 'hook end' will be emitted. Otherwise, 'fail' will be emitted
    this.on('hook end', getOnHookEndHandler(config))

    this.on('hook end', function (hook) {
      const test = hook.ctx?.currentTest
      if (!test) return
      finishRootSuiteAfterFinalAttempt(test)
    })

    this.on('fail', getOnFailHandler(true, config))

    this.on('fail', function (testOrHook) {
      if (testOrHook.type !== 'hook') return
      const test = testOrHook.ctx?.currentTest
      if (!test) return
      finishRootSuiteAfterFinalAttempt(test)
    })

    this.on('pending', getOnPendingHandler())

    this.on('suite', function (suite) {
      if (suite.root || !suite.tests.length) {
        // This branch can be triggered when we have top level it(...) inside test files.
        // In that case, they all (even if they are from different files) are going to be
        // children of the root suite.
        // Note: We could have suites that contain top level it(...) and also it(...) nested
        // inside describe(...) ("mixed case"). Duplication is avoided by the context guard
        // below. Since 'suite' fires for root first, in the mixed case the ctx is created
        // here and the describe-based handler finds it already set.
        if (suite.root && suite.tests.length > 0) {
          const files = new Set(suite.tests.map(test => test.file).filter(Boolean))
          for (const file of files) {
            const testsForFile = suite.tests.filter(t => t.file === file)
            rootTestsByFile.set(file, testsForFile)
            // Only track the countdown for pure root-level files.
            // Mixed files are finished by the normal 'suite end' path.
            if (!suitesByTestFile[file]) {
              rootPendingCountByFile.set(file, testsForFile.length)
            }
            if (testFileToSuiteCtx.get(file)) continue
            const isUnskippable = unskippableSuites.includes(file)
            isForcedToRun = isUnskippable && suitesToSkip.includes(getTestSuitePath(file, process.cwd()))
            const ctx = {
              testSuiteAbsolutePath: file,
              isUnskippable,
              isForcedToRun,
              itrCorrelationId,
              _pendingRootStart: true, // Now the suite start fires lazily on the first test event for this file
            }
            testFileToSuiteCtx.set(file, ctx)
          }
        }
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
          itrCorrelationId,
        }
        testFileToSuiteCtx.set(suite.file, ctx)
        testSuiteStartCh.runStores(ctx, () => {})
      }
    })

    this.on('suite end', function (suite) {
      if (suite.root) {
        // Normal case: pure root-level files are finished by the 'test end' / 'hook end'
        // listeners via finishRootSuiteForFile. Two edge cases remain here:
        //
        // 1. All-pending: no 'test' event fired, _pendingRootStart is still true.
        //    Start and immediately finish with 'skip'.
        //
        // 2. Aborted mid-run (e.g. a beforeEach hook failure): Mocha skips remaining
        //    tests and jumps straight to 'suite end'. rootPendingCountByFile still has
        //    a nonzero count for the file because the last tests never ran. Finish it
        //    as failed now.
        //
        // 3. Async finalization lagged behind Mocha's synchronous events (e.g. DI retry
        //    wait): all tests have Mocha terminal state, but the final-attempt callback
        //    did not run before root 'suite end'. Finish from the observed test states.
        const processedFiles = new Set()
        for (const test of suite.tests) {
          if (!test.file || processedFiles.has(test.file)) continue
          processedFiles.add(test.file)
          if (suitesByTestFile[test.file]) continue // mixed: handled by normal path
          const ctx = testFileToSuiteCtx.get(test.file)
          if (!ctx) continue
          if (ctx._pendingRootStart) {
            ctx._pendingRootStart = false
            testSuiteStartCh.runStores(ctx, () => {})
            testSuiteFinishCh.publish({ status: 'skip', ...ctx.currentStore }, () => {})
          } else if (rootPendingCountByFile.has(test.file)) {
            if (rootFinalizationPendingCountByFile.has(test.file)) {
              rootFallbackPendingFiles.add(test.file)
              continue
            }

            finishRootSuiteFallbackForFile(test.file)
          }
        }
        return
      }
      const suitesInTestFile = suitesByTestFile[suite.file]

      const isLastSuite = --numSuitesByTestFile[suite.file] === 0
      if (!isLastSuite) {
        return
      }

      const rootTests = rootTestsByFile.get(suite.file) || []
      let status = 'pass'
      if (suitesInTestFile.every(suite => suite.pending) && rootTests.every(test => test.isPending())) {
        status = 'skip'
      } else {
        // has to check every test in the test file
        // eslint-disable-next-line unicorn/no-array-for-each
        suitesInTestFile.forEach(suite => {
          suite.eachTest(test => {
            if (test.state === 'failed' || test.timedOut) {
              status = 'fail'
            }
          })
        })
        for (const test of rootTests) {
          if (test.state === 'failed' || test.timedOut) {
            status = 'fail'
          }
        }
      }

      if (global.__coverage__) {
        const coverageFiles = getCoveredFilesFromCoverage(global.__coverage__)

        testSuiteCodeCoverageCh.publish({
          coverageFiles,
          suiteFile: suite.file,
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

    return run.apply(this, args)
  })

  return Runner
})

// Used both in serial and parallel mode, and by both the main process and the workers
// Used to set the correct async resource to the test.
addHook({
  name: 'mocha',
  versions: [MINIMUM_MOCHA_VERSION],
  file: 'lib/runnable.js',
}, (runnablePackage) => runnableWrapper(runnablePackage, config))

function onMessage (message) {
  if (Array.isArray(message)) {
    const [messageCode, payload] = message
    if (messageCode === MOCHA_WORKER_TRACE_PAYLOAD_CODE) {
      collectTestOptimizationSummariesFromTraces(payload, {
        newTestsWithDynamicNames,
        attemptToFixExecutions,
      })
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
  file: 'src/WorkerHandler.js',
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
  file: 'lib/nodejs/parallel-buffered-runner.js',
}, (ParallelBufferedRunner, frameworkVersion) => {
  shimmer.wrap(ParallelBufferedRunner.prototype, 'run', run => function (cb, { files }) {
    if (!testFinishCh.hasSubscribers) {
      return run.apply(this, arguments)
    }

    this.once('start', getOnStartHandler(frameworkVersion))
    this.once('end', getOnEndHandler(true))

    // Populate unskippable suites before config is fetched (matches serial mode at Mocha.prototype.run)
    for (const filePath of files) {
      if (isMarkedAsUnskippable({ path: filePath })) {
        unskippableSuites.push(filePath)
      }
    }

    const localSuites = files.map(file => getTestSuitePath(file, process.cwd()))
    getExecutionConfiguration(this, true, frameworkVersion, () => {
      if (config.isKnownTestsEnabled) {
        const isFaulty = getIsFaultyEarlyFlakeDetection(
          localSuites,
          config.knownTests?.mocha || {},
          config.earlyFlakeDetectionFaultyThreshold
        )
        if (isFaulty) {
          config.isKnownTestsEnabled = false
          config.isEarlyFlakeDetectionEnabled = false
          config.isEarlyFlakeDetectionFaulty = true
        }
      }
      if (config.isSuitesSkippingEnabled && suitesToSkip.length) {
        const filteredFiles = []
        const skippedFiles = []
        for (const file of files) {
          const testPath = getTestSuitePath(file, process.cwd())
          const shouldSkip = suitesToSkip.includes(testPath)
          const isUnskippable = unskippableSuites.includes(file)
          if (shouldSkip && !isUnskippable) {
            skippedFiles.push(testPath)
          } else {
            filteredFiles.push(file)
          }
        }
        isSuitesSkipped = skippedFiles.length > 0
        skippedSuites = skippedFiles
        skippedSuitesCoverage = getSkippedSuitesCoverageForRun()
        writeCoverageBackfillToCache(skippedSuitesCoverage, getCoverageRootDir())
        run.apply(this, [cb, { files: filteredFiles }])
      } else {
        run.apply(this, arguments)
      }
    }, localSuites)

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
  file: 'lib/nodejs/buffered-worker-pool.js',
}, (BufferedWorkerPoolPackage) => {
  const { BufferedWorkerPool } = BufferedWorkerPoolPackage

  shimmer.wrap(BufferedWorkerPool.prototype, 'run', run => async function (testSuiteAbsolutePath, workerArgs) {
    if (!testFinishCh.hasSubscribers ||
        (!config.isKnownTestsEnabled &&
         !config.isTestManagementTestsEnabled &&
         !config.isImpactedTestsEnabled &&
         !config.isFlakyTestRetriesEnabled)) {
      return run.apply(this, arguments)
    }

    const testPath = getTestSuitePath(testSuiteAbsolutePath, process.cwd())

    const newWorkerArgs = { ...workerArgs }

    if (config.isKnownTestsEnabled) {
      if (config.knownTests?.mocha) {
        const testSuiteKnownTests = config.knownTests.mocha[testPath] || []
        newWorkerArgs._ddEfdNumRetries = config.earlyFlakeDetectionNumRetries
        newWorkerArgs._ddEfdSlowTestRetries = config.earlyFlakeDetectionSlowTestRetries
        newWorkerArgs._ddIsEfdEnabled = config.isEarlyFlakeDetectionEnabled
        newWorkerArgs._ddIsKnownTestsEnabled = true
        newWorkerArgs._ddKnownTests = {
          mocha: {
            [testPath]: testSuiteKnownTests,
          },
        }
      } else {
        config.isEarlyFlakeDetectionEnabled = false
        config.isKnownTestsEnabled = false
        newWorkerArgs._ddIsKnownTestsEnabled = false
        newWorkerArgs._ddIsEfdEnabled = false
        newWorkerArgs._ddKnownTests = {}
      }
    }
    if (config.isTestManagementTestsEnabled) {
      const testSuiteTestManagementTests = config.testManagementTests?.mocha?.suites?.[testPath] || {}
      newWorkerArgs._ddIsTestManagementTestsEnabled = true
      newWorkerArgs._ddTestManagementAttemptToFixRetries = config.testManagementAttemptToFixRetries
      newWorkerArgs._ddTestManagementTests = {
        mocha: {
          suites: {
            [testPath]: testSuiteTestManagementTests,
          },
        },
      }
    }

    if (config.isImpactedTestsEnabled) {
      newWorkerArgs._ddIsImpactedTestsEnabled = true
      newWorkerArgs._ddModifiedFiles = config.modifiedFiles || {}
    }

    if (config.isFlakyTestRetriesEnabled) {
      newWorkerArgs._ddIsFlakyTestRetriesEnabled = true
      newWorkerArgs._ddFlakyTestRetriesCount = config.flakyTestRetriesCount
    }

    // We pass the known tests for the test file to the worker
    const testFileResult = await run.apply(
      this,
      [
        testSuiteAbsolutePath,
        newWorkerArgs,
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
      const testProperties = getTestProperties(test, config.testManagementTests)
      if (config.isTestManagementTestsEnabled && testProperties.isQuarantined && !testProperties.isAttemptToFix) {
        testsQuarantined.add(test)
      }
    }
    return testFileResult
  })

  return BufferedWorkerPoolPackage
})
