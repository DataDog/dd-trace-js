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

const specStatusToTestStatus = {
  'pending': 'skip',
  'disabled': 'skip',
  'todo': 'skip',
  'passed': 'pass',
  'failed': 'fail'
}

const asyncResources = new WeakMap()
const originalTestFns = new WeakMap()

// based on https://github.com/facebook/jest/blob/main/packages/jest-circus/src/formatNodeAssertErrors.ts#L41
function formatJestError (errors) {
  let error
  if (Array.isArray(errors)) {
    const [originalError, asyncError] = errors
    if (originalError === null || !originalError.stack) {
      error = asyncError
      error.message = originalError
    } else {
      error = originalError
    }
  } else {
    error = errors
  }
  return error
}

function getWrappedEnvironment (BaseEnvironment) {
  return class DatadogEnvironment extends BaseEnvironment {
    constructor (config, context) {
      super(config, context)
      const rootDir = config.globalConfig ? config.globalConfig.rootDir : config.rootDir
      this.testSuite = getTestSuitePath(context.testPath, rootDir)
      this.nameToParams = {}
      this.global._ddtrace = global._ddtrace
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

      const globalExpect = this.global.expect
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

        // Async resource for this test is created here
        // It is used later on by the test_done handler
        const asyncResource = new AsyncResource('bound-anonymous-fn')
        asyncResources.set(event.test, asyncResource)
        asyncResource.runInAsyncScope(() => {
          testStartCh.publish({
            name: globalExpect.getState().currentTestName,
            suite: this.testSuite,
            runner: 'jest-circus',
            testParameters
          })
          originalTestFns.set(event.test, event.test.fn)
          event.test.fn = asyncResource.bind(event.test.fn)
        })
      }
      if (event.name === 'test_done') {
        const asyncResource = asyncResources.get(event.test)
        asyncResource.runInAsyncScope(() => {
          let status = 'pass'
          if (event.test.errors && event.test.errors.length) {
            status = 'fail'
            const formattedError = formatJestError(event.test.errors[0])
            testErrCh.publish(formattedError)
          }
          testRunEndCh.publish(status)
          // restore in case it is retried
          event.test.fn = originalTestFns.get(event.test)
        })
      }
      if (event.name === 'test_skip' || event.name === 'test_todo') {
        testSkippedCh.publish({
          name: globalExpect.getState().currentTestName,
          suite: this.testSuite,
          runner: 'jest-circus'
        })
      }
    }
  }
}

function getTestEnvironment (pkg) {
  if (pkg.default) {
    const wrappedTestEnvironment = getWrappedEnvironment(pkg.default)
    pkg.default = wrappedTestEnvironment
    pkg.TestEnvironment = wrappedTestEnvironment
    return pkg
  }
  return getWrappedEnvironment(pkg)
}

addHook({
  name: 'jest-environment-node',
  versions: ['>=24.8.0']
}, getTestEnvironment)

addHook({
  name: 'jest-environment-jsdom',
  versions: ['>=24.8.0']
}, getTestEnvironment)

addHook({
  name: 'jest-jasmine2',
  versions: ['>=24.8.0'],
  file: 'build/jasmineAsyncInstall.js'
}, (jasmineAsyncInstallExport) => {
  return function (globalConfig, globalInput) {
    globalInput._ddtrace = global._ddtrace
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
            const formattedError = formatJestError(spec.result.failedExpectations[0].error)
            testErrCh.publish(formattedError)
          }
          testRunEndCh.publish(specStatusToTestStatus[spec.result.status])
          onComplete.apply(this, arguments)
        })
        arguments[0] = callback
        execute.apply(this, arguments)
      })
    })
    return jasmineAsyncInstallExport.default(globalConfig, globalInput)
  }
})
