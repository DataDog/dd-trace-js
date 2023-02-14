'use strict'

const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const testStartCh = channel('ci:cucumber:test:start')
const testFinishCh = channel('ci:cucumber:test:finish') // used for test steps too

const testStepStartCh = channel('ci:cucumber:test-step:start')

const errorCh = channel('ci:cucumber:error')

const testSuiteStartCh = channel('ci:cucumber:test-suite:start')
const testSuiteFinishCh = channel('ci:cucumber:test-suite:finish')

const sessionStartCh = channel('ci:cucumber:session:start')
const sessionFinishCh = channel('ci:cucumber:session:finish')

// TODO: remove in a later major version
const patched = new WeakSet()

let pickleByFile = {}
const pickleResultByFile = {}

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
        testSuiteStartCh.publish(testSuiteFullPath)
      }
      testStartCh.publish({ testName: this.pickle.name, fullTestSuite: testSuiteFullPath })
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
          // last test in suite
          if (pickleResultByFile[testSuiteFullPath].length === pickleByFile[testSuiteFullPath].length) {
            const testSuiteStatus = getSuiteStatusFromTestStatuses(pickleResultByFile[testSuiteFullPath])
            testSuiteFinishCh.publish(testSuiteStatus)
          }
          testFinishCh.publish({ status, skipReason, errorMessage })
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
  const pl = PickleRunner.default

  wrapRun(pl, false)

  return PickleRunner
}

function testCaseHook (TestCaseRunner) {
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
}, (runtimePackage, cucumberVersion) => {
  shimmer.wrap(runtimePackage.default.prototype, 'start', start => async function () {
    pickleByFile = getPickleByFile(this)

    const processArgv = process.argv.slice(2).join(' ')
    const command = process.env.npm_lifecycle_script || `cucumber-js ${processArgv}`

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    asyncResource.runInAsyncScope(() => {
      sessionStartCh.publish({ command, frameworkVersion: cucumberVersion })
    })
    const success = await start.apply(this, arguments)

    asyncResource.runInAsyncScope(() => {
      sessionFinishCh.publish(success ? 'pass' : 'fail')
    })
    return success
  })

  return runtimePackage
})
