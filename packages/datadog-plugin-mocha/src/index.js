const { promisify } = require('util')

const id = require('../../dd-trace/src/id')
const { SAMPLING_RULE_DECISION } = require('../../dd-trace/src/constants')
const { SAMPLING_PRIORITY } = require('../../../ext/tags')
const { AUTO_KEEP } = require('../../../ext/priority')
const { getGitMetadata } = require('../../dd-trace/src/plugins/util/git')
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
  const gitMetadata = getGitMetadata()

  return {
    [TEST_FRAMEWORK]: 'mocha',
    ...ciMetadata,
    ...gitMetadata
  }
}

function createWrapRunTest (tracer, testMetadata) {
  return function wrapRunTest (runTest) {
    return async function runTestWithTrace () {
      const childOf = tracer.extract('text_map', {
        'x-datadog-trace-id': id().toString(10),
        'x-datadog-parent-id': '0000000000000000',
        'x-datadog-sampled': 1
      })
      const { pending: isSkipped, file: testSuite, title: testName } = this.test
      if (isSkipped) {
        tracer
          .startSpan('mocha.test', {
            childOf,
            tags: {
              [SPAN_TYPE]: 'test',
              [RESOURCE_NAME]: test.fullTitle(),
              [TEST_TYPE]: 'test',
              [TEST_NAME]: testName,
              [TEST_SUITE]: testSuite,
              [TEST_STATUS]: 'skip',
              [SAMPLING_RULE_DECISION]: 1,
              [SAMPLING_PRIORITY]: AUTO_KEEP,
              ...testMetadata
            }
          })
          .finish()
        return
      }
      let specFunction = this.test.fn

      if (specFunction.length) {
        specFunction = promisify(specFunction)
        // otherwise you have to explicitly call done()
        this.test.async = 0
        this.test.sync = true
      }

      this.test.fn = tracer.wrap(
        'mocha.test',
        {
          type: 'test',
          childOf,
          resource: this.test.fullTitle(),
          tags: {
            [TEST_TYPE]: 'test',
            [TEST_NAME]: testName,
            [TEST_SUITE]: testSuite,
            [SAMPLING_RULE_DECISION]: 1,
            [SAMPLING_PRIORITY]: AUTO_KEEP,
            ...testMetadata
          }
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
              .context()
              ._trace.started.forEach((span) => {
                span.finish()
              })
          }
          return result
        }
      )
      return runTest.apply(this, arguments)
    }
  }
}

module.exports = [
  {
    name: 'mocha',
    versions: ['8.2.1'],
    file: 'lib/runner.js',
    patch (Runner, tracer) {
      const testMetadata = getTestMetadata()
      this.wrap(Runner.prototype, 'runTest', createWrapRunTest(tracer, testMetadata))
    },
    unpatch (Runner) {
      this.unwrap(Runner.prototype, 'runTest')
    }
  }
]
