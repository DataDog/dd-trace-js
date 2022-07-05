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
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      testToAr.set(test, asyncResource)
      asyncResource.runInAsyncScope(() => {
        testStartCh.publish(test)
      })
    })

    this.on('test end', (test) => {
      const asyncResource = testToAr.get(test)
      let status
      if (test.pending) {
        status = 'skip'
      } else if (test.state !== 'failed' && !test.timedOut) {
        status = 'pass'
      } else {
        status = 'fail'
      }

      if (!test.parent._afterEach.length) {
        asyncResource.runInAsyncScope(() => {
          testFinishCh.publish(status)
        })
      }
    })

    // if it passes, hook end will be run. Otherwise, 'fail'
    this.on('hook end', (hook) => {
      const test = hook.ctx.currentTest
      if (test && hook.parent._afterEach.includes(hook)) { // only if it's an afterEach
        const asyncResource = testToAr.get(test)
        asyncResource.runInAsyncScope(() => {
          testFinishCh.publish('pass')
        })
      }
    })

    this.on('fail', (testOrHook, err) => {
      let test = testOrHook
      const isHook = testOrHook.type === 'hook'
      if (isHook && testOrHook.ctx) {
        test = testOrHook.ctx.currentTest
      }
      const asyncResource = testToAr.get(test)
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
      const ar = testToAr.get(test)
      if (ar) {
        ar.runInAsyncScope(() => {
          skipCh.publish(test)
        })
      } else {
        // if there is no async resource, the test has been skipped through `test.skip``
        const asyncResource = new AsyncResource('bound-anonymous-fn')
        testToAr.set(test, asyncResource)
        asyncResource.runInAsyncScope(() => {
          skipCh.publish(test)
        })
      }
    })

    return run.apply(this, arguments)
  })

  shimmer.wrap(Runner.prototype, 'runTests', runTests => function () {
    if (!suiteFinishCh.hasSubscribers) {
      return runTests.apply(this, arguments)
    }
    this.once('end', AsyncResource.bind(() => {
      testRunFinishCh.publish()
    }))
    return runTests.apply(this, arguments)
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
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/runnable.js'
}, (Runnable) => {
  shimmer.wrap(Runnable.prototype, 'run', run => function () {
    let asyncResource
    if (this.fn.asyncResource) {
      const originalFn = originalFns.get(this)
      this.fn = originalFn
    }

    if (this.type === 'hook' && this.ctx.currentTest) {
      const test = this.ctx.currentTest
      asyncResource = testToAr.get(test)
    }
    if (this.type === 'test') {
      asyncResource = testToAr.get(this)
    }
    if (asyncResource && this.fn) {
      originalFns.set(this, this.fn)
      this.fn = asyncResource.bind(this.fn)
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
