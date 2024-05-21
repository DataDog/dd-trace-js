const { addHook, channel, AsyncResource } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const { testToStartLine } = require('./common')
const { isMochaRetry, getTestStatus } = require('./utils')

const testToAr = new WeakMap()
const originalFns = new WeakMap()

const testStartCh = channel('ci:mocha:test:start')
const testFinishCh = channel('ci:mocha:test:finish')
const errorCh = channel('ci:mocha:test:error')
const skipCh = channel('ci:mocha:test:skip')
const workerFinishCh = channel('ci:mocha:worker:finish')

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

// Runner is also hooked in mocha/main.js, but in here we only generate test events.
addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/runner.js'
}, function (Runner) {
  shimmer.wrap(Runner.prototype, 'run', run => function () {
    // use this chance to flush
    this.on('end', () => {
      workerFinishCh.publish()
    })
    this.on('test', (test) => {
      if (isMochaRetry(test)) {
        return
      }
      const testStartLine = testToStartLine.get(test)
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      testToAr.set(test.fn, asyncResource)

      const {
        file: testSuiteAbsolutePath,
        title
      } = test

      const testInfo = {
        testName: test.fullTitle(),
        testSuiteAbsolutePath,
        title,
        testStartLine,
        isParallel: true
      }

      asyncResource.runInAsyncScope(() => {
        testStartCh.publish(testInfo)
      })
    })

    this.on('test end', (test) => {
      const asyncResource = getTestAsyncResource(test)
      const status = getTestStatus(test)

      // if there are afterEach to be run, we don't finish the test yet
      if (asyncResource && !test.parent._afterEach.length) {
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
          const status = getTestStatus(test)
          const asyncResource = getTestAsyncResource(test)
          asyncResource.runInAsyncScope(() => {
            testFinishCh.publish(status)
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
      let testAsyncResource
      if (test) {
        testAsyncResource = getTestAsyncResource(test)
      }
      if (testAsyncResource) {
        testAsyncResource.runInAsyncScope(() => {
          if (isHook) {
            err.message = `${testOrHook.fullTitle()}: ${err.message}`
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
      const testStartLine = testToStartLine.get(test)
      const {
        file: testSuiteAbsolutePath,
        title
      } = test

      const testInfo = {
        testName: test.fullTitle(),
        testSuiteAbsolutePath,
        title,
        testStartLine
      }

      const asyncResource = getTestAsyncResource(test)
      if (asyncResource) {
        asyncResource.runInAsyncScope(() => {
          skipCh.publish(testInfo)
        })
      } else {
        // if there is no async resource, the test has been skipped through `test.skip`
        // or the parent suite is skipped
        const skippedTestAsyncResource = new AsyncResource('bound-anonymous-fn')
        if (test.fn) {
          testToAr.set(test.fn, skippedTestAsyncResource)
        } else {
          testToAr.set(test, skippedTestAsyncResource)
        }
        skippedTestAsyncResource.runInAsyncScope(() => {
          skipCh.publish(testInfo)
        })
      }
    })

    return run.apply(this, arguments)
  })
  return Runner
})

// This hook also appears in mocha/main.js
// Hook to bind the test function to the correct async resource
addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/runnable.js'
}, (Runnable) => {
  shimmer.wrap(Runnable.prototype, 'run', run => function () {
    if (!testStartCh.hasSubscribers) {
      return run.apply(this, arguments)
    }
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

      if (asyncResource) {
        // we bind the test fn to the correct async resource
        const newFn = asyncResource.bind(this.fn)

        // we store the original function, not to lose it
        originalFns.set(newFn, this.fn)
        this.fn = newFn

        // Temporarily keep functionality when .asyncResource is removed from node
        // in https://github.com/nodejs/node/pull/46432
        if (!this.fn.asyncResource) {
          this.fn.asyncResource = asyncResource
        }
      }
    }

    return run.apply(this, arguments)
  })
  return Runnable
})
