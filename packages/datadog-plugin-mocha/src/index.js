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
  ERROR_STACK,
  ERROR_TYPE,
  getTestEnvironmentMetadata
} = require('../../dd-trace/src/plugins/util/test')

function getTestSpanMetadata (tracer, test, sourceRoot) {
  const childOf = tracer.extract('text_map', {
    'x-datadog-trace-id': id().toString(10),
    'x-datadog-parent-id': '0000000000000000',
    'x-datadog-sampled': 1
  })
  const { file: testSuite } = test
  const fullTestName = test.fullTitle()
  const strippedTestSuite = testSuite ? testSuite.replace(`${sourceRoot}/`, '') : ''

  return {
    childOf,
    resource: `${strippedTestSuite}.${fullTestName}`,
    [TEST_TYPE]: 'test',
    [TEST_NAME]: fullTestName,
    [TEST_SUITE]: strippedTestSuite,
    [TEST_STATUS]: 'skip',
    [SAMPLING_RULE_DECISION]: 1,
    [SAMPLING_PRIORITY]: AUTO_KEEP
  }
}

function createWrapRunTest (tracer, testEnvironmentMetadata, sourceRoot) {
  return function wrapRunTest (runTest) {
    return async function runTestWithTrace () {
      let specFunction = this.test.fn
      if (specFunction.length) {
        specFunction = promisify(specFunction)
        // otherwise you have to explicitly call done()
        this.test.async = 0
        this.test.sync = true
      }

      const { childOf, resource, ...testSpanMetadata } = getTestSpanMetadata(tracer, this.test, sourceRoot)

      this.test.fn = tracer.wrap(
        'mocha.test',
        {
          type: 'test',
          childOf,
          resource,
          tags: {
            ...testSpanMetadata,
            ...testEnvironmentMetadata
          }
        },
        async () => {
          const activeSpan = tracer.scope().active()
          let result
          try {
            const context = this.test.ctx
            result = await specFunction.call(context)
            if (context.test.state !== 'failed' && !context.test.timedOut) {
              activeSpan.setTag(TEST_STATUS, 'pass')
            } else {
              activeSpan.setTag(TEST_STATUS, 'fail')
            }
          } catch (error) {
            activeSpan.setTag(TEST_STATUS, 'fail')
            activeSpan.setTag(ERROR_TYPE, error.constructor ? error.constructor.name : error.name)
            activeSpan.setTag(ERROR_MESSAGE, error.message)
            activeSpan.setTag(ERROR_STACK, error.stack)
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
function createWrapRunTests (tracer, testEnvironmentMetadata, sourceRoot) {
  return function wrapRunTests (runTests) {
    return function runTestsWithTrace () {
      runTests.apply(this, arguments)
      this.suite.tests.forEach(test => {
        const { pending: isSkipped } = test
        if (!isSkipped) {
          return
        }
        const { childOf, resource, ...testSpanMetadata } = getTestSpanMetadata(tracer, test, sourceRoot)

        tracer
          .startSpan('mocha.test', {
            childOf,
            tags: {
              [SPAN_TYPE]: 'test',
              [RESOURCE_NAME]: resource,
              ...testSpanMetadata,
              ...testEnvironmentMetadata
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
      const testEnvironmentMetadata = getTestEnvironmentMetadata('mocha')
      const sourceRoot = process.cwd()
      this.wrap(Runner.prototype, 'runTests', createWrapRunTests(tracer, testEnvironmentMetadata, sourceRoot))
      this.wrap(Runner.prototype, 'runTest', createWrapRunTest(tracer, testEnvironmentMetadata, sourceRoot))
    },
    unpatch (Runner) {
      this.unwrap(Runner.prototype, 'runTests')
      this.unwrap(Runner.prototype, 'runTest')
    }
  }
]
