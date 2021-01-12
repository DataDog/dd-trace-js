const { promisify } = require('util')

const id = require('../../dd-trace/src/id')
const { SAMPLING_RULE_DECISION } = require('../../dd-trace/src/constants')
const { SAMPLING_PRIORITY } = require('../../../ext/tags')
const { AUTO_KEEP } = require('../../../ext/priority')

const {
  getGitMetadata,
  GIT_COMMIT_SHA,
  GIT_BRANCH,
  GIT_REPOSITORY_URL
} = require('../../dd-trace/src/plugins/util/git')
const { getCIMetadata } = require('../../dd-trace/src/plugins/util/ci')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS
} = require('../../dd-trace/src/plugins/util/test')

const SPAN_TYPE = 'span.type'
const RESOURCE_NAME = 'resource.name'

function getTestMetadata () {
  // TODO: eventually these will come from the tracer (generally available)
  const ciMetadata = getCIMetadata()
  const {
    [GIT_COMMIT_SHA]: commitSHA,
    [GIT_BRANCH]: branch,
    [GIT_REPOSITORY_URL]: repositoryUrl
  } = ciMetadata

  const gitMetadata = getGitMetadata({ commitSHA, branch, repositoryUrl })

  return {
    [TEST_FRAMEWORK]: 'jest',
    ...gitMetadata,
    ...ciMetadata
  }
}

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

function createHandleTestEvent (tracer, testMetadata) {
  return async function handleTestEventWithTrace (event) {
    if (event.name !== 'test_skip' && event.name !== 'test_todo' && event.name !== 'test_start') {
      return
    }
    const childOf = tracer.extract('text_map', {
      'x-datadog-trace-id': id().toString(10),
      'x-datadog-parent-id': '0000000000000000',
      'x-datadog-sampled': 1
    })
    const { currentTestName } = this.context.expect.getState()
    const commonSpanTags = {
      [TEST_TYPE]: 'test',
      [TEST_NAME]: currentTestName,
      [TEST_SUITE]: this.testSuite,
      [SAMPLING_RULE_DECISION]: 1,
      [SAMPLING_PRIORITY]: AUTO_KEEP,
      ...testMetadata
    }
    const resource = `${this.testSuite}.${currentTestName}`
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
      const testMetadata = getTestMetadata()

      this.wrap(NodeEnvironment.prototype, 'teardown', createWrapTeardown(tracer))

      const newHandleTestEvent = createHandleTestEvent(tracer, testMetadata)
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
      const testMetadata = getTestMetadata()

      this.wrap(JsdomEnvironment.prototype, 'teardown', createWrapTeardown(tracer))

      const newHandleTestEvent = createHandleTestEvent(tracer, testMetadata)
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
