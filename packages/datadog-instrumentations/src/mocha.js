const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const testStartCh = channel('ci:mocha:test:start')
const errorCh = channel('ci:mocha:test:error')
const skipCh = channel('ci:mocha:test:skip')
const testFinishCh = channel('ci:mocha:test:finish')
const suiteFinishCh = channel('ci:mocha:suite:finish')
const hookErrorCh = channel('ci:mocha:hook:error')
const parameterizedTestCh = channel('ci:mocha:test:parameterize')
const testRunFinishCh = channel('ci:mocha:run:finish')

// TODO: remove when root hooks and fixtures are implemented
const patched = new WeakSet()

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

function mochaHook (Runner) {
  if (patched.has(Runner)) return Runner

  patched.add(Runner)

  shimmer.wrap(Runner.prototype, 'runTest', runTest => function () {
    if (!testStartCh.hasSubscribers || isRetry(this.test)) {
      return runTest.apply(this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      testStartCh.publish(this.test)

      this.once('test end', AsyncResource.bind(() => {
        let status

        if (this.test.pending) {
          status = 'skipped'
        } else if (this.test.state !== 'failed' && !this.test.timedOut) {
          status = 'pass'
        } else {
          status = 'fail'
        }

        testFinishCh.publish(status)
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
      }
    })
  })

  shimmer.wrap(Runner.prototype, 'runTests', runTests => function () {
    if (!suiteFinishCh.hasSubscribers) {
      return runTests.apply(this, arguments)
    }
    this.once('end', AsyncResource.bind(() => {
      testRunFinishCh.publish()
    }))
    runTests.apply(this, arguments)
    const suite = arguments[0]
    // We call `getAllTestsInSuite` with the root suite so every skipped test
    // should already have an associated test span.
    const tests = getAllTestsInSuite(suite)
    suiteFinishCh.publish(tests)
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
}

function mochaEachHook (mochaEach) {
  if (patched.has(mochaEach)) return mochaEach

  patched.add(mochaEach)

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
}

addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/runner.js'
}, mochaHook)

addHook({
  name: 'mocha-each',
  versions: ['>=2.0.1']
}, mochaEachHook)

module.exports = { mochaHook, mochaEachHook }
