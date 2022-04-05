'use strict'

const { addHook, channel, AsyncResource } = require('./helpers/instrument')

const testStartCh = channel('ci:jest:test:start')
const testSkippedCh = channel('ci:jest:test:skip')
const testRunEndCh = channel('ci:jest:test:end')
const testErrCh = channel('ci:jest:test:err')
const testSuiteEnd = channel('ci:jest:test-suite:end')

const {
  getTestSuitePath
} = require('../../dd-trace/src/plugins/util/test')

function getWrappedEnvironment (NodeEnvironment) {
  return class DatadogEnvironment extends NodeEnvironment {
    constructor (config, context) {
      super(config, context)
      this.testSuite = getTestSuitePath(context.testPath, config.rootDir)
      this.ar = new AsyncResource('bound-anonymous-fn')
    }
    async teardown () {
      await super.teardown()
      testSuiteEnd.publish()
    }

    async handleTestEvent (event, state) {
      if (super.handleTestEvent) {
        await super.handleTestEvent(event, state)
      }
      this.ar.runInAsyncScope(() => {
        let context
        if (this.getVmContext) {
          context = this.getVmContext()
        } else {
          context = this.context
        }
        if (event.name === 'test_start') {
          testStartCh.publish({ name: context.expect.getState().currentTestName, suite: this.testSuite })
          this.originalTestFn = event.test.fn
          event.test.fn = this.ar.bind(event.test.fn)
        }
        if (event.name === 'test_done') {
          if (event.test.errors && event.test.errors.length) {
            testErrCh.publish(event.test.errors[0])
          }
          testRunEndCh.publish(undefined)
          // restore in case it is retried
          event.test.fn = this.originalTestFn
        }
        if (event.name === 'test_skip' || event.name === 'test_todo') {
          testSkippedCh.publish({ name: context.expect.getState().currentTestName, suite: this.testSuite })
        }
      })
    }
  }
}

addHook({
  name: 'jest-environment-node',
  versions: ['>=24.8.0']
}, (NodeEnvironment) => {
  return getWrappedEnvironment(NodeEnvironment)
})

addHook({
  name: 'jest-environment-jsdom',
  versions: ['>=24.8.0']
}, (JsdomEnvironment) => {
  return getWrappedEnvironment(JsdomEnvironment)
})
