'use strict'
const { createCoverageMap } = require('istanbul-lib-coverage')

const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')

const testStartCh = channel('ci:cucumber:test:start')
const testRetryCh = channel('ci:cucumber:test:retry')
const testFinishCh = channel('ci:cucumber:test:finish') // used for test steps too

const testStepStartCh = channel('ci:cucumber:test-step:start')

const errorCh = channel('ci:cucumber:error')

const testSuiteStartCh = channel('ci:cucumber:test-suite:start')
const testSuiteFinishCh = channel('ci:cucumber:test-suite:finish')
const testSuiteCodeCoverageCh = channel('ci:cucumber:test-suite:code-coverage')

const libraryConfigurationCh = channel('ci:cucumber:library-configuration')
const knownTestsCh = channel('ci:cucumber:known-tests')
const skippableSuitesCh = channel('ci:cucumber:test-suite:skippable')
const sessionStartCh = channel('ci:cucumber:session:start')
const sessionFinishCh = channel('ci:cucumber:session:finish')

const workerReportTraceCh = channel('ci:cucumber:worker-report:trace')

const itrSkippedSuitesCh = channel('ci:cucumber:itr:skipped-suites')

const getCodeCoverageCh = channel('ci:nyc:get-coverage')

const {
  getCoveredFilenamesFromCoverage,
  resetCoverage,
  mergeCoverage,
  fromCoverageMapToCoverage,
  getTestSuitePath,
  CUCUMBER_WORKER_TRACE_PAYLOAD_CODE
} = require('../../dd-trace/src/plugins/util/test')

const isMarkedAsUnskippable = (pickle) => {
  return !!pickle.tags.find(tag => tag.name === '@datadog:unskippable')
}

// We'll preserve the original coverage here
const originalCoverageMap = createCoverageMap()

// TODO: remove in a later major version
const patched = new WeakSet()

const lastStatusByPickleId = new Map()
const numRetriesByPickleId = new Map()
const numAttemptToAsyncResource = new Map()

let eventDataCollector = null
let pickleByFile = {}
const pickleResultByFile = {}

const sessionAsyncResource = new AsyncResource('bound-anonymous-fn')

let skippableSuites = []
let itrCorrelationId = ''
let isForcedToRun = false
let isUnskippable = false
let isSuitesSkippingEnabled = false
let isEarlyFlakeDetectionEnabled = false
let earlyFlakeDetectionNumRetries = 0
let isFlakyTestRetriesEnabled = false
let numTestRetries = 0
let knownTests = []
let skippedSuites = []
let isSuitesSkipped = false

function getSuiteStatusFromTestStatuses (testStatuses) {
  if (testStatuses.some(status => status === 'fail')) {
    return 'fail'
  }
  if (testStatuses.every(status => status === 'skip')) {
    return 'skip'
  }
  return 'pass'
}

function getStatusFromResult (result) {
  if (result.status === 1) {
    return { status: 'pass' }
  }
  if (result.status === 2) {
    return { status: 'skip' }
  }
  if (result.status === 4) {
    return { status: 'skip', skipReason: 'not implemented' }
  }
  return { status: 'fail', errorMessage: result.message }
}

function getStatusFromResultLatest (result) {
  if (result.status === 'PASSED') {
    return { status: 'pass' }
  }
  if (result.status === 'SKIPPED' || result.status === 'PENDING') {
    return { status: 'skip' }
  }
  if (result.status === 'UNDEFINED') {
    return { status: 'skip', skipReason: 'not implemented' }
  }
  return { status: 'fail', errorMessage: result.message }
}

function isNewTest (testSuite, testName) {
  const testsForSuite = knownTests.cucumber?.[testSuite] || []
  return !testsForSuite.includes(testName)
}

function getTestStatusFromRetries (testStatuses) {
  if (testStatuses.every(status => status === 'fail')) {
    return 'fail'
  }
  if (testStatuses.some(status => status === 'pass')) {
    return 'pass'
  }
  return 'pass'
}

function getChannelPromise (channelToPublishTo) {
  return new Promise(resolve => {
    sessionAsyncResource.runInAsyncScope(() => {
      channelToPublishTo.publish({ onDone: resolve })
    })
  })
}

function getFilteredPickles (runtimeOrCoodinator, suitesToSkip) {
  if (runtimeOrCoodinator.sourcedPickles) {
    return runtimeOrCoodinator.sourcedPickles.reduce((acc, sourcedPickle) => {
      const { pickle } = sourcedPickle
      const testSuitePath = getTestSuitePath(pickle.uri, process.cwd())

      const isUnskippable = isMarkedAsUnskippable(pickle)
      const isSkipped = suitesToSkip.includes(testSuitePath)

      if (isSkipped && !isUnskippable) {
        acc.skippedSuites.add(testSuitePath)
      } else {
        acc.picklesToRun.push(sourcedPickle)
      }
      return acc
    }, { skippedSuites: new Set(), picklesToRun: [] })
  }
  return runtimeOrCoodinator.pickleIds.reduce((acc, pickleId) => {
    const test = runtimeOrCoodinator.eventDataCollector.getPickle(pickleId)
    const testSuitePath = getTestSuitePath(test.uri, process.cwd())

    const isUnskippable = isMarkedAsUnskippable(test)
    const isSkipped = suitesToSkip.includes(testSuitePath)

    if (isSkipped && !isUnskippable) {
      acc.skippedSuites.add(testSuitePath)
    } else {
      acc.picklesToRun.push(pickleId)
    }
    return acc
  }, { skippedSuites: new Set(), picklesToRun: [] })
}

function getPickleByFile (runtimeOrCoodinator) {
  // new version
  if (runtimeOrCoodinator.sourcedPickles) {
    return runtimeOrCoodinator.sourcedPickles.reduce((acc, { pickle }) => {
      if (acc[pickle.uri]) {
        acc[pickle.uri].push(pickle)
      } else {
        acc[pickle.uri] = [pickle]
      }
      return acc
    }, {})
  }

  return runtimeOrCoodinator.pickleIds.reduce((acc, pickleId) => {
    const test = runtimeOrCoodinator.eventDataCollector.getPickle(pickleId)
    if (acc[test.uri]) {
      acc[test.uri].push(test)
    } else {
      acc[test.uri] = [test]
    }
    return acc
  }, {})
}

function wrapRun (pl, isLatestVersion) {
  if (patched.has(pl)) return

  patched.add(pl)

  shimmer.wrap(pl.prototype, 'run', run => function () {
    if (!testStartCh.hasSubscribers) {
      return run.apply(this, arguments)
    }

    let numAttempt = 0

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    numAttemptToAsyncResource.set(numAttempt, asyncResource)

    const testFileAbsolutePath = this.pickle.uri

    const testSourceLine = this.gherkinDocument?.feature?.location?.line

    const testStartPayload = {
      testName: this.pickle.name,
      testFileAbsolutePath,
      testSourceLine,
      isParallel: !!process.env.CUCUMBER_WORKER_ID
    }
    asyncResource.runInAsyncScope(() => {
      testStartCh.publish(testStartPayload)
    })
    try {
      this.eventBroadcaster.on('envelope', shimmer.wrapFunction(null, () => (testCase) => {
        // Only supported from >=8.0.0
        if (testCase?.testCaseFinished) {
          const { testCaseFinished: { willBeRetried } } = testCase
          if (willBeRetried) { // test case failed and will be retried
            const failedAttemptAsyncResource = numAttemptToAsyncResource.get(numAttempt)
            failedAttemptAsyncResource.runInAsyncScope(() => {
              testRetryCh.publish(numAttempt++ > 0) // the current span will be finished and a new one will be created
            })

            const newAsyncResource = new AsyncResource('bound-anonymous-fn')
            numAttemptToAsyncResource.set(numAttempt, newAsyncResource)

            newAsyncResource.runInAsyncScope(() => {
              testStartCh.publish(testStartPayload) // a new span will be created
            })
          }
        }
      }))
      let promise

      asyncResource.runInAsyncScope(() => {
        promise = run.apply(this, arguments)
      })
      promise.finally(() => {
        const result = this.getWorstStepResult()
        const { status, skipReason, errorMessage } = isLatestVersion
          ? getStatusFromResultLatest(result)
          : getStatusFromResult(result)

        if (lastStatusByPickleId.has(this.pickle.id)) {
          lastStatusByPickleId.get(this.pickle.id).push(status)
        } else {
          lastStatusByPickleId.set(this.pickle.id, [status])
        }
        let isNew = false
        let isEfdRetry = false
        if (isEarlyFlakeDetectionEnabled && status !== 'skip') {
          const numRetries = numRetriesByPickleId.get(this.pickle.id)

          isNew = numRetries !== undefined
          isEfdRetry = numRetries > 0
        }
        const attemptAsyncResource = numAttemptToAsyncResource.get(numAttempt)

        attemptAsyncResource.runInAsyncScope(() => {
          testFinishCh.publish({ status, skipReason, errorMessage, isNew, isEfdRetry, isFlakyRetry: numAttempt > 0 })
        })
      })
      return promise
    } catch (err) {
      errorCh.publish(err)
      throw err
    }
  })
  shimmer.wrap(pl.prototype, 'runStep', runStep => function () {
    if (!testStepStartCh.hasSubscribers) {
      return runStep.apply(this, arguments)
    }
    const testStep = arguments[0]
    let resource

    if (isLatestVersion) {
      resource = testStep.text
    } else {
      resource = testStep.isHook ? 'hook' : testStep.pickleStep.text
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      testStepStartCh.publish({ resource })
      try {
        const promise = runStep.apply(this, arguments)

        promise.then((result) => {
          const { status, skipReason, errorMessage } = isLatestVersion
            ? getStatusFromResultLatest(result)
            : getStatusFromResult(result)

          testFinishCh.publish({ isStep: true, status, skipReason, errorMessage })
        })
        return promise
      } catch (err) {
        errorCh.publish(err)
        throw err
      }
    })
  })
}

function pickleHook (PickleRunner) {
  const pl = PickleRunner.default

  wrapRun(pl, false)

  return PickleRunner
}

function testCaseHook (TestCaseRunner) {
  const pl = TestCaseRunner.default

  wrapRun(pl, true)

  return TestCaseRunner
}

function getOptions (adapterOrCoordinator) {
  if (adapterOrCoordinator.adapter) {
    return adapterOrCoordinator.adapter.worker?.options || adapterOrCoordinator.adapter.options
  }
  return adapterOrCoordinator.options
}

function getWrappedStart (start, frameworkVersion, isParallel = false, isCoordinator = false) {
  return async function () {
    if (!libraryConfigurationCh.hasSubscribers) {
      return start.apply(this, arguments)
    }
    const options = getOptions(this)

    if (!isParallel && this.adapter?.options) {
      isParallel = options.parallel > 0
    }
    let errorSkippableRequest

    const configurationResponse = await getChannelPromise(libraryConfigurationCh)

    isEarlyFlakeDetectionEnabled = configurationResponse.libraryConfig?.isEarlyFlakeDetectionEnabled
    earlyFlakeDetectionNumRetries = configurationResponse.libraryConfig?.earlyFlakeDetectionNumRetries
    isSuitesSkippingEnabled = configurationResponse.libraryConfig?.isSuitesSkippingEnabled
    isFlakyTestRetriesEnabled = configurationResponse.libraryConfig?.isFlakyTestRetriesEnabled
    numTestRetries = configurationResponse.libraryConfig?.flakyTestRetriesCount

    if (isEarlyFlakeDetectionEnabled) {
      const knownTestsResponse = await getChannelPromise(knownTestsCh)
      if (!knownTestsResponse.err) {
        knownTests = knownTestsResponse.knownTests
      } else {
        isEarlyFlakeDetectionEnabled = false
      }
    }

    if (isSuitesSkippingEnabled) {
      const skippableResponse = await getChannelPromise(skippableSuitesCh)

      errorSkippableRequest = skippableResponse.err
      skippableSuites = skippableResponse.skippableSuites

      if (!errorSkippableRequest) {
        const filteredPickles = getFilteredPickles(this, skippableSuites)
        const { picklesToRun } = filteredPickles
        const oldPickles = isCoordinator ? this.sourcedPickles : this.pickleIds

        isSuitesSkipped = picklesToRun.length !== oldPickles.length

        log.debug(
          () => `${picklesToRun.length} out of ${oldPickles.length} suites are going to run.`
        )

        if (isCoordinator) {
          this.sourcedPickles = picklesToRun
        } else {
          this.pickleIds = picklesToRun
        }

        skippedSuites = Array.from(filteredPickles.skippedSuites)
        itrCorrelationId = skippableResponse.itrCorrelationId
      }
    }

    pickleByFile = getPickleByFile(this)

    const processArgv = process.argv.slice(2).join(' ')
    const command = process.env.npm_lifecycle_script || `cucumber-js ${processArgv}`

    if (isFlakyTestRetriesEnabled && !options.retry && numTestRetries > 0) {
      options.retry = numTestRetries
    }

    sessionAsyncResource.runInAsyncScope(() => {
      sessionStartCh.publish({ command, frameworkVersion })
    })

    if (!errorSkippableRequest && skippedSuites.length) {
      itrSkippedSuitesCh.publish({ skippedSuites, frameworkVersion })
    }

    const success = await start.apply(this, arguments)

    let untestedCoverage
    if (getCodeCoverageCh.hasSubscribers) {
      untestedCoverage = await getChannelPromise(getCodeCoverageCh)
    }

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

    sessionAsyncResource.runInAsyncScope(() => {
      sessionFinishCh.publish({
        status: success ? 'pass' : 'fail',
        isSuitesSkipped,
        testCodeCoverageLinesTotal,
        numSkippedSuites: skippedSuites.length,
        hasUnskippableSuites: isUnskippable,
        hasForcedToRunSuites: isForcedToRun,
        isEarlyFlakeDetectionEnabled,
        isParallel
      })
    })
    eventDataCollector = null
    return success
  }
}

function getWrappedRunTestCase (runTestCaseFunction, isNewerVersion) {
  return async function () {
    let pickle
    if (isNewerVersion) {
      pickle = arguments[0].pickle
    } else {
      pickle = this.eventDataCollector.getPickle(arguments[0])
    }

    const testFileAbsolutePath = pickle.uri
    const testSuitePath = getTestSuitePath(testFileAbsolutePath, process.cwd())

    if (!pickleResultByFile[testFileAbsolutePath]) { // first test in suite
      isUnskippable = isMarkedAsUnskippable(pickle)
      isForcedToRun = isUnskippable && skippableSuites.includes(testSuitePath)

      testSuiteStartCh.publish({ testSuitePath, isUnskippable, isForcedToRun, itrCorrelationId })
    }

    let isNew = false

    if (isEarlyFlakeDetectionEnabled) {
      isNew = isNewTest(testSuitePath, pickle.name)
      if (isNew) {
        numRetriesByPickleId.set(pickle.id, 0)
      }
    }
    const runTestCaseResult = await runTestCaseFunction.apply(this, arguments)

    const testStatuses = lastStatusByPickleId.get(pickle.id)
    const lastTestStatus = testStatuses[testStatuses.length - 1]
    // If it's a new test and it hasn't been skipped, we run it again
    if (isEarlyFlakeDetectionEnabled && lastTestStatus !== 'skip' && isNew) {
      for (let retryIndex = 0; retryIndex < earlyFlakeDetectionNumRetries; retryIndex++) {
        numRetriesByPickleId.set(pickle.id, retryIndex + 1)
        await runTestCaseFunction.apply(this, arguments)
      }
    }
    let testStatus = lastTestStatus
    if (isEarlyFlakeDetectionEnabled) {
      /**
       * If Early Flake Detection (EFD) is enabled the logic is as follows:
       * - If all attempts for a test are failing, the test has failed and we will let the test process fail.
       * - If just a single attempt passes, we will prevent the test process from failing.
       * The rationale behind is the following: you may still be able to block your CI pipeline by gating
       * on flakiness (the test will be considered flaky), but you may choose to unblock the pipeline too.
       */
      testStatus = getTestStatusFromRetries(testStatuses)
      if (testStatus === 'pass') {
        this.success = true // MIGHT NOT BE COMPATIBLE WITH >=11
      }
    }

    if (!pickleResultByFile[testFileAbsolutePath]) {
      pickleResultByFile[testFileAbsolutePath] = [testStatus]
    } else {
      pickleResultByFile[testFileAbsolutePath].push(testStatus)
    }

    // last test in suite
    if (pickleResultByFile[testFileAbsolutePath].length === pickleByFile[testFileAbsolutePath].length) {
      const testSuiteStatus = getSuiteStatusFromTestStatuses(pickleResultByFile[testFileAbsolutePath])
      if (global.__coverage__) {
        const coverageFiles = getCoveredFilenamesFromCoverage(global.__coverage__)

        testSuiteCodeCoverageCh.publish({
          coverageFiles,
          suiteFile: testFileAbsolutePath,
          testSuitePath
        })
        // We need to reset coverage to get a code coverage per suite
        // Before that, we preserve the original coverage
        mergeCoverage(global.__coverage__, originalCoverageMap)
        resetCoverage(global.__coverage__)
      }

      testSuiteFinishCh.publish({ status: testSuiteStatus, testSuitePath })
    }

    return runTestCaseResult
  }
}

function getWrappedParseWorkerMessage (parseWorkerMessageFunction, isNewVersion) {
  return function (worker, message) {
    // If the message is an array, it's a dd-trace message, so we need to stop cucumber processing,
    // or cucumber will throw an error
    // TODO: identify the message better
    if (Array.isArray(message)) {
      const [messageCode, payload] = message
      if (messageCode === CUCUMBER_WORKER_TRACE_PAYLOAD_CODE) {
        sessionAsyncResource.runInAsyncScope(() => {
          workerReportTraceCh.publish(payload)
        })
        return
      }
    }

    let envelope

    if (isNewVersion) {
      envelope = message.envelope
    } else {
      envelope = message.jsonEnvelope
    }

    if (!envelope) {
      return parseWorkerMessageFunction.apply(this, arguments)
    }
    let parsed = envelope

    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(envelope)
      } catch (e) {
        // ignore errors and continue
        return parseWorkerMessageFunction.apply(this, arguments)
      }
    }
    let pickle

    if (parsed.testCaseStarted) {
      if (isNewVersion) {
        pickle = this.inProgress[worker.id].pickle
      } else {
        const { pickleId } = this.eventDataCollector.testCaseMap[parsed.testCaseStarted.testCaseId]
        pickle = this.eventDataCollector.getPickle(pickleId)
      }
      // THIS FAILS IN PARALLEL MODE
      const testFileAbsolutePath = pickle.uri
      // First test in suite
      if (!pickleResultByFile[testFileAbsolutePath]) {
        pickleResultByFile[testFileAbsolutePath] = []
        testSuiteStartCh.publish({
          testSuitePath: getTestSuitePath(testFileAbsolutePath, process.cwd())
        })
      }
    }

    const parseWorkerResponse = parseWorkerMessageFunction.apply(this, arguments)

    // after calling `parseWorkerMessageFunction`, the test status can already be read
    if (parsed.testCaseFinished) {
      let worstTestStepResult
      if (isNewVersion && eventDataCollector) {
        pickle = this.inProgress[worker.id].pickle
        worstTestStepResult =
          eventDataCollector.getTestCaseAttempt(parsed.testCaseFinished.testCaseStartedId).worstTestStepResult
      } else {
        const testCase = this.eventDataCollector.getTestCaseAttempt(parsed.testCaseFinished.testCaseStartedId)
        worstTestStepResult = testCase.worstTestStepResult
        pickle = testCase.pickle
      }

      // TODO: can we get error message?
      const { status } = getStatusFromResultLatest(worstTestStepResult)

      const testFileAbsolutePath = pickle.uri
      const finished = pickleResultByFile[testFileAbsolutePath]
      finished.push(status)

      if (finished.length === pickleByFile[testFileAbsolutePath].length) {
        testSuiteFinishCh.publish({
          status: getSuiteStatusFromTestStatuses(finished), // maybe tests themselves can add to this list
          testSuitePath: getTestSuitePath(testFileAbsolutePath, process.cwd())
        })
      }
    }

    return parseWorkerResponse
  }
}

// Test start / finish for older versions. The only hook executed in workers when in parallel mode
addHook({
  name: '@cucumber/cucumber',
  versions: ['7.0.0 - 7.2.1'],
  file: 'lib/runtime/pickle_runner.js'
}, pickleHook)

// Test start / finish for newer versions. The only hook executed in workers when in parallel mode

// still works for >=11.0.0
addHook({
  name: '@cucumber/cucumber',
  versions: ['>=7.3.0'],
  file: 'lib/runtime/test_case_runner.js'
}, testCaseHook)

// From 7.3.0 onwards, runPickle becomes runTestCase. Not executed in parallel mode.
// `getWrappedStart` generates session start and finish events
// `getWrappedRunTest` generates suite start and finish events. Also EFD
// there is a lib/runtime/index in 11.0.0, but we don't instrument it because it's not useful for us
// this causes a log warning "incompatibility detected". TODO: fix this
addHook({
  name: '@cucumber/cucumber',
  versions: ['>=7.3.0 <11.0.0'],
  file: 'lib/runtime/index.js'
}, (runtimePackage, frameworkVersion) => {
  shimmer.wrap(runtimePackage.default.prototype, 'runTestCase', runTestCase => getWrappedRunTestCase(runTestCase))

  shimmer.wrap(runtimePackage.default.prototype, 'start', start => getWrappedStart(start, frameworkVersion))

  return runtimePackage
})

addHook({
  name: '@cucumber/cucumber',
  versions: ['>=11.0.0'],
  file: 'lib/runtime/worker.js'
}, (workerPackage) => {
  if (!process.env.CUCUMBER_WORKER_ID) {
    shimmer.wrap(workerPackage.Worker.prototype, 'runTestCase', runTestCase => getWrappedRunTestCase(runTestCase, true))
  }
  return workerPackage
})

addHook({
  name: '@cucumber/cucumber',
  versions: ['>=11.0.0'],
  file: 'lib/runtime/coordinator.js'
}, (coordinatorPackage, frameworkVersion) => {
  shimmer.wrap(
    coordinatorPackage.Coordinator.prototype,
    'run',
    run => getWrappedStart(run, frameworkVersion, false, true)
  )
  return coordinatorPackage
})

// Not executed in parallel mode.
// `getWrappedStart` generates session start and finish events
// `getWrappedRunTest` generates suite start and finish events
addHook({
  name: '@cucumber/cucumber',
  versions: ['>=7.0.0 <7.3.0'],
  file: 'lib/runtime/index.js'
}, (runtimePackage, frameworkVersion) => {
  shimmer.wrap(runtimePackage.default.prototype, 'runPickle', runPickle => getWrappedRunTestCase(runPickle))
  shimmer.wrap(runtimePackage.default.prototype, 'start', start => getWrappedStart(start, frameworkVersion))

  return runtimePackage
})

// Only executed in parallel mode.
// `getWrappedStart` generates session start and finish events
// `getWrappedGiveWork` generates suite start events and sets pickleResultByFile (used by suite finish events)
// `getWrappedParseWorkerMessage` generates suite finish events
addHook({
  name: '@cucumber/cucumber',
  versions: ['>=8.0.0 <11.0.0'],
  file: 'lib/runtime/parallel/coordinator.js'
}, (coordinatorPackage, frameworkVersion) => {
  shimmer.wrap(coordinatorPackage.default.prototype, 'start', start => getWrappedStart(start, frameworkVersion, true))
  shimmer.wrap(
    coordinatorPackage.default.prototype,
    'parseWorkerMessage',
    parseWorkerMessage => getWrappedParseWorkerMessage(parseWorkerMessage)
  )
  return coordinatorPackage
})

// Only executed in parallel mode.
// `getWrappedStart` generates session start and finish events
// `getWrappedGiveWork` generates suite start events and sets pickleResultByFile (used by suite finish events)
// `getWrappedParseWorkerMessage` generates suite finish events
addHook({
  name: '@cucumber/cucumber',
  versions: ['>=11.0.0'],
  file: 'lib/runtime/parallel/adapter.js'
}, (adapterPackage) => {
  shimmer.wrap(
    adapterPackage.ChildProcessAdapter.prototype,
    'parseWorkerMessage',
    parseWorkerMessage => getWrappedParseWorkerMessage(parseWorkerMessage, true)
  )
  return adapterPackage
})

addHook({
  name: '@cucumber/cucumber',
  versions: ['>=11.0.0'],
  file: 'lib/formatter/helpers/event_data_collector.js'
}, (eventDataCollectorPackage) => {
  shimmer.wrap(eventDataCollectorPackage.default.prototype, 'parseEnvelope', parseEnvelope => function () {
    eventDataCollector = this
    return parseEnvelope.apply(this, arguments)
  })
  return eventDataCollectorPackage
})
