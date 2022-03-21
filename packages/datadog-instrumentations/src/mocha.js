const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const testStartCh = channel('ci:mocha:test:start')
const errorCh = channel('ci:mocha:test:error')
const skipCh = channel('ci:mocha:test:skip')
const testEndCh = channel('ci:mocha:test:end')
const testAsyncEndCh = channel('ci:mocha:test:async-end')
const suiteEndCh = channel('ci:mocha:suite:end')
const hookErrorCh = channel('ci:mocha:hook:error')
const parameterizedTestCh = channel('ci:mocha:test:parameterize')
const testRunEndCh = channel('ci:mocha:run:end')

function isRetry (test) {
  return test._currentRetry !== undefined && test._currentRetry !== 0
}

function getAllTestsInSuite (root) {
  const tests = []
  function getTests (suiteOrTest) {
    suiteOrTest.tests.forEach(test => {
      tests.push(test)
    })
    suiteOrTest.suites.forEach(suite => {
      getTests(suite)
    })
  }
  getTests(root)
  return tests
}

addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/runner.js'
}, (Runner) => {
  shimmer.wrap(Runner.prototype, 'runTest', runTest => function () {
    if (!testStartCh.hasSubscribers) {
      return runTest.apply(this, arguments)
    }

    if (!isRetry(this.test)) {
      testStartCh.publish(this.test)
    }

    this.once('test end', AsyncResource.bind(() => {
      let status

      if (this.test.pending) {
        status = 'skipped'
      } else if (this.test.state !== 'failed' && !this.test.timedOut) {
        status = 'pass'
      } else {
        status = 'fail'
      }

      testAsyncEndCh.publish(status)
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
      testEndCh.publish(undefined)
    }
  })

  shimmer.wrap(Runner.prototype, 'runTests', runTests => function () {
    if (!suiteEndCh.hasSubscribers) {
      return runTests.apply(this, arguments)
    }
    this.once('end', AsyncResource.bind(() => {
      testRunEndCh.publish(undefined)
    }))
    runTests.apply(this, arguments)
    const suite = arguments[0]
    // We call `getAllTestsInSuite` with the root suite so every skipped test
    // should already have an associated test span.
    const tests = getAllTestsInSuite(suite)
    suiteEndCh.publish(tests)
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
        parameterizedTestCh.publish({ name, params })
        it.apply(this, arguments)
      },
      ...rest
    }
  })
})
