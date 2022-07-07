const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const testStartCh = channel('ci:mocha:test:start')
const errorCh = channel('ci:mocha:test:error')
const skipCh = channel('ci:mocha:test:skip')
const testFinishCh = channel('ci:mocha:test:finish')
const parameterizedTestCh = channel('ci:mocha:test:parameterize')
const testRunFinishCh = channel('ci:mocha:run:finish')

function isRetry (test) {
  return test._currentRetry !== undefined && test._currentRetry !== 0
}

function getTestAsyncResource (test) {
  if (!test.fn) {
    return testToAr.get(test)
  }
  if (!test.fn.asyncResource) {
    return testToAr.get(test.fn)
  }
  const originalFn = originalFns.get(test.fn)
  return testToAr.get(originalFn)
}

// TODO: remove when root hooks and fixtures are implemented
const patched = new WeakSet()

const testToAr = new WeakMap()
const originalFns = new WeakMap()

function mochaHook (Runner) {
  if (patched.has(Runner)) return Runner

  patched.add(Runner)

  shimmer.wrap(Runner.prototype, 'run', run => function () {
    if (!testStartCh.hasSubscribers) {
      return run.apply(this, arguments)
    }

    this.on('test', (test) => {
      if (isRetry(test)) {
        return
      }
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      testToAr.set(test.fn, asyncResource)
      asyncResource.runInAsyncScope(() => {
        testStartCh.publish(test)
      })
    })

    this.on('test end', (test) => {
      const asyncResource = getTestAsyncResource(test)
      let status
      if (test.pending) {
        status = 'skip'
      } else if (test.state !== 'failed' && !test.timedOut) {
        status = 'pass'
      } else {
        status = 'fail'
      }

      // if there are afterEach to be run, we don't finish the test yet
      if (!test.parent._afterEach.length) {
        asyncResource.runInAsyncScope(() => {
          testFinishCh.publish(status)
        })
      }
    })

    // If the hook passes, 'hook end' will be emitted. Otherwise, 'fail' will be emitted
    this.on('hook end', (hook) => {
      const test = hook.ctx.currentTest
      if (test && hook.parent._afterEach.includes(hook)) { // only if it's an afterEach
        const isLastAfterEach = hook.parent._afterEach.indexOf(hook) === hook.parent._afterEach.length - 1
        if (isLastAfterEach) {
          const asyncResource = getTestAsyncResource(test)
          asyncResource.runInAsyncScope(() => {
            testFinishCh.publish('pass')
          })
        }
      }
    })

    this.on('fail', (testOrHook, err) => {
      let test = testOrHook
      const isHook = testOrHook.type === 'hook'
      if (isHook && testOrHook.ctx) {
        test = testOrHook.ctx.currentTest
      }
      const asyncResource = getTestAsyncResource(test)
      if (asyncResource) {
        asyncResource.runInAsyncScope(() => {
          if (isHook) {
            err.message = `${testOrHook.title}: ${err.message}`
            errorCh.publish(err)
            // if it's a hook and it has failed, 'test end' will not be called
            testFinishCh.publish('fail')
          } else {
            errorCh.publish(err)
          }
        })
      }
    })

    this.on('pending', (test) => {
      const asyncResource = getTestAsyncResource(test)
      if (asyncResource) {
        asyncResource.runInAsyncScope(() => {
          skipCh.publish(test)
        })
      } else {
        // if there is no async resource, the test has been skipped through `test.skip``
        const skippedTestAsyncResource = new AsyncResource('bound-anonymous-fn')
        testToAr.set(test, skippedTestAsyncResource)
        skippedTestAsyncResource.runInAsyncScope(() => {
          skipCh.publish(test)
        })
      }
    })

    return run.apply(this, arguments)
  })

  shimmer.wrap(Runner.prototype, 'runTests', runTests => function () {
    if (!testRunFinishCh.hasSubscribers) {
      return runTests.apply(this, arguments)
    }
    this.once('end', AsyncResource.bind(() => {
      testRunFinishCh.publish()
    }))
    return runTests.apply(this, arguments)
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
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/runnable.js'
}, (Runnable) => {
  shimmer.wrap(Runnable.prototype, 'run', run => function () {
    const isBeforeEach = this.parent._beforeEach.includes(this)
    const isAfterEach = this.parent._afterEach.includes(this)

    const isTestHook = isBeforeEach || isAfterEach

    // we restore the original user defined function
    if (this.fn.asyncResource) {
      const originalFn = originalFns.get(this.fn)
      this.fn = originalFn
    }

    if (isTestHook || this.type === 'test') {
      const test = isTestHook ? this.ctx.currentTest : this
      const asyncResource = getTestAsyncResource(test)

      // we bind the test fn to the correct async resource
      const newFn = asyncResource.bind(this.fn)

      // we store the original function, not to lose it
      originalFns.set(newFn, this.fn)

      this.fn = newFn
    }

    return run.apply(this, arguments)
  })
  return Runnable
})

addHook({
  name: 'mocha-each',
  versions: ['>=2.0.1']
}, mochaEachHook)

module.exports = { mochaHook, mochaEachHook }
