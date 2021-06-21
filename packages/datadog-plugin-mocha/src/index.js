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
  TEST_PARAMETERS,
  CI_APP_ORIGIN,
  getTestEnvironmentMetadata,
  getTestParametersString,
  finishAllTraceSpans
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

      const testParametersString = getTestParametersString(nameToParams, this.test.title)
      if (testParametersString) {
        testSpanMetadata[TEST_PARAMETERS] = testParametersString
      }

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
          activeSpan.context()._trace.origin = CI_APP_ORIGIN
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
            activeSpan.setTag('error', error)
            throw error
          } finally {
            finishAllTraceSpans(activeSpan)
          }
          return result
        }
      )
      return runTest.apply(this, arguments)
    }
  }
}

function getAllTestsInSuite (root) {
  const tests = []
  function getTests (suiteOrTest) {
    suiteOrTest.tests.forEach(test => {
      tests.push(test)
    })
    suiteOrTest.suites.forEach(suite => {
      getTests(suite)
    })
  }
  getTests(root)
  return tests
}

// Necessary to get the skipped tests, that do not go through runTest
function createWrapRunTests (tracer, testEnvironmentMetadata, sourceRoot) {
  return function wrapRunTests (runTests) {
    return function runTestsWithTrace () {
      runTests.apply(this, arguments)
      const suite = arguments[0]
      const tests = getAllTestsInSuite(suite)
      tests.forEach(test => {
        const { pending: isSkipped } = test
        // We call `getAllTestsInSuite` with the root suite so every skipped test
        // should already have an associated test span.
        // This function is called with every suite, so we need a way to mark
        // the test as already accounted for. We do this through `__datadog_skipped`.
        // If the test is already marked as skipped, we don't create an additional test span.
        if (!isSkipped || test.__datadog_skipped) {
          return
        }
        test.__datadog_skipped = true
        const { childOf, resource, ...testSpanMetadata } = getTestSpanMetadata(tracer, test, sourceRoot)

        const testSpan = tracer
          .startSpan('mocha.test', {
            childOf,
            tags: {
              [SPAN_TYPE]: 'test',
              [RESOURCE_NAME]: resource,
              ...testSpanMetadata,
              ...testEnvironmentMetadata
            }
          })
        testSpan.context()._trace.origin = CI_APP_ORIGIN

        testSpan.finish()
      })
    }
  }
}

const nameToParams = {}

function wrapMochaEach (mochaEach) {
  return function mochaEachWithTrace () {
    const [params] = arguments
    const { it, ...rest } = mochaEach.apply(this, arguments)
    return {
      it: function (name) {
        nameToParams[name] = params
        it.apply(this, arguments)
      },
      ...rest
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
  },
  {
    name: 'mocha-each',
    versions: ['>=2.0.1'],
    patch (mochaEach) {
      return this.wrapExport(mochaEach, wrapMochaEach(mochaEach))
    },
    unpatch (mochaEach) {
      this.unwrapExport(mochaEach)
    }
  }
]
