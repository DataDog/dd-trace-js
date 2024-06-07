'use strict'

const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')
const {
  getCoveredFilenamesFromCoverage,
  JEST_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_COVERAGE_PAYLOAD_CODE,
  getTestLineStart,
  getTestSuitePath,
  getTestParametersString,
  addEfdStringToTestName,
  removeEfdStringFromTestName,
  getIsFaultyEarlyFlakeDetection
} = require('../../dd-trace/src/plugins/util/test')
const {
  getFormattedJestTestParameters,
  getJestTestName,
  getJestSuitesToRun
} = require('../../datadog-plugin-jest/src/util')

const testSessionStartCh = channel('ci:jest:session:start')
const testSessionFinishCh = channel('ci:jest:session:finish')

const testSessionConfigurationCh = channel('ci:jest:session:configuration')

const testSuiteStartCh = channel('ci:jest:test-suite:start')
const testSuiteFinishCh = channel('ci:jest:test-suite:finish')

const workerReportTraceCh = channel('ci:jest:worker-report:trace')
const workerReportCoverageCh = channel('ci:jest:worker-report:coverage')

const testSuiteCodeCoverageCh = channel('ci:jest:test-suite:code-coverage')

const testStartCh = channel('ci:jest:test:start')
const testSkippedCh = channel('ci:jest:test:skip')
const testRunFinishCh = channel('ci:jest:test:finish')
const testErrCh = channel('ci:jest:test:err')

const skippableSuitesCh = channel('ci:jest:test-suite:skippable')
const libraryConfigurationCh = channel('ci:jest:library-configuration')
const knownTestsCh = channel('ci:jest:known-tests')

const itrSkippedSuitesCh = channel('ci:jest:itr:skipped-suites')

// Message sent by jest's main process to workers to run a test suite (=test file)
// https://github.com/jestjs/jest/blob/1d682f21c7a35da4d3ab3a1436a357b980ebd0fa/packages/jest-worker/src/types.ts#L37
const CHILD_MESSAGE_CALL = 1
// Maximum time we'll wait for the tracer to flush
const FLUSH_TIMEOUT = 10000

let skippableSuites = []
let knownTests = {}
let isCodeCoverageEnabled = false
let isSuitesSkippingEnabled = false
let isUserCodeCoverageEnabled = false
let isSuitesSkipped = false
let numSkippedSuites = 0
let hasUnskippableSuites = false
let hasForcedToRunSuites = false
let isEarlyFlakeDetectionEnabled = false
let earlyFlakeDetectionNumRetries = 0
let earlyFlakeDetectionFaultyThreshold = 30
let isEarlyFlakeDetectionFaulty = false
let hasFilteredSkippableSuites = false

const sessionAsyncResource = new AsyncResource('bound-anonymous-fn')

const asyncResources = new WeakMap()
const originalTestFns = new WeakMap()
const retriedTestsToNumAttempts = new Map()
const newTestsTestStatuses = new Map()

// based on https://github.com/facebook/jest/blob/main/packages/jest-circus/src/formatNodeAssertErrors.ts#L41
function formatJestError (errors) {
  let error
  if (Array.isArray(errors)) {
    const [originalError, asyncError] = errors
    if (originalError === null || !originalError.stack) {
      error = asyncError
      error.message = originalError
    } else {
      error = originalError
    }
  } else {
    error = errors
  }
  return error
}

function getTestEnvironmentOptions (config) {
  if (config.projectConfig && config.projectConfig.testEnvironmentOptions) { // newer versions
    return config.projectConfig.testEnvironmentOptions
  }
  if (config.testEnvironmentOptions) {
    return config.testEnvironmentOptions
  }
  return {}
}

function getEfdStats (testStatuses) {
  return testStatuses.reduce((acc, testStatus) => {
    acc[testStatus]++
    return acc
  }, { pass: 0, fail: 0 })
}

function getWrappedEnvironment (BaseEnvironment, jestVersion) {
  return class DatadogEnvironment extends BaseEnvironment {
    constructor (config, context) {
      super(config, context)
      const rootDir = config.globalConfig ? config.globalConfig.rootDir : config.rootDir
      this.rootDir = rootDir
      this.testSuite = getTestSuitePath(context.testPath, rootDir)
      this.nameToParams = {}
      this.global._ddtrace = global._ddtrace
      this.hasSnapshotTests = undefined

      this.displayName = config.projectConfig?.displayName?.name
      this.testEnvironmentOptions = getTestEnvironmentOptions(config)

      const repositoryRoot = this.testEnvironmentOptions._ddRepositoryRoot

      if (repositoryRoot) {
        this.testSourceFile = getTestSuitePath(context.testPath, repositoryRoot)
      }

      this.isEarlyFlakeDetectionEnabled = this.testEnvironmentOptions._ddIsEarlyFlakeDetectionEnabled

      if (this.isEarlyFlakeDetectionEnabled) {
        const hasKnownTests = !!knownTests.jest
        earlyFlakeDetectionNumRetries = this.testEnvironmentOptions._ddEarlyFlakeDetectionNumRetries
        try {
          this.knownTestsForThisSuite = hasKnownTests
            ? (knownTests.jest[this.testSuite] || [])
            : this.getKnownTestsForSuite(this.testEnvironmentOptions._ddKnownTests)
        } catch (e) {
          // If there has been an error parsing the tests, we'll disable Early Flake Deteciton
          this.isEarlyFlakeDetectionEnabled = false
        }
      }
    }

    getHasSnapshotTests () {
      if (this.hasSnapshotTests !== undefined) {
        return this.hasSnapshotTests
      }
      let hasSnapshotTests = true
      try {
        const { _snapshotData } = this.getVmContext().expect.getState().snapshotState
        hasSnapshotTests = Object.keys(_snapshotData).length > 0
      } catch (e) {
        // if we can't be sure, we'll err on the side of caution and assume it has snapshots
      }
      this.hasSnapshotTests = hasSnapshotTests
      return hasSnapshotTests
    }

    // Function that receives a list of known tests for a test service and
    // returns the ones that belong to the current suite
    getKnownTestsForSuite (knownTests) {
      if (this.knownTestsForThisSuite) {
        return this.knownTestsForThisSuite
      }
      let knownTestsForSuite = knownTests
      // If jest is using workers, known tests are serialized to json.
      // If jest runs in band, they are not.
      if (typeof knownTestsForSuite === 'string') {
        knownTestsForSuite = JSON.parse(knownTestsForSuite)
      }
      return knownTestsForSuite
    }

    // Add the `add_test` event we don't have the test object yet, so
    // we use its describe block to get the full name
    getTestNameFromAddTestEvent (event, state) {
      const describeSuffix = getJestTestName(state.currentDescribeBlock)
      const fullTestName = describeSuffix ? `${describeSuffix} ${event.testName}` : event.testName
      return removeEfdStringFromTestName(fullTestName)
    }

    async handleTestEvent (event, state) {
      if (super.handleTestEvent) {
        await super.handleTestEvent(event, state)
      }

      const setNameToParams = (name, params) => { this.nameToParams[name] = [...params] }

      if (event.name === 'setup') {
        if (this.global.test) {
          shimmer.wrap(this.global.test, 'each', each => function () {
            const testParameters = getFormattedJestTestParameters(arguments)
            const eachBind = each.apply(this, arguments)
            return function () {
              const [testName] = arguments
              setNameToParams(testName, testParameters)
              return eachBind.apply(this, arguments)
            }
          })
        }
      }
      if (event.name === 'test_start') {
        let isNewTest = false
        let numEfdRetry = null
        const testParameters = getTestParametersString(this.nameToParams, event.test.name)
        // Async resource for this test is created here
        // It is used later on by the test_done handler
        const asyncResource = new AsyncResource('bound-anonymous-fn')
        asyncResources.set(event.test, asyncResource)
        const testName = getJestTestName(event.test)

        if (this.isEarlyFlakeDetectionEnabled) {
          const originalTestName = removeEfdStringFromTestName(testName)
          isNewTest = retriedTestsToNumAttempts.has(originalTestName)
          if (isNewTest) {
            numEfdRetry = retriedTestsToNumAttempts.get(originalTestName)
            retriedTestsToNumAttempts.set(originalTestName, numEfdRetry + 1)
          }
        }
        asyncResource.runInAsyncScope(() => {
          testStartCh.publish({
            name: removeEfdStringFromTestName(testName),
            suite: this.testSuite,
            testSourceFile: this.testSourceFile,
            runner: 'jest-circus',
            displayName: this.displayName,
            testParameters,
            frameworkVersion: jestVersion,
            isNew: isNewTest,
            isEfdRetry: numEfdRetry > 0
          })
          originalTestFns.set(event.test, event.test.fn)
          event.test.fn = asyncResource.bind(event.test.fn)
        })
      }
      if (event.name === 'add_test') {
        if (this.isEarlyFlakeDetectionEnabled) {
          const testName = this.getTestNameFromAddTestEvent(event, state)
          const isNew = !this.knownTestsForThisSuite?.includes(testName)
          const isSkipped = event.mode === 'todo' || event.mode === 'skip'
          if (isNew && !isSkipped && !retriedTestsToNumAttempts.has(testName)) {
            retriedTestsToNumAttempts.set(testName, 0)
            // Retrying snapshots has proven to be problematic, so we'll skip them for now
            // We'll still detect new tests, but we won't retry them.
            // TODO: do not bail out of EFD with the whole test suite
            if (this.getHasSnapshotTests()) {
              log.warn('Early flake detection is disabled for suites with snapshots')
              return
            }
            for (let retryIndex = 0; retryIndex < earlyFlakeDetectionNumRetries; retryIndex++) {
              if (this.global.test) {
                this.global.test(addEfdStringToTestName(event.testName, retryIndex), event.fn, event.timeout)
              } else {
                log.error('Early flake detection could not retry test because global.test is undefined')
              }
            }
          }
        }
      }
      if (event.name === 'test_done') {
        const asyncResource = asyncResources.get(event.test)
        asyncResource.runInAsyncScope(() => {
          let status = 'pass'
          if (event.test.errors && event.test.errors.length) {
            status = 'fail'
            const formattedError = formatJestError(event.test.errors[0])
            testErrCh.publish(formattedError)
          }
          testRunFinishCh.publish({
            status,
            testStartLine: getTestLineStart(event.test.asyncError, this.testSuite)
          })
          // restore in case it is retried
          event.test.fn = originalTestFns.get(event.test)
          // We'll store the test statuses of the retries
          if (this.isEarlyFlakeDetectionEnabled) {
            const testName = getJestTestName(event.test)
            const originalTestName = removeEfdStringFromTestName(testName)
            const isNewTest = retriedTestsToNumAttempts.has(originalTestName)
            if (isNewTest) {
              if (newTestsTestStatuses.has(originalTestName)) {
                newTestsTestStatuses.get(originalTestName).push(status)
              } else {
                newTestsTestStatuses.set(originalTestName, [status])
              }
            }
          }
        })
      }
      if (event.name === 'test_skip' || event.name === 'test_todo') {
        const asyncResource = new AsyncResource('bound-anonymous-fn')
        asyncResource.runInAsyncScope(() => {
          testSkippedCh.publish({
            name: getJestTestName(event.test),
            suite: this.testSuite,
            testSourceFile: this.testSourceFile,
            runner: 'jest-circus',
            displayName: this.displayName,
            frameworkVersion: jestVersion,
            testStartLine: getTestLineStart(event.test.asyncError, this.testSuite)
          })
        })
      }
    }
  }
}

function getTestEnvironment (pkg, jestVersion) {
  if (pkg.default) {
    const wrappedTestEnvironment = getWrappedEnvironment(pkg.default, jestVersion)
    pkg.default = wrappedTestEnvironment
    pkg.TestEnvironment = wrappedTestEnvironment
    return pkg
  }
  return getWrappedEnvironment(pkg, jestVersion)
}

function applySuiteSkipping (originalTests, rootDir, frameworkVersion) {
  const jestSuitesToRun = getJestSuitesToRun(skippableSuites, originalTests, rootDir || process.cwd())
  hasFilteredSkippableSuites = true
  log.debug(
    () => `${jestSuitesToRun.suitesToRun.length} out of ${originalTests.length} suites are going to run.`
  )
  hasUnskippableSuites = jestSuitesToRun.hasUnskippableSuites
  hasForcedToRunSuites = jestSuitesToRun.hasForcedToRunSuites

  isSuitesSkipped = jestSuitesToRun.suitesToRun.length !== originalTests.length
  numSkippedSuites = jestSuitesToRun.skippedSuites.length

  itrSkippedSuitesCh.publish({ skippedSuites: jestSuitesToRun.skippedSuites, frameworkVersion })

  return jestSuitesToRun.suitesToRun
}

addHook({
  name: 'jest-environment-node',
  versions: ['>=24.8.0']
}, getTestEnvironment)

addHook({
  name: 'jest-environment-jsdom',
  versions: ['>=24.8.0']
}, getTestEnvironment)

function getWrappedScheduleTests (scheduleTests, frameworkVersion) {
  return async function (tests) {
    if (!isSuitesSkippingEnabled || hasFilteredSkippableSuites) {
      return scheduleTests.apply(this, arguments)
    }
    const [test] = tests
    const rootDir = test?.context?.config?.rootDir

    arguments[0] = applySuiteSkipping(tests, rootDir, frameworkVersion)

    return scheduleTests.apply(this, arguments)
  }
}

addHook({
  name: '@jest/core',
  file: 'build/TestScheduler.js',
  versions: ['>=27.0.0']
}, (testSchedulerPackage, frameworkVersion) => {
  const oldCreateTestScheduler = testSchedulerPackage.createTestScheduler
  const newCreateTestScheduler = async function () {
    if (!isSuitesSkippingEnabled || hasFilteredSkippableSuites) {
      return oldCreateTestScheduler.apply(this, arguments)
    }
    // If suite skipping is enabled and has not filtered skippable suites yet, we'll attempt to do it
    const scheduler = await oldCreateTestScheduler.apply(this, arguments)
    shimmer.wrap(scheduler, 'scheduleTests', scheduleTests => getWrappedScheduleTests(scheduleTests, frameworkVersion))
    return scheduler
  }
  testSchedulerPackage.createTestScheduler = newCreateTestScheduler
  return testSchedulerPackage
})

addHook({
  name: '@jest/core',
  file: 'build/TestScheduler.js',
  versions: ['>=24.8.0 <27.0.0']
}, (testSchedulerPackage, frameworkVersion) => {
  shimmer.wrap(
    testSchedulerPackage.default.prototype,
    'scheduleTests', scheduleTests => getWrappedScheduleTests(scheduleTests, frameworkVersion)
  )
  return testSchedulerPackage
})

addHook({
  name: '@jest/test-sequencer',
  versions: ['>=24.8.0']
}, (sequencerPackage, frameworkVersion) => {
  shimmer.wrap(sequencerPackage.default.prototype, 'shard', shard => function () {
    const shardedTests = shard.apply(this, arguments)

    if (!shardedTests.length || !isSuitesSkippingEnabled || !skippableSuites.length) {
      return shardedTests
    }
    const [test] = shardedTests
    const rootDir = test?.context?.config?.rootDir

    return applySuiteSkipping(shardedTests, rootDir, frameworkVersion)
  })
  return sequencerPackage
})

function cliWrapper (cli, jestVersion) {
  const wrapped = shimmer.wrap(cli, 'runCLI', runCLI => async function () {
    let onDone
    const configurationPromise = new Promise((resolve) => {
      onDone = resolve
    })
    if (!libraryConfigurationCh.hasSubscribers) {
      return runCLI.apply(this, arguments)
    }

    sessionAsyncResource.runInAsyncScope(() => {
      libraryConfigurationCh.publish({ onDone })
    })

    try {
      const { err, libraryConfig } = await configurationPromise
      if (!err) {
        isCodeCoverageEnabled = libraryConfig.isCodeCoverageEnabled
        isSuitesSkippingEnabled = libraryConfig.isSuitesSkippingEnabled
        isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
        earlyFlakeDetectionNumRetries = libraryConfig.earlyFlakeDetectionNumRetries
        earlyFlakeDetectionFaultyThreshold = libraryConfig.earlyFlakeDetectionFaultyThreshold
      }
    } catch (err) {
      log.error(err)
    }

    if (isEarlyFlakeDetectionEnabled) {
      const knownTestsPromise = new Promise((resolve) => {
        onDone = resolve
      })

      sessionAsyncResource.runInAsyncScope(() => {
        knownTestsCh.publish({ onDone })
      })

      try {
        const { err, knownTests: receivedKnownTests } = await knownTestsPromise
        if (!err) {
          knownTests = receivedKnownTests
        } else {
          // We disable EFD if there has been an error in the known tests request
          isEarlyFlakeDetectionEnabled = false
        }
      } catch (err) {
        log.error(err)
      }
    }

    if (isSuitesSkippingEnabled) {
      const skippableSuitesPromise = new Promise((resolve) => {
        onDone = resolve
      })

      sessionAsyncResource.runInAsyncScope(() => {
        skippableSuitesCh.publish({ onDone })
      })

      try {
        const { err, skippableSuites: receivedSkippableSuites } = await skippableSuitesPromise
        if (!err) {
          skippableSuites = receivedSkippableSuites
        }
      } catch (err) {
        log.error(err)
      }
    }

    const processArgv = process.argv.slice(2).join(' ')
    sessionAsyncResource.runInAsyncScope(() => {
      testSessionStartCh.publish({ command: `jest ${processArgv}`, frameworkVersion: jestVersion })
    })

    const result = await runCLI.apply(this, arguments)

    const {
      results: {
        success,
        coverageMap,
        numFailedTestSuites,
        numFailedTests,
        numTotalTests,
        numTotalTestSuites
      }
    } = result

    let testCodeCoverageLinesTotal

    if (isUserCodeCoverageEnabled) {
      try {
        const { pct, total } = coverageMap.getCoverageSummary().lines
        testCodeCoverageLinesTotal = total !== 0 ? pct : 0
      } catch (e) {
        // ignore errors
      }
    }
    let status, error

    if (success) {
      if (numTotalTests === 0 && numTotalTestSuites === 0) {
        status = 'skip'
      } else {
        status = 'pass'
      }
    } else {
      status = 'fail'
      error = new Error(`Failed test suites: ${numFailedTestSuites}. Failed tests: ${numFailedTests}`)
    }
    let timeoutId

    // Pass the resolve callback to defer it to DC listener
    const flushPromise = new Promise((resolve) => {
      onDone = () => {
        clearTimeout(timeoutId)
        resolve()
      }
    })

    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        resolve('timeout')
      }, FLUSH_TIMEOUT).unref()
    })

    sessionAsyncResource.runInAsyncScope(() => {
      testSessionFinishCh.publish({
        status,
        isSuitesSkipped,
        isSuitesSkippingEnabled,
        isCodeCoverageEnabled,
        testCodeCoverageLinesTotal,
        numSkippedSuites,
        hasUnskippableSuites,
        hasForcedToRunSuites,
        error,
        isEarlyFlakeDetectionEnabled,
        isEarlyFlakeDetectionFaulty,
        onDone
      })
    })
    const waitingResult = await Promise.race([flushPromise, timeoutPromise])

    if (waitingResult === 'timeout') {
      log.error('Timeout waiting for the tracer to flush')
    }

    numSkippedSuites = 0

    /**
     * If Early Flake Detection (EFD) is enabled the logic is as follows:
     * - If all attempts for a test are failing, the test has failed and we will let the test process fail.
     * - If just a single attempt passes, we will prevent the test process from failing.
     * The rationale behind is the following: you may still be able to block your CI pipeline by gating
     * on flakiness (the test will be considered flaky), but you may choose to unblock the pipeline too.
     */

    if (isEarlyFlakeDetectionEnabled) {
      let numFailedTestsToIgnore = 0
      for (const testStatuses of newTestsTestStatuses.values()) {
        const { pass, fail } = getEfdStats(testStatuses)
        if (pass > 0) { // as long as one passes, we'll consider the test passed
          numFailedTestsToIgnore += fail
        }
      }
      // If every test that failed was an EFD retry, we'll consider the suite passed
      if (numFailedTestsToIgnore !== 0 && result.results.numFailedTests === numFailedTestsToIgnore) {
        result.results.success = true
      }
    }

    return result
  })

  cli.runCLI = wrapped.runCLI

  return cli
}

function coverageReporterWrapper (coverageReporter) {
  const CoverageReporter = coverageReporter.default ? coverageReporter.default : coverageReporter

  /**
   * If ITR is active, we're running fewer tests, so of course the total code coverage is reduced.
   * This calculation adds no value, so we'll skip it, as long as the user has not manually opted in to code coverage,
   * in which case we'll leave it.
   */
  shimmer.wrap(CoverageReporter.prototype, '_addUntestedFiles', addUntestedFiles => async function () {
    // If the user has added coverage manually, they're willing to pay the price of this execution, so
    // we will not skip it.
    if (isSuitesSkippingEnabled && !isUserCodeCoverageEnabled) {
      return Promise.resolve()
    }
    return addUntestedFiles.apply(this, arguments)
  })

  return coverageReporter
}

addHook({
  name: '@jest/reporters',
  file: 'build/coverage_reporter.js',
  versions: ['>=24.8.0 <26.6.2']
}, coverageReporterWrapper)

addHook({
  name: '@jest/reporters',
  file: 'build/CoverageReporter.js',
  versions: ['>=26.6.2']
}, coverageReporterWrapper)

addHook({
  name: '@jest/core',
  file: 'build/cli/index.js',
  versions: ['>=24.8.0']
}, cliWrapper)

function jestAdapterWrapper (jestAdapter, jestVersion) {
  const adapter = jestAdapter.default ? jestAdapter.default : jestAdapter
  const newAdapter = shimmer.wrap(adapter, function () {
    const environment = arguments[2]
    if (!environment) {
      return adapter.apply(this, arguments)
    }
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      testSuiteStartCh.publish({
        testSuite: environment.testSuite,
        testEnvironmentOptions: environment.testEnvironmentOptions,
        displayName: environment.displayName,
        frameworkVersion: jestVersion
      })
      return adapter.apply(this, arguments).then(suiteResults => {
        const { numFailingTests, skipped, failureMessage: errorMessage } = suiteResults
        let status = 'pass'
        if (skipped) {
          status = 'skipped'
        } else if (numFailingTests !== 0) {
          status = 'fail'
        }

        /**
         * Child processes do not each request ITR configuration, so the jest's parent process
         * needs to pass them the configuration. This is done via _ddTestCodeCoverageEnabled, which
         * controls whether coverage is reported.
        */
        if (environment.testEnvironmentOptions?._ddTestCodeCoverageEnabled) {
          const coverageFiles = getCoveredFilenamesFromCoverage(environment.global.__coverage__)
            .map(filename => getTestSuitePath(filename, environment.rootDir))
          asyncResource.runInAsyncScope(() => {
            testSuiteCodeCoverageCh.publish({ coverageFiles, testSuite: environment.testSuite })
          })
        }
        testSuiteFinishCh.publish({ status, errorMessage })
        return suiteResults
      }).catch(error => {
        testSuiteFinishCh.publish({ status: 'fail', error })
        throw error
      })
    })
  })
  if (jestAdapter.default) {
    jestAdapter.default = newAdapter
  } else {
    jestAdapter = newAdapter
  }

  return jestAdapter
}

addHook({
  name: 'jest-circus',
  file: 'build/legacy-code-todo-rewrite/jestAdapter.js',
  versions: ['>=24.8.0']
}, jestAdapterWrapper)

function configureTestEnvironment (readConfigsResult) {
  const { configs } = readConfigsResult
  sessionAsyncResource.runInAsyncScope(() => {
    testSessionConfigurationCh.publish(configs.map(config => config.testEnvironmentOptions))
  })
  // We can't directly use isCodeCoverageEnabled when reporting coverage in `jestAdapterWrapper`
  // because `jestAdapterWrapper` runs in a different process. We have to go through `testEnvironmentOptions`
  configs.forEach(config => {
    config.testEnvironmentOptions._ddTestCodeCoverageEnabled = isCodeCoverageEnabled
  })

  isUserCodeCoverageEnabled = !!readConfigsResult.globalConfig.collectCoverage

  if (readConfigsResult.globalConfig.forceExit) {
    log.warn("Jest's '--forceExit' flag has been passed. This may cause loss of data.")
  }

  if (isCodeCoverageEnabled) {
    const globalConfig = {
      ...readConfigsResult.globalConfig,
      collectCoverage: true
    }
    readConfigsResult.globalConfig = globalConfig
  }
  if (isSuitesSkippingEnabled) {
    // If suite skipping is enabled, the code coverage results are not going to be relevant,
    // so we do not show them.
    // Also, we might skip every test, so we need to pass `passWithNoTests`
    const globalConfig = {
      ...readConfigsResult.globalConfig,
      coverageReporters: ['none'],
      passWithNoTests: true
    }
    readConfigsResult.globalConfig = globalConfig
  }

  return readConfigsResult
}

function jestConfigAsyncWrapper (jestConfig) {
  shimmer.wrap(jestConfig, 'readConfigs', readConfigs => async function () {
    const readConfigsResult = await readConfigs.apply(this, arguments)
    configureTestEnvironment(readConfigsResult)
    return readConfigsResult
  })
  return jestConfig
}

function jestConfigSyncWrapper (jestConfig) {
  shimmer.wrap(jestConfig, 'readConfigs', readConfigs => function () {
    const readConfigsResult = readConfigs.apply(this, arguments)
    configureTestEnvironment(readConfigsResult)
    return readConfigsResult
  })
  return jestConfig
}

addHook({
  name: '@jest/transform',
  versions: ['>=24.8.0'],
  file: 'build/ScriptTransformer.js'
}, transformPackage => {
  const originalCreateScriptTransformer = transformPackage.createScriptTransformer

  transformPackage.createScriptTransformer = async function (config) {
    const { testEnvironmentOptions, ...restOfConfig } = config
    const {
      _ddTestModuleId,
      _ddTestSessionId,
      _ddTestCommand,
      _ddForcedToRun,
      _ddUnskippable,
      _ddItrCorrelationId,
      _ddKnownTests,
      _ddIsEarlyFlakeDetectionEnabled,
      _ddEarlyFlakeDetectionNumRetries,
      _ddRepositoryRoot,
      ...restOfTestEnvironmentOptions
    } = testEnvironmentOptions

    restOfConfig.testEnvironmentOptions = restOfTestEnvironmentOptions

    arguments[0] = restOfConfig

    return originalCreateScriptTransformer.apply(this, arguments)
  }

  return transformPackage
})

/**
 * Hook to remove the test paths (test suite) that are part of `skippableSuites`
 */
addHook({
  name: '@jest/core',
  versions: ['>=24.8.0'],
  file: 'build/SearchSource.js'
}, (searchSourcePackage, frameworkVersion) => {
  const SearchSource = searchSourcePackage.default ? searchSourcePackage.default : searchSourcePackage

  shimmer.wrap(SearchSource.prototype, 'getTestPaths', getTestPaths => async function () {
    const testPaths = await getTestPaths.apply(this, arguments)
    const [{ rootDir, shard }] = arguments

    if (isEarlyFlakeDetectionEnabled) {
      const projectSuites = testPaths.tests.map(test => getTestSuitePath(test.path, test.context.config.rootDir))
      const isFaulty =
        getIsFaultyEarlyFlakeDetection(projectSuites, knownTests.jest || {}, earlyFlakeDetectionFaultyThreshold)
      if (isFaulty) {
        log.error('Early flake detection is disabled because the number of new suites is too high.')
        isEarlyFlakeDetectionEnabled = false
        const testEnvironmentOptions = testPaths.tests[0]?.context?.config?.testEnvironmentOptions
        // Project config is shared among all tests, so we can modify it here
        if (testEnvironmentOptions) {
          testEnvironmentOptions._ddIsEarlyFlakeDetectionEnabled = false
        }
        isEarlyFlakeDetectionFaulty = true
      }
    }

    if (shard?.shardCount > 1 || !isSuitesSkippingEnabled || !skippableSuites.length) {
      // If the user is using jest sharding, we want to apply the filtering of tests in the shard process.
      // The reason for this is the following:
      // The tests for different shards are likely being run in different CI jobs so
      // the requests to the skippable endpoint might be done at different times and their responses might be different.
      // If the skippable endpoint is returning different suites and we filter the list of tests here,
      // the base list of tests that is used for sharding might be different,
      // causing the shards to potentially run the same suite.
      return testPaths
    }
    const { tests } = testPaths

    const suitesToRun = applySuiteSkipping(tests, rootDir, frameworkVersion)
    return { ...testPaths, tests: suitesToRun }
  })

  return searchSourcePackage
})

// from 25.1.0 on, readConfigs becomes async
addHook({
  name: 'jest-config',
  versions: ['>=25.1.0']
}, jestConfigAsyncWrapper)

addHook({
  name: 'jest-config',
  versions: ['24.8.0 - 24.9.0']
}, jestConfigSyncWrapper)

const LIBRARIES_BYPASSING_JEST_REQUIRE_ENGINE = [
  'selenium-webdriver'
]

function shouldBypassJestRequireEngine (moduleName) {
  return (
    LIBRARIES_BYPASSING_JEST_REQUIRE_ENGINE.some(library => moduleName.includes(library))
  )
}

addHook({
  name: 'jest-runtime',
  versions: ['>=24.8.0']
}, (runtimePackage) => {
  const Runtime = runtimePackage.default ? runtimePackage.default : runtimePackage

  shimmer.wrap(Runtime.prototype, 'requireModuleOrMock', requireModuleOrMock => function (from, moduleName) {
    // TODO: do this for every library that we instrument
    if (shouldBypassJestRequireEngine(moduleName)) {
      // To bypass jest's own require engine
      return this._requireCoreModule(moduleName)
    }
    return requireModuleOrMock.apply(this, arguments)
  })

  return runtimePackage
})

addHook({
  name: 'jest-worker',
  versions: ['>=24.9.0'],
  file: 'build/workers/ChildProcessWorker.js'
}, (childProcessWorker) => {
  const ChildProcessWorker = childProcessWorker.default
  shimmer.wrap(ChildProcessWorker.prototype, 'send', send => function (request) {
    if (!isEarlyFlakeDetectionEnabled) {
      return send.apply(this, arguments)
    }
    const [type] = request
    // eslint-disable-next-line
    // https://github.com/jestjs/jest/blob/1d682f21c7a35da4d3ab3a1436a357b980ebd0fa/packages/jest-worker/src/workers/ChildProcessWorker.ts#L424
    if (type === CHILD_MESSAGE_CALL) {
      // This is the message that the main process sends to the worker to run a test suite (=test file).
      // In here we modify the config.testEnvironmentOptions to include the known tests for the suite.
      // This way the suite only knows about the tests that are part of it.
      const args = request[request.length - 1]
      if (args.length > 1) {
        return send.apply(this, arguments)
      }
      if (!args[0]?.config) {
        return send.apply(this, arguments)
      }
      const [{ globalConfig, config, path: testSuiteAbsolutePath }] = args
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, globalConfig.rootDir || process.cwd())
      const suiteKnownTests = knownTests.jest?.[testSuite] || []
      args[0].config = {
        ...config,
        testEnvironmentOptions: {
          ...config.testEnvironmentOptions,
          _ddKnownTests: suiteKnownTests
        }
      }
    }

    return send.apply(this, arguments)
  })
  shimmer.wrap(ChildProcessWorker.prototype, '_onMessage', _onMessage => function () {
    const [code, data] = arguments[0]
    if (code === JEST_WORKER_TRACE_PAYLOAD_CODE) { // datadog trace payload
      sessionAsyncResource.runInAsyncScope(() => {
        workerReportTraceCh.publish(data)
      })
      return
    }
    if (code === JEST_WORKER_COVERAGE_PAYLOAD_CODE) { // datadog coverage payload
      sessionAsyncResource.runInAsyncScope(() => {
        workerReportCoverageCh.publish(data)
      })
      return
    }
    return _onMessage.apply(this, arguments)
  })
  return childProcessWorker
})
