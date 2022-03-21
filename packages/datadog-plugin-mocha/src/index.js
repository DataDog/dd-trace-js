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
const { AUTO_KEEP } = require('../../../ext/priority')

const skippedTests = new WeakSet()

function getTestSpanMetadata (tracer, test, sourceRoot) {
  const childOf = getTestParentSpan(tracer)

  const { file: testSuiteAbsolutePath } = test
  const fullTestName = test.fullTitle()
  const testSuite = getTestSuitePath(testSuiteAbsolutePath, sourceRoot)

  return {
    childOf,
    [SPAN_TYPE]: 'test',
    [TEST_TYPE]: 'test',
    [TEST_NAME]: fullTestName,
    [TEST_SUITE]: testSuite,
    [SAMPLING_RULE_DECISION]: 1,
    [SAMPLING_PRIORITY]: AUTO_KEEP,
    [TEST_FRAMEWORK_VERSION]: tracer._version,
    [RESOURCE_NAME]: `${testSuite}.${fullTestName}`
  }
}

class MochaPlugin extends Plugin {
  static get name () {
    return 'mocha'
  }

  constructor (...args) {
    super(...args)

    this._testNameToParams = {}
    this.testEnvironmentMetadata = getTestEnvironmentMetadata('mocha', this.config)
    this.sourceRoot = process.cwd()

    this.addSub('ci:mocha:test:start', (test) => {
      const store = storage.getStore()
      const span = this.startTestSpan(test)

      this.enter(span, store)
    })

    this.addSub('ci:mocha:test:async-end', (status) => {
      // if the status is skipped the span has already been finished
      if (status === 'skipped') {
        return
      }
      const span = storage.getStore().span

      span.setTag(TEST_STATUS, status)

      span.finish()
      finishAllTraceSpans(span)
    })

    this.addSub('ci:mocha:test:end', () => {
      this.exit()
    })

    // This covers programmatically skipped tests (that do go through `runTest`)
    this.addSub('ci:mocha:test:skip', () => {
      const span = storage.getStore().span
      span.setTag(TEST_STATUS, 'skip')
      span.finish()
    })

    this.addSub('ci:mocha:test:error', (err) => {
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

    this.addSub('ci:mocha:suite:end', tests => {
      tests.forEach(test => {
        const { pending: isSkipped } = test
        // `tests` includes every test, so we need a way to mark
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

    this.addSub('ci:mocha:hook:error', ({ test, error }) => {
      const testSpan = this.startTestSpan(test)
      testSpan.setTag(TEST_STATUS, 'fail')
      testSpan.setTag('error', error)
      testSpan.finish()
    })

    this.addSub('ci:mocha:test:parameterize', ({ name, params }) => {
      this._testNameToParams[name] = params
    })

    this.addSub('ci:mocha:run:end', () => {
      this.tracer._exporter._writer.flush()
    })
  }

  startTestSpan (test) {
    const { childOf, ...testSpanMetadata } = getTestSpanMetadata(this.tracer, test, this.sourceRoot)

    const testParametersString = getTestParametersString(this._testNameToParams, test.title)
    if (testParametersString) {
      testSpanMetadata[TEST_PARAMETERS] = testParametersString
    }

    const testSpan = this.tracer
      .startSpan('mocha.test', {
        childOf,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSpanMetadata
        }
      })
    testSpan.context()._trace.origin = CI_APP_ORIGIN

    return testSpan
  }
}

module.exports = MochaPlugin
