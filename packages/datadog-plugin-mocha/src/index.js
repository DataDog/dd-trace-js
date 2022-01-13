const { promisify } = require('util')

const { SAMPLING_RULE_DECISION } = require('../../dd-trace/src/constants')
const { SAMPLING_PRIORITY, SPAN_TYPE, RESOURCE_NAME } = require('../../../ext/tags')
const { AUTO_KEEP } = require('../../../ext/priority')
const {
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  TEST_PARAMETERS,
  TEST_FRAMEWORK_VERSION,
  CI_APP_ORIGIN,
  getTestEnvironmentMetadata,
  getTestParametersString,
  finishAllTraceSpans,
  getTestParentSpan,
  getTestSuitePath
} = require('../../dd-trace/src/plugins/util/test')

function getTestSpanMetadata (tracer, test, sourceRoot) {
  const childOf = getTestParentSpan(tracer)

  const { file: testSuiteAbsolutePath } = test
  const fullTestName = test.fullTitle()
  const testSuite = getTestSuitePath(testSuiteAbsolutePath, sourceRoot)

  return {
    childOf,
    resource: `${testSuite}.${fullTestName}`,
    [TEST_TYPE]: 'test',
    [TEST_NAME]: fullTestName,
    [TEST_SUITE]: testSuite,
    [SAMPLING_RULE_DECISION]: 1,
    [SAMPLING_PRIORITY]: AUTO_KEEP,
    [TEST_FRAMEWORK_VERSION]: tracer._version
  }
}

function createWrapRunTest (tracer, testEnvironmentMetadata, sourceRoot) {
  return function wrapRunTest (runTest) {
    return async function runTestWithTrace () {
      // `runTest` is rerun when retries are configured through `this.retries` and the test fails.
      // This clause prevents rewrapping `this.test.fn` when it has already been wrapped.
      if (this.test._currentRetry !== undefined && this.test._currentRetry !== 0) {
        return runTest.apply(this, arguments)
      }

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
            // this.skip has been called
            if (error.constructor.name === 'Pending' && !this.forbidPending) {
              activeSpan.setTag(TEST_STATUS, 'skip')
            } else {
              activeSpan.setTag(TEST_STATUS, 'fail')
              activeSpan.setTag('error', error)
            }
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
      if (!this.__datadog_end_handled) {
        this.once('end', () => tracer._exporter._writer.flush())
        this.__datadog_end_handled = true
      }
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
              ...testEnvironmentMetadata,
              [TEST_STATUS]: 'skip'
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

function createWrapFail (tracer, testEnvironmentMetadata, sourceRoot) {
  return function wrapFail (fail) {
    return function failWithTrace (hook, err) {
      if (hook.type !== 'hook') {
        /**
         * This clause is to cover errors that are uncaught, such as:
         * it('will fail', done => {
         *   setTimeout(() => {
         *     // will throw but will not be caught by `runTestWithTrace`
         *     expect(true).to.equal(false)
         *     done()
         *   }, 100)
         * })
         */
        const testSpan = tracer.scope().active()
        if (!testSpan) {
          return fail.apply(this, arguments)
        }
        const {
          [TEST_NAME]: testName,
          [TEST_SUITE]: testSuite,
          [TEST_STATUS]: testStatus
        } = testSpan._spanContext._tags

        const isActiveSpanFailing = hook.fullTitle() === testName && hook.file.endsWith(testSuite)

        if (isActiveSpanFailing && !testStatus) {
          testSpan.setTag(TEST_STATUS, 'fail')
          testSpan.setTag('error', err)
          // need to manually finish, as it will not be caught in `runTestWithTrace`
          testSpan.finish()
        }
        return fail.apply(this, arguments)
      }
      if (err && hook.ctx && hook.ctx.currentTest) {
        err.message = `${hook.title}: ${err.message}`
        const {
          childOf,
          resource,
          ...testSpanMetadata
        } = getTestSpanMetadata(tracer, hook.ctx.currentTest, sourceRoot)
        const testSpan = tracer
          .startSpan('mocha.test', {
            childOf,
            tags: {
              [SPAN_TYPE]: 'test',
              [RESOURCE_NAME]: resource,
              ...testSpanMetadata,
              ...testEnvironmentMetadata,
              [TEST_STATUS]: 'fail'
            }
          })
        testSpan.setTag('error', err)
        testSpan.context()._trace.origin = CI_APP_ORIGIN
        testSpan.finish()
      }
      return fail.apply(this, arguments)
    }
  }
}

module.exports = [
  {
    name: 'mocha',
    versions: ['>=5.2.0'],
    file: 'lib/runner.js',
    patch (Runner, tracer, config) {
      const testEnvironmentMetadata = getTestEnvironmentMetadata('mocha', config)
      const sourceRoot = process.cwd()
      this.wrap(Runner.prototype, 'runTests', createWrapRunTests(tracer, testEnvironmentMetadata, sourceRoot))
      this.wrap(Runner.prototype, 'runTest', createWrapRunTest(tracer, testEnvironmentMetadata, sourceRoot))
      this.wrap(Runner.prototype, 'fail', createWrapFail(tracer, testEnvironmentMetadata, sourceRoot))
    },
    unpatch (Runner) {
      this.unwrap(Runner.prototype, 'runTests')
      this.unwrap(Runner.prototype, 'runTest')
      this.unwrap(Runner.prototype, 'fail')
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
