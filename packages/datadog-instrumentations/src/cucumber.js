'use strict'

const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const runStartCh = channel('ci:cucumber:run:start')
const runEndCh = channel('ci:cucumber:run:end')
const runAsyncEndCh = channel('ci:cucumber:run:async-end')
const runStepStartCh = channel('ci:cucumber:run-step:start')
const runStepEndCh = channel('ci:cucumber:run-step:end')
const errorCh = channel('ci:cucumber:error')

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
  shimmer.wrap(pl.prototype, 'run', run => function () {
    if (!runStartCh.hasSubscribers) {
      return run.apply(this, arguments)
    }

    runStartCh.publish({ pickleName: this.pickle.name, pickleUri: this.pickle.uri })
    try {
      const promise = run.apply(this, arguments)
      promise.finally(() => {
        const result = this.getWorstStepResult()
        const { status, skipReason, errorMessage } = isLatestVersion
          ? getStatusFromResultLatest(result) : getStatusFromResult(result)

        runAsyncEndCh.publish({ status, skipReason, errorMessage })
      })
      return promise
    } catch (err) {
      errorCh.publish(err)
    } finally {
      runEndCh.publish(undefined)
    }
  })
  shimmer.wrap(pl.prototype, 'runStep', runStep => function () {
    if (!runStepStartCh.hasSubscribers) {
      return runStep.apply(this, arguments)
    }
    const testStep = arguments[0]
    let resource

    if (isLatestVersion) {
      resource = testStep.text
    } else {
      resource = testStep.isHook ? 'hook' : testStep.pickleStep.text
    }

    runStepStartCh.publish({ resource })
    try {
      const promise = runStep.apply(this, arguments)

      promise.then((result) => {
        const { status, skipReason, errorMessage } = isLatestVersion
          ? getStatusFromResultLatest(result) : getStatusFromResult(result)

        runAsyncEndCh.publish({ isStep: true, status, skipReason, errorMessage })
      })
      return promise
    } catch (err) {
      errorCh.publish(err)
      throw err
    } finally {
      runStepEndCh.publish(undefined)
    }
  })
}

addHook({
  name: '@cucumber/cucumber',
  versions: ['7.0.0 - 7.2.1'],
  file: 'lib/runtime/pickle_runner.js'
}, (PickleRunner) => {
  const pl = PickleRunner.default

  wrapRun(pl, false)

  return PickleRunner
})

addHook({
  name: '@cucumber/cucumber',
  versions: ['>=7.3.0'],
  file: 'lib/runtime/test_case_runner.js'
}, (TestCaseRunner) => {
  const pl = TestCaseRunner.default

  wrapRun(pl, true)

  return TestCaseRunner
})
