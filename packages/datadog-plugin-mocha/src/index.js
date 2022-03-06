'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')

const {
  CI_APP_ORIGIN,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_FRAMEWORK_VERSION,
  TEST_STATUS,
  TEST_PARAMETERS,
  finishAllTraceSpans,
  getTestEnvironmentMetadata,
  getTestSuitePath,
  getTestParentSpan,
  getTestParametersString
} = require('../../dd-trace/src/plugins/util/test')
const { SPAN_TYPE, RESOURCE_NAME, SAMPLING_PRIORITY } = require('../../../ext/tags')
const { SAMPLING_RULE_DECISION } = require('../../dd-trace/src/constants')

// is this needed in cucumber too???
const { AUTO_KEEP } = require('../../../ext/priority')

const skippedTests = new WeakSet()

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

class MochaPlugin extends Plugin {
  static get name () {
    return 'mocha'
  }

  constructor (...args) {
    super(...args)

    this._testNameToParams = {}

    this.addSub('ci:mocha:run-test:start', (test) => {
      const store = storage.getStore()
      const span = this.startTestSpan(test)

      this.enter(span, store)
    })

    this.addSub('ci:mocha:run-test:async-end', (test) => {
      // skipped test
      if (test.pending) {
        return
      }
      const span = storage.getStore().span

      if (test.state !== 'failed' && !test.timedOut) {
        span.setTag(TEST_STATUS, 'pass')
      } else {
        span.setTag(TEST_STATUS, 'fail')
      }

      span.finish()
      finishAllTraceSpans(span)
    })

    this.addSub('ci:mocha:run-test:end', () => {
      this.exit()
    })

    // programmatically skipped tests (that do go through `runTest`)
    this.addSub('ci:mocha:run-test:skip', () => {
      const span = storage.getStore().span
      span.setTag(TEST_STATUS, 'skip')
      span.finish()
    })

    this.addSub('ci:mocha:run-test:error', (err) => {
      if (err) {
        const span = storage.getStore().span
        if (err.constructor.name === 'Pending' && !this.forbidPending) {
          span.setTag(TEST_STATUS, 'skip')
        } else {
          span.setTag(TEST_STATUS, 'fail')
          span.setTag('error', err)
        }
      }
    })

    this.addSub('ci:mocha:run-tests:end', suite => {
      const tests = getAllTestsInSuite(suite)
      tests.forEach(test => {
        const { pending: isSkipped } = test
        // We call `getAllTestsInSuite` with the root suite so every skipped test
        // should already have an associated test span.
        // This function is called with every suite, so we need a way to mark
        // the test as already accounted for. We do this through `skippedTests`.
        // If the test is already marked as skipped, we don't create an additional test span.
        if (!isSkipped || skippedTests.has(test)) {
          return
        }
        skippedTests.add(test)

        const testSpan = this.startTestSpan(test)

        testSpan.setTag(TEST_STATUS, 'skip')
        testSpan.finish()
      })
    })

    this.addSub('ci:mocha:hook-error', ({ test, error }) => {
      const testSpan = this.startTestSpan(test)
      testSpan.setTag(TEST_STATUS, 'fail')
      testSpan.setTag('error', error)
      testSpan.finish()
    })

    this.addSub('ci:mocha:mocha-each', ({ name, params }) => {
      this._testNameToParams[name] = params
    })
  }

  startTestSpan (test) {
    const testEnvironmentMetadata = getTestEnvironmentMetadata('mocha', this.config)
    const sourceRoot = process.cwd()

    const { childOf, resource, ...testSpanMetadata } = getTestSpanMetadata(this.tracer, test, sourceRoot)

    const testParametersString = getTestParametersString(this._testNameToParams, test.title)
    if (testParametersString) {
      testSpanMetadata[TEST_PARAMETERS] = testParametersString
    }

    const testSpan = this.tracer
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

    return testSpan
  }
}

module.exports = MochaPlugin
