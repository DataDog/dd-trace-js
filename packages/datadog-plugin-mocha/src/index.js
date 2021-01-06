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

function getCommonMetadata () {
  // TODO: eventually these will come from the tracer (generally available)
  const ciMetadata = getCIMetadata()
  const gitMetadata = getGitMetadata()

  return {
    [TEST_FRAMEWORK]: 'mocha',
    ...ciMetadata,
    ...gitMetadata
  }
}

function getTestSpanMetadata (tracer, test) {
  const childOf = tracer.extract('text_map', {
    'x-datadog-trace-id': id().toString(10),
    'x-datadog-parent-id': '0000000000000000',
    'x-datadog-sampled': 1
  })
  const { file: testSuite, title: testName } = test
  return {
    childOf,
    fullTitle: test.fullTitle(),
    [TEST_TYPE]: 'test',
    [TEST_NAME]: testName,
    [TEST_SUITE]: testSuite,
    [TEST_STATUS]: 'skip',
    [SAMPLING_RULE_DECISION]: 1,
    [SAMPLING_PRIORITY]: AUTO_KEEP
  }
}

function createWrapRunTest (tracer, commonMetadata) {
  return function wrapRunTest (runTest) {
    return async function runTestWithTrace () {
      let specFunction = this.test.fn
      if (specFunction.length) {
        specFunction = promisify(specFunction)
        // otherwise you have to explicitly call done()
        this.test.async = 0
        this.test.sync = true
      }

      const { childOf, fullTitle, ...testSpanMetadata } = getTestSpanMetadata(tracer, this.test)

      this.test.fn = tracer.wrap(
        'mocha.test',
        {
          type: 'test',
          childOf,
          resource: fullTitle,
          tags: {
            ...testSpanMetadata,
            ...commonMetadata
          }
        },
        async () => {
          const activeSpan = tracer.scope().active()
          let result
          try {
            result = await specFunction()
            activeSpan.setTag(TEST_STATUS, 'pass')
          } catch (error) {
            activeSpan.setTag(TEST_STATUS, 'fail')
            throw error
          } finally {
            activeSpan
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

// Necessary to get the skipped tests, that do not go through runTest
function createWrapRunTests (tracer, commonMetadata) {
  return function wrapRunTests (runTests) {
    return function runTestsWithTrace () {
      runTests.apply(this, arguments)
      this.suite.tests.forEach(test => {
        const { pending: isSkipped } = test
        if (!isSkipped) {
          return
        }
        const { childOf, fullTitle, ...testSpanMetadata } = getTestSpanMetadata(tracer, test)

        tracer
          .startSpan('mocha.test', {
            childOf,
            tags: {
              [SPAN_TYPE]: 'test',
              [RESOURCE_NAME]: fullTitle,
              ...testSpanMetadata,
              ...commonMetadata
            }
          })
          .finish()
      })
    }
  }
}

module.exports = [
  {
    name: 'mocha',
    versions: ['>=5.2.0'],
    file: 'lib/runner.js',
    patch (Runner, tracer) {
      const commonMetadata = getCommonMetadata()
      this.wrap(Runner.prototype, 'runTests', createWrapRunTests(tracer, commonMetadata))
      this.wrap(Runner.prototype, 'runTest', createWrapRunTest(tracer, commonMetadata))
    },
    unpatch (Runner) {
      this.unwrap(Runner.prototype, 'runTests')
      this.unwrap(Runner.prototype, 'runTest')
    }
  }
]
