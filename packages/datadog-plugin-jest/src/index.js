const { promisify } = require('util')
const shimmer = require('shimmer')

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
  ERROR_STACK,
  ERROR_TYPE,
  TEST_PARAMETERS,
  getTestEnvironmentMetadata
} = require('../../dd-trace/src/plugins/util/test')

function wrapEnvironment (BaseEnvironment) {
  return class DatadogJestEnvironment extends BaseEnvironment {
    constructor (config, context) {
      super(config, context)
      this.testSuite = context.testPath.replace(`${config.rootDir}/`, '')
    }
  }
}

function createWrapTeardown (tracer) {
  return function wrapTeardown (teardown) {
    return async function teardownWithTrace () {
      await new Promise((resolve) => {
        tracer._exporter._writer.flush(resolve)
      })
      return teardown.apply(this, arguments)
    }
  }
}

let params = {}

function createHandleTestEvent (tracer, testEnvironmentMetadata) {
  return async function handleTestEventWithTrace (event) {
    if (event.name === 'start_describe_definition') {
      params = {}
      shimmer.wrap(this.global.test, 'each', function (original) {
        return function () {
          const [parameters] = arguments
          const test = original.apply(this, arguments)
          return function () {
            const [testName] = arguments
            params[testName] = parameters
            return test.apply(this, arguments)
          }
        }
      })
    }

    if (event.name !== 'test_skip' && event.name !== 'test_todo' && event.name !== 'test_start') {
      return
    }
    const childOf = tracer.extract('text_map', {
      'x-datadog-trace-id': id().toString(10),
      'x-datadog-parent-id': '0000000000000000',
      'x-datadog-sampled': 1
    })
    let testName = event.test.name
    const context = this.getVmContext()
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
    let testParameters = params[event.test.name]
    if (testParameters) {
      testParameters = testParameters.shift()
      commonSpanTags[TEST_PARAMETERS] = JSON.stringify(testParameters)
    }
    const resource = `${this.testSuite}.${testName}`
    if (event.name === 'test_skip' || event.name === 'test_todo') {
      tracer.startSpan(
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
      ).finish()
      return
    }
    // event.name === test_start at this point
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
        try {
          result = await specFunction()
          tracer.scope().active().setTag(TEST_STATUS, 'pass')
        } catch (error) {
          tracer.scope().active().setTag(TEST_STATUS, 'fail')
          tracer.scope().active().setTag(ERROR_TYPE, error.constructor ? error.constructor.name : error.name)
          tracer.scope().active().setTag(ERROR_MESSAGE, error.message)
          tracer.scope().active().setTag(ERROR_STACK, error.stack)
          throw error
        } finally {
          tracer
            .scope()
            .active()
            .context()._trace.started.forEach((span) => {
              span.finish()
            })
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

      this.wrap(NodeEnvironment.prototype, 'teardown', createWrapTeardown(tracer))

      const newHandleTestEvent = createHandleTestEvent(tracer, testEnvironmentMetadata)
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

      this.wrap(JsdomEnvironment.prototype, 'teardown', createWrapTeardown(tracer))

      const newHandleTestEvent = createHandleTestEvent(tracer, testEnvironmentMetadata)
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
