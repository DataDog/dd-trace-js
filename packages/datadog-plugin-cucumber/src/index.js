'use strict'

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

const {
  TEST_SKIP_REASON,
  TEST_STATUS,
  finishAllTraceSpans,
  getTestSuitePath,
  getTestParentSpan,
  getTestSessionCommonTags,
  getTestModuleCommonTags,
  getTestSuiteCommonTags,
  TEST_SUITE_ID,
  TEST_MODULE_ID,
  TEST_SESSION_ID,
  TEST_COMMAND,
  TEST_BUNDLE
} = require('../../dd-trace/src/plugins/util/test')
const { RESOURCE_NAME } = require('../../../ext/tags')
const { COMPONENT, ERROR_MESSAGE } = require('../../dd-trace/src/constants')

class CucumberPlugin extends CiPlugin {
  static get name () {
    return 'cucumber'
  }

  constructor (...args) {
    super(...args)

    this.sourceRoot = process.cwd()

    this.addSub('ci:cucumber:session:start', ({ command, frameworkVersion }) => {
      const childOf = getTestParentSpan(this.tracer)
      const testSessionSpanMetadata = getTestSessionCommonTags(command, frameworkVersion)

      this.command = command
      this.frameworkVersion = frameworkVersion
      this.testSessionSpan = this.tracer.startSpan('cucumber.test_session', {
        childOf,
        tags: {
          [COMPONENT]: this.constructor.name,
          ...this.testEnvironmentMetadata,
          ...testSessionSpanMetadata
        }
      })

      const testModuleSpanMetadata = getTestModuleCommonTags(command, frameworkVersion)
      this.testModuleSpan = this.tracer.startSpan('cucumber.test_module', {
        childOf: this.testSessionSpan,
        tags: {
          [COMPONENT]: this.constructor.name,
          ...this.testEnvironmentMetadata,
          ...testModuleSpanMetadata
        }
      })
    })

    this.addSub('ci:cucumber:session:finish', (status) => {
      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.finish()
      this.testSessionSpan.finish()
      finishAllTraceSpans(this.testSessionSpan)
      this.tracer._exporter.flush()
    })

    this.addSub('ci:cucumber:test-suite:start', (testSuiteFullPath) => {
      const testSuiteMetadata = getTestSuiteCommonTags(
        this.command,
        this.frameworkVersion,
        getTestSuitePath(testSuiteFullPath, this.sourceRoot)
      )
      this.testSuiteSpan = this.tracer.startSpan('cucumber.test_suite', {
        childOf: this.testModuleSpan,
        tags: {
          [COMPONENT]: this.constructor.name,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
    })

    this.addSub('ci:cucumber:test-suite:finish', status => {
      this.testSuiteSpan.setTag(TEST_STATUS, status)
      this.testSuiteSpan.finish()
    })

    this.addSub('ci:cucumber:test:start', ({ testName, fullTestSuite }) => {
      const store = storage.getStore()
      const testSuite = getTestSuitePath(fullTestSuite, this.sourceRoot)
      const testSpan = this.startTestSpan(testName, testSuite)

      this.enter(testSpan, store)
    })

    this.addSub('ci:cucumber:test-step:start', ({ resource }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('cucumber.step', {
        childOf,
        tags: {
          [COMPONENT]: this.constructor.name,
          'cucumber.step': resource,
          [RESOURCE_NAME]: resource
        }
      })
      this.enter(span, store)
    })

    this.addSub('ci:cucumber:test:finish', ({ isStep, status, skipReason, errorMessage }) => {
      const span = storage.getStore().span
      const statusTag = isStep ? 'step.status' : TEST_STATUS

      span.setTag(statusTag, status)

      if (skipReason) {
        span.setTag(TEST_SKIP_REASON, skipReason)
      }

      if (errorMessage) {
        span.setTag(ERROR_MESSAGE, errorMessage)
      }

      span.finish()
      if (!isStep) {
        finishAllTraceSpans(span)
      }
    })

    this.addSub('ci:cucumber:error', (err) => {
      if (err) {
        const span = storage.getStore().span
        span.setTag('error', err)
      }
    })
  }

  startTestSpan (testName, testSuite) {
    const childOf = getTestParentSpan(this.tracer)
    // This is a hack to get good time resolution on test events, while keeping
    // the test event as the root span of its trace.
    childOf._trace.startTime = this.testSessionSpan.context()._trace.startTime
    childOf._trace.ticks = this.testSessionSpan.context()._trace.ticks

    const testSuiteTags = {}
    const testSuiteId = this.testSuiteSpan.context().toSpanId()
    testSuiteTags[TEST_SUITE_ID] = testSuiteId

    const testSessionId = this.testSessionSpan.context().toTraceId()
    testSuiteTags[TEST_SESSION_ID] = testSessionId
    testSuiteTags[TEST_COMMAND] = this.command

    const testModuleId = this.testModuleSpan.context().toSpanId()
    testSuiteTags[TEST_MODULE_ID] = testModuleId
    testSuiteTags[TEST_COMMAND] = this.command
    testSuiteTags[TEST_BUNDLE] = this.command

    return super.startTestSpan(testName, testSuite, testSuiteTags, childOf)
  }
}

module.exports = CucumberPlugin
