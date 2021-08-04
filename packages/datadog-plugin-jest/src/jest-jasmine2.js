const { promisify } = require('util')

const { RESOURCE_NAME } = require('../../../ext/tags')
const {
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  CI_APP_ORIGIN,
  getTestEnvironmentMetadata,
  finishAllTraceSpans
} = require('../../dd-trace/src/plugins/util/test')
const { getTestSpanTags, setSuppressedErrors } = require('./util')

function createWrapIt (tracer, globalConfig, globalInput, testEnvironmentMetadata) {
  return function wrapIt (it) {
    return function itWithTrace (description, specFunction, timeout) {
      let oldSpecFunction = specFunction
      if (specFunction.length) {
        oldSpecFunction = promisify(oldSpecFunction)
      }

      const { childOf, commonSpanTags } = getTestSpanTags(tracer, testEnvironmentMetadata)

      const testSuite = globalInput.jasmine.testPath.replace(`${globalConfig.rootDir}/`, '')

      const newSpecFunction = tracer.wrap(
        'jest.test',
        {
          type: 'test',
          childOf,
          tags: { ...commonSpanTags, [TEST_SUITE]: testSuite }
        },
        async (done) => {
          const testSpan = tracer.scope().active()
          const { currentTestName } = globalInput.expect.getState()
          const resource = `${testSuite}.${currentTestName}`
          testSpan.setTag(TEST_NAME, currentTestName)
          testSpan.setTag(RESOURCE_NAME, resource)
          testSpan.context()._trace.origin = CI_APP_ORIGIN
          let result
          globalInput.jasmine.testSpanByTestName[currentTestName] = testSpan

          try {
            result = await oldSpecFunction()
            const suppressedErrors = globalInput.expect.getState().suppressedErrors
            setSuppressedErrors(suppressedErrors, testSpan)
            if (!testSpan._spanContext._tags[TEST_STATUS]) {
              testSpan.setTag(TEST_STATUS, 'pass')
            }
          } catch (error) {
            testSpan.setTag(TEST_STATUS, 'fail')
            testSpan.setTag('error', error)
            if (done) {
              done(error)
            }
            throw error
          } finally {
            finishAllTraceSpans(testSpan)
          }
          if (done) {
            done(result)
          }
        }
      )
      return it(description, newSpecFunction, timeout)
    }
  }
}

function createWrapOnException (tracer, globalInput) {
  return function wrapOnException (onException) {
    return function onExceptionWithTrace (err) {
      let activeTestSpan = tracer.scope().active()
      if (!activeTestSpan) {
        activeTestSpan = globalInput.jasmine.testSpanByTestName[this.getFullName()]
      }
      if (!activeTestSpan) {
        return onException.apply(this, arguments)
      }
      const {
        [TEST_NAME]: testName,
        [TEST_SUITE]: testSuite,
        [TEST_STATUS]: testStatus
      } = activeTestSpan._spanContext._tags

      const isActiveSpanFailing = this.getFullName() === testName &&
        this.result.testPath.endsWith(testSuite)

      if (isActiveSpanFailing && !testStatus) {
        activeTestSpan.setTag(TEST_STATUS, 'fail')
        // If we don't do this, jest will show this file on its error message
        const stackFrames = err.stack.split('\n')
        const filteredStackFrames = stackFrames.filter(frame => !frame.includes(__dirname)).join('\n')
        err.stack = filteredStackFrames
        activeTestSpan.setTag('error', err)
        // need to manually finish, as it will not be caught in `itWithTrace`
        activeTestSpan.finish()
      }

      return onException.apply(this, arguments)
    }
  }
}

function createWrapItSkip (tracer, globalConfig, globalInput, testEnvironmentMetadata) {
  return function wrapItSkip (it) {
    return function itSkipWithTrace () {
      const { childOf, commonSpanTags } = getTestSpanTags(tracer, testEnvironmentMetadata)

      const testSuite = globalInput.jasmine.testPath.replace(`${globalConfig.rootDir}/`, '')

      const spec = it.apply(this, arguments)

      const testName = spec.getFullName()
      const resource = `${testSuite}.${testName}`

      const testSpan = tracer.startSpan(
        'jest.test',
        {
          childOf,
          tags: {
            ...commonSpanTags,
            [RESOURCE_NAME]: resource,
            [TEST_NAME]: testName,
            [TEST_SUITE]: testSuite,
            [TEST_STATUS]: 'skip'
          }
        }
      )
      testSpan.context()._trace.origin = CI_APP_ORIGIN
      testSpan.finish()

      return spec
    }
  }
}

function createWrapJasmineAsyncInstall (tracer, instrumenter, testEnvironmentMetadata) {
  return function jasmineAsyncInstallWithTrace (jasmineAsyncInstall) {
    return function (globalConfig, globalInput) {
      globalInput.jasmine.testSpanByTestName = {}
      instrumenter.wrap(globalInput.jasmine.Spec.prototype, 'onException', createWrapOnException(tracer, globalInput))
      instrumenter.wrap(globalInput, 'it', createWrapIt(tracer, globalConfig, globalInput, testEnvironmentMetadata))
      // instruments 'it.only'
      instrumenter.wrap(globalInput, 'fit', createWrapIt(tracer, globalConfig, globalInput, testEnvironmentMetadata))
      // instruments 'it.skip'
      instrumenter.wrap(
        globalInput,
        'xit',
        createWrapItSkip(tracer, globalConfig, globalInput, testEnvironmentMetadata)
      )
      return jasmineAsyncInstall(globalConfig, globalInput)
    }
  }
}

module.exports = [
  {
    name: 'jest-jasmine2',
    versions: ['>=24.8.0'],
    file: 'build/jasmineAsyncInstall.js',
    patch: function (jasmineAsyncInstallExport, tracer) {
      const testEnvironmentMetadata = getTestEnvironmentMetadata('jest')
      return this.wrapExport(
        jasmineAsyncInstallExport.default,
        createWrapJasmineAsyncInstall(tracer, this, testEnvironmentMetadata)(jasmineAsyncInstallExport.default)
      )
    },
    unpatch: function (jasmineAsyncInstallExport) {
      this.unwrapExport(jasmineAsyncInstallExport.default)
    }
  }
]
