const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const runTestStartCh = channel('ci:mocha:run-test:start')
const errorCh = channel('ci:mocha:run-test:error')
const skipCh = channel('ci:mocha:run-test:skip')
const runTestEndCh = channel('ci:mocha:run-test:end')
const runTestEndAsyncCh = channel('ci:mocha:run-test:async-end')
const runTestsEndCh = channel('ci:mocha:run-tests:end')
const hookErrorCh = channel('ci:mocha:hook-error')
const mochaEachCh = channel('ci:mocha:mocha-each')

function isRetry (test) {
  return test._currentRetry !== undefined && test._currentRetry !== 0
}

addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/runner.js'
}, (Runner) => {
  shimmer.wrap(Runner.prototype, 'runTest', runTest => function () {
    if (!runTestStartCh.hasSubscribers) {
      return runTest.apply(this, arguments)
    }

    if (!isRetry(this.test)) {
      runTestStartCh.publish(this.test)
    }

    this.once('test end', AsyncResource.bind(() => {
      runTestEndAsyncCh.publish(this.test)
    }))

    this.once('fail', AsyncResource.bind((test, err) => {
      errorCh.publish(err)
    }))

    this.once('pending', AsyncResource.bind((test) => {
      skipCh.publish(test)
    }))

    try {
      return runTest.apply(this, arguments)
    } catch (err) {
      errorCh.publish(err)
      throw err
    } finally {
      runTestEndCh.publish(undefined)
    }
  })

  shimmer.wrap(Runner.prototype, 'runTests', runTests => function () {
    if (!runTestsEndCh.hasSubscribers) {
      return runTests.apply(this, arguments)
    }
    runTests.apply(this, arguments)
    const suite = arguments[0]
    runTestsEndCh.publish(suite)
  })

  shimmer.wrap(Runner.prototype, 'fail', fail => function (hook, error) {
    if (!hookErrorCh.hasSubscribers) {
      return fail.apply(this, arguments)
    }
    if (error && hook.ctx && hook.ctx.currentTest) {
      error.message = `${hook.title}: ${error.message}`
      hookErrorCh.publish({ test: hook.ctx.currentTest, error })
    }
    return fail.apply(this, arguments)
  })

  return Runner
})

addHook({
  name: 'mocha-each',
  versions: ['>=2.0.1']
}, (mochaEach) => {
  return shimmer.wrap(mochaEach, function () {
    const [params] = arguments
    const { it, ...rest } = mochaEach.apply(this, arguments)
    return {
      it: function (name) {
        mochaEachCh.publish({ name, params })
        it.apply(this, arguments)
      },
      ...rest
    }
  })
})
