'use strict'
const { createCoverageMap } = require('istanbul-lib-coverage')

const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')

const testStartCh = channel('ci:cucumber:test:start')
const testFinishCh = channel('ci:cucumber:test:finish') // used for test steps too

const testStepStartCh = channel('ci:cucumber:test-step:start')

const errorCh = channel('ci:cucumber:error')

const testSuiteStartCh = channel('ci:cucumber:test-suite:start')
const testSuiteFinishCh = channel('ci:cucumber:test-suite:finish')
const testSuiteCodeCoverageCh = channel('ci:cucumber:test-suite:code-coverage')

const itrConfigurationCh = channel('ci:cucumber:itr-configuration')
const skippableSuitesCh = channel('ci:cucumber:test-suite:skippable')
const sessionStartCh = channel('ci:cucumber:session:start')
const sessionFinishCh = channel('ci:cucumber:session:finish')

const itrSkippedSuitesCh = channel('ci:cucumber:itr:skipped-suites')

const {
  getCoveredFilenamesFromCoverage,
  resetCoverage,
  mergeCoverage,
  fromCoverageMapToCoverage,
  getTestSuitePath
} = require('../../dd-trace/src/plugins/util/test')

const isMarkedAsUnskippable = (pickle) => {
  return !!pickle.tags.find(tag => tag.name === '@datadog:unskippable')
}

// We'll preserve the original coverage here
const originalCoverageMap = createCoverageMap()

// TODO: remove in a later major version
const patched = new WeakSet()

let pickleByFile = {}
const pickleResultByFile = {}
let skippableSuites = []
let isForcedToRun = false
let isUnskippable = false

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

function wrapRun (pl, isLatestVersion) {
  if (patched.has(pl)) return

  patched.add(pl)

  shimmer.wrap(pl.prototype, 'run', run => function () {
    if (!testStartCh.hasSubscribers) {
      return run.apply(this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      const testSuiteFullPath = this.pickle.uri

      if (!pickleResultByFile[testSuiteFullPath]) { // first test in suite
        isUnskippable = isMarkedAsUnskippable(this.pickle)
        const testSuitePath = getTestSuitePath(testSuiteFullPath, process.cwd())
        isForcedToRun = isUnskippable && skippableSuites.includes(testSuitePath)

        testSuiteStartCh.publish({ testSuitePath, isUnskippable, isForcedToRun })
      }

      const testSourceLine = this.gherkinDocument &&
        this.gherkinDocument.feature &&
        this.gherkinDocument.feature.location &&
        this.gherkinDocument.feature.location.line

      testStartCh.publish({
        testName: this.pickle.name,
        fullTestSuite: testSuiteFullPath,
        testSourceLine
      })
      try {
        const promise = run.apply(this, arguments)
        promise.finally(() => {
          const result = this.getWorstStepResult()
          const { status, skipReason, errorMessage } = isLatestVersion
            ? getStatusFromResultLatest(result) : getStatusFromResult(result)

          if (!pickleResultByFile[testSuiteFullPath]) {
            pickleResultByFile[testSuiteFullPath] = [status]
          } else {
            pickleResultByFile[testSuiteFullPath].push(status)
          }
          testFinishCh.publish({ status, skipReason, errorMessage })
          // last test in suite
          if (pickleResultByFile[testSuiteFullPath].length === pickleByFile[testSuiteFullPath].length) {
            const testSuiteStatus = getSuiteStatusFromTestStatuses(pickleResultByFile[testSuiteFullPath])
            if (global.__coverage__) {
              const coverageFiles = getCoveredFilenamesFromCoverage(global.__coverage__)

              testSuiteCodeCoverageCh.publish({
                coverageFiles,
                suiteFile: testSuiteFullPath
              })
              // We need to reset coverage to get a code coverage per suite
              // Before that, we preserve the original coverage
              mergeCoverage(global.__coverage__, originalCoverageMap)
              resetCoverage(global.__coverage__)
            }

            testSuiteFinishCh.publish(testSuiteStatus)
          }
        })
        return promise
      } catch (err) {
        errorCh.publish(err)
        throw err
      }
    })
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
            ? getStatusFromResultLatest(result) : getStatusFromResult(result)

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
  if (process.env.CUCUMBER_WORKER_ID) {
    // Parallel mode is not supported
    log.warn('Unable to initialize CI Visibility because Cucumber is running in parallel mode.')
    return PickleRunner
  }

  const pl = PickleRunner.default

  wrapRun(pl, false)

  return PickleRunner
}

function testCaseHook (TestCaseRunner) {
  if (process.env.CUCUMBER_WORKER_ID) {
    // Parallel mode is not supported
    log.warn('Unable to initialize CI Visibility because Cucumber is running in parallel mode.')
    return TestCaseRunner
  }

  const pl = TestCaseRunner.default

  wrapRun(pl, true)

  return TestCaseRunner
}

addHook({
  name: '@cucumber/cucumber',
  versions: ['7.0.0 - 7.2.1'],
  file: 'lib/runtime/pickle_runner.js'
}, pickleHook)

addHook({
  name: '@cucumber/cucumber',
  versions: ['>=7.3.0'],
  file: 'lib/runtime/test_case_runner.js'
}, testCaseHook)

function getFilteredPickles (runtime, suitesToSkip) {
  return runtime.pickleIds.reduce((acc, pickleId) => {
    const test = runtime.eventDataCollector.getPickle(pickleId)
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

function getPickleByFile (runtime) {
  return runtime.pickleIds.reduce((acc, pickleId) => {
    const test = runtime.eventDataCollector.getPickle(pickleId)
    if (acc[test.uri]) {
      acc[test.uri].push(test)
    } else {
      acc[test.uri] = [test]
    }
    return acc
  }, {})
}

addHook({
  name: '@cucumber/cucumber',
  versions: ['>=7.0.0'],
  file: 'lib/runtime/index.js'
}, (runtimePackage, frameworkVersion) => {
  shimmer.wrap(runtimePackage.default.prototype, 'start', start => async function () {
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    let onDone

    const configPromise = new Promise(resolve => {
      onDone = resolve
    })

    asyncResource.runInAsyncScope(() => {
      itrConfigurationCh.publish({ onDone })
    })

    await configPromise

    const skippableSuitesPromise = new Promise(resolve => {
      onDone = resolve
    })

    asyncResource.runInAsyncScope(() => {
      skippableSuitesCh.publish({ onDone })
    })

    const skippableResponse = await skippableSuitesPromise

    const err = skippableResponse.err
    skippableSuites = skippableResponse.skippableSuites

    let skippedSuites = []
    let isSuitesSkipped = false

    if (!err) {
      const filteredPickles = getFilteredPickles(this, skippableSuites)
      const { picklesToRun } = filteredPickles
      isSuitesSkipped = picklesToRun.length !== this.pickleIds.length

      log.debug(
        () => `${picklesToRun.length} out of ${this.pickleIds.length} suites are going to run.`
      )

      this.pickleIds = picklesToRun

      skippedSuites = Array.from(filteredPickles.skippedSuites)
    }

    pickleByFile = getPickleByFile(this)

    const processArgv = process.argv.slice(2).join(' ')
    const command = process.env.npm_lifecycle_script || `cucumber-js ${processArgv}`

    asyncResource.runInAsyncScope(() => {
      sessionStartCh.publish({ command, frameworkVersion })
    })

    if (!err && skippedSuites.length) {
      itrSkippedSuitesCh.publish({ skippedSuites, frameworkVersion })
    }

    const success = await start.apply(this, arguments)

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

    asyncResource.runInAsyncScope(() => {
      sessionFinishCh.publish({
        status: success ? 'pass' : 'fail',
        isSuitesSkipped,
        testCodeCoverageLinesTotal,
        numSkippedSuites: skippedSuites.length,
        hasUnskippableSuites: isUnskippable,
        hasForcedToRunSuites: isForcedToRun
      })
    })
    return success
  })

  return runtimePackage
})
