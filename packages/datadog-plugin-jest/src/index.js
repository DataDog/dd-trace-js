const { promisify } = require('util')

const id = require('../../dd-trace/src/id')
const { SAMPLING_RULE_DECISION } = require('../../dd-trace/src/constants')
const { SAMPLING_PRIORITY, SPAN_TYPE, RESOURCE_NAME } = require('../../../ext/tags')
const { AUTO_KEEP } = require('../../../ext/priority')
const {
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  ERROR_MESSAGE,
  ERROR_TYPE,
  TEST_PARAMETERS,
  CI_APP_ORIGIN,
  getTestEnvironmentMetadata,
  getTestParametersString,
  finishAllTraceSpans
} = require('../../dd-trace/src/plugins/util/test')
const { getFormattedJestTestParameters } = require('./util')

function getVmContext (environment) {
  if (typeof environment.getVmContext === 'function') {
    return environment.getVmContext()
  }
  return null
}

function wrapEnvironment (BaseEnvironment) {
  return class DatadogJestEnvironment extends BaseEnvironment {
    constructor (config, context) {
      super(config, context)
      this.testSuite = context.testPath.replace(`${config.rootDir}/`, '')
      this.testSpansByTestName = {}
      this.originalTestFnByTestName = {}
    }
  }
}

function createWrapTeardown (tracer, instrumenter) {
  return function wrapTeardown (teardown) {
    return async function teardownWithTrace () {
      instrumenter.unwrap(this.global.test, 'each')
      nameToParams = {}
      await new Promise((resolve) => {
        tracer._exporter._writer.flush(resolve)
      })
      return teardown.apply(this, arguments)
    }
  }
}

let nameToParams = {}

const isTimeout = (event) => {
  return event.error &&
  typeof event.error === 'string' &&
  event.error.startsWith('Exceeded timeout')
}

function createHandleTestEvent (tracer, testEnvironmentMetadata, instrumenter) {
  return async function handleTestEventWithTrace (event) {
    if (event.name === 'test_retry') {
      let testName = event.test && event.test.name
      const context = getVmContext(this)
      if (context) {
        const { currentTestName } = context.expect.getState()
        testName = currentTestName
      }
      // If it's a retry, we restore the original test function so that it is not wrapped again
      if (this.originalTestFnByTestName[testName]) {
        event.test.fn = this.originalTestFnByTestName[testName]
      }
      return
    }
    if (event.name === 'test_fn_failure') {
      if (!isTimeout(event)) {
        return
      }
      const context = getVmContext(this)
      if (context) {
        const { currentTestName } = context.expect.getState()
        const testSpan = this.testSpansByTestName[`${currentTestName}_${event.test.invocations}`]
        if (testSpan) {
          testSpan.setTag(ERROR_TYPE, 'Timeout')
          testSpan.setTag(ERROR_MESSAGE, event.error)
          testSpan.setTag(TEST_STATUS, 'fail')
        }
      }
      return
    }
    if (event.name === 'setup') {
      instrumenter.wrap(this.global.test, 'each', function (original) {
        return function () {
          const testParameters = getFormattedJestTestParameters(arguments)
          const eachBind = original.apply(this, arguments)
          return function () {
            const [testName] = arguments
            nameToParams[testName] = testParameters
            return eachBind.apply(this, arguments)
          }
        }
      })
      return
    }

    if (event.name !== 'test_skip' &&
      event.name !== 'test_todo' &&
      event.name !== 'test_start' &&
      event.name !== 'hook_failure') {
      return
    }
    // for hook_failure events the test entry might not be defined, because the hook
    // is not necessarily associated to a test:
    if (!event.test) {
      return
    }

    const childOf = tracer.extract('text_map', {
      'x-datadog-trace-id': id().toString(10),
      'x-datadog-parent-id': '0000000000000000',
      'x-datadog-sampled': 1
    })
    let testName = event.test.name
    const context = getVmContext(this)

    if (context) {
      const { currentTestName } = context.expect.getState()
      testName = currentTestName
    }

    const commonSpanTags = {
      [TEST_TYPE]: 'test',
      [TEST_NAME]: testName,
      [TEST_SUITE]: this.testSuite,
      [SAMPLING_RULE_DECISION]: 1,
      [SAMPLING_PRIORITY]: AUTO_KEEP,
      ...testEnvironmentMetadata
    }

    const testParametersString = getTestParametersString(nameToParams, event.test.name)
    if (testParametersString) {
      commonSpanTags[TEST_PARAMETERS] = testParametersString
    }

    const resource = `${this.testSuite}.${testName}`
    if (event.name === 'test_skip' || event.name === 'test_todo') {
      const testSpan = tracer.startSpan(
        'jest.test',
        {
          childOf,
          tags: {
            ...commonSpanTags,
            [SPAN_TYPE]: 'test',
            [RESOURCE_NAME]: resource,
            [TEST_STATUS]: 'skip'
          }
        }
      )
      testSpan.context()._trace.origin = CI_APP_ORIGIN
      testSpan.finish()
      return
    }
    if (event.name === 'hook_failure') {
      const testSpan = tracer.startSpan(
        'jest.test',
        {
          childOf,
          tags: {
            ...commonSpanTags,
            [SPAN_TYPE]: 'test',
            [RESOURCE_NAME]: resource,
            [TEST_STATUS]: 'fail'
          }
        }
      )
      testSpan.context()._trace.origin = CI_APP_ORIGIN
      if (event.test.errors && event.test.errors.length) {
        const error = new Error(event.test.errors[0][0])
        error.stack = event.test.errors[0][1].stack
        testSpan.setTag('error', error)
      }
      testSpan.finish()
      return
    }
    // event.name === test_start at this point
    const environment = this
    environment.originalTestFnByTestName[testName] = event.test.fn

    let specFunction = event.test.fn
    if (specFunction.length) {
      specFunction = promisify(specFunction)
    }
    event.test.fn = tracer.wrap(
      'jest.test',
      { type: 'test',
        childOf,
        resource,
        tags: commonSpanTags
      },
      async () => {
        let result
        const testSpan = tracer.scope().active()
        environment.testSpansByTestName[`${testName}_${event.test.invocations}`] = testSpan
        testSpan.context()._trace.origin = CI_APP_ORIGIN
        try {
          result = await specFunction()
          // it may have been set already if the test timed out
          let suppressedErrors = []
          const context = getVmContext(environment)
          if (context) {
            suppressedErrors = context.expect.getState().suppressedErrors
          }
          if (suppressedErrors && suppressedErrors.length) {
            testSpan.setTag('error', suppressedErrors[0])
            testSpan.setTag(TEST_STATUS, 'fail')
          }
          if (!testSpan._spanContext._tags[TEST_STATUS]) {
            testSpan.setTag(TEST_STATUS, 'pass')
          }
        } catch (error) {
          testSpan.setTag(TEST_STATUS, 'fail')
          testSpan.setTag('error', error)
          throw error
        } finally {
          finishAllTraceSpans(testSpan)
        }
        return result
      }
    )
  }
}

module.exports = [
  {
    name: 'jest-environment-node',
    versions: ['>=24.8.0'],
    patch: function (NodeEnvironment, tracer) {
      const testEnvironmentMetadata = getTestEnvironmentMetadata('jest')

      this.wrap(NodeEnvironment.prototype, 'teardown', createWrapTeardown(tracer, this))

      const newHandleTestEvent = createHandleTestEvent(tracer, testEnvironmentMetadata, this)
      newHandleTestEvent._dd_original = NodeEnvironment.prototype.handleTestEvent
      NodeEnvironment.prototype.handleTestEvent = newHandleTestEvent

      return wrapEnvironment(NodeEnvironment)
    },
    unpatch: function (NodeEnvironment) {
      this.unwrap(NodeEnvironment.prototype, 'teardown')
      NodeEnvironment.prototype.handleTestEvent = NodeEnvironment.prototype.handleTestEvent._dd_original
    }
  },
  {
    name: 'jest-environment-jsdom',
    versions: ['>=24.8.0'],
    patch: function (JsdomEnvironment, tracer) {
      const testEnvironmentMetadata = getTestEnvironmentMetadata('jest')

      this.wrap(JsdomEnvironment.prototype, 'teardown', createWrapTeardown(tracer, this))

      const newHandleTestEvent = createHandleTestEvent(tracer, testEnvironmentMetadata, this)
      newHandleTestEvent._dd_original = JsdomEnvironment.prototype.handleTestEvent
      JsdomEnvironment.prototype.handleTestEvent = newHandleTestEvent

      return wrapEnvironment(JsdomEnvironment)
    },
    unpatch: function (JsdomEnvironment) {
      this.unwrap(JsdomEnvironment.prototype, 'teardown')
      JsdomEnvironment.prototype.handleTestEvent = JsdomEnvironment.prototype.handleTestEvent._dd_original
    }
  }
]
