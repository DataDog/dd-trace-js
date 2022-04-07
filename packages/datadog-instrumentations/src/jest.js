'use strict'

const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const testStartCh = channel('ci:jest:test:start')
const testSkippedCh = channel('ci:jest:test:skip')
const testRunEndCh = channel('ci:jest:test:end')
const testErrCh = channel('ci:jest:test:err')
const testSuiteEnd = channel('ci:jest:test-suite:end')

const {
  getTestSuitePath,
  getTestParametersString
} = require('../../dd-trace/src/plugins/util/test')

const { getFormattedJestTestParameters } = require('../../datadog-plugin-jest/src/util')

function getWrappedEnvironment (NodeEnvironment) {
  return class DatadogEnvironment extends NodeEnvironment {
    constructor (config, context) {
      super(config, context)
      this.testSuite = getTestSuitePath(context.testPath, config.rootDir)
      this.ar = new AsyncResource('bound-anonymous-fn')
      this.nameToParams = {}
    }
    async teardown () {
      super.teardown().finally(() => {
        testSuiteEnd.publish()
      })
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

        const setNameToParams = (name, params) => { this.nameToParams[name] = params }

        if (event.name === 'setup') {
          shimmer.wrap(this.global.test, 'each', each => function () {
            const testParameters = getFormattedJestTestParameters(arguments)
            const eachBind = each.apply(this, arguments)
            return function () {
              const [testName] = arguments
              setNameToParams(testName, testParameters)
              return eachBind.apply(this, arguments)
            }
          })
        }
        if (event.name === 'test_start') {
          const testParameters = getTestParametersString(this.nameToParams, event.test.name)

          testStartCh.publish({
            name: context.expect.getState().currentTestName,
            suite: this.testSuite,
            runner: 'jest-circus',
            testParameters
          })
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
          testSkippedCh.publish({
            name: context.expect.getState().currentTestName,
            suite: this.testSuite,
            runner: 'jest-circus'
          })
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

addHook({
  name: 'jest-jasmine2',
  versions: ['>=24.8.0'],
  file: 'build/jasmineAsyncInstall.js'
}, (jasmineAsyncInstallExport) => {
  return function (globalConfig, globalInput) {
    shimmer.wrap(globalInput.jasmine.Spec.prototype, 'execute', execute => function (onComplete) {
      const asyncResource = new AsyncResource('bound-anonymous-fn')

      asyncResource.runInAsyncScope(() => {
        const testSuite = getTestSuitePath(this.result.testPath, globalConfig.rootDir)
        testStartCh.publish({
          name: this.getFullName(),
          suite: testSuite,
          runner: 'jest-jasmine2'
        })
        const spec = this
        const callback = asyncResource.bind(function () {
          if (spec.result.failedExpectations && spec.result.failedExpectations.length) {
            testErrCh.publish(spec.result.failedExpectations[0].error)
          }
          testRunEndCh.publish(undefined)
          onComplete.apply(this, arguments)
        })
        arguments[0] = callback
        execute.apply(this, arguments)
      })
    })
    return jasmineAsyncInstallExport.default(globalConfig, globalInput)
  }
})
