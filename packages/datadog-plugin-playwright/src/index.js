'use strict'

const { storage } = require('../../datadog-core')
const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')

const {
  TEST_STATUS,
  finishAllTraceSpans,
  getTestParentSpan,
  getTestSessionCommonTags,
  getTestSuitePath,
  COMPONENT,
  TEST_SESSION_ID,
  TEST_COMMAND,
  TEST_SUITE_ID,
  getTestSuiteCommonTags
} = require('../../dd-trace/src/plugins/util/test')
const { RESOURCE_NAME } = require('../../../ext/tags')

class PlaywrightPlugin extends CiPlugin {
  static get name () {
    return 'playwright'
  }

  constructor (...args) {
    super(...args)

    this._testSuites = new Map()

    this.addSub('ci:playwright:session:start', ({ command, frameworkVersion, rootDir }) => {
      const childOf = getTestParentSpan(this.tracer)
      this.command = command
      this.frameworkVersion = frameworkVersion
      this.rootDir = rootDir

      const testSessionSpanMetadata = getTestSessionCommonTags(command, frameworkVersion)
      this.testSessionSpan = this.tracer.startSpan('playwright.test_session', {
        childOf,
        tags: {
          [COMPONENT]: this.constructor.name,
          ...this.testEnvironmentMetadata,
          ...testSessionSpanMetadata
        }
      })
    })

    this.addSub('ci:playwright:session:finish', ({ status, onDone }) => {
      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testSessionSpan.finish()
      finishAllTraceSpans(this.testSessionSpan)
      this.tracer._exporter.flush(onDone)
    })

    this.addSub('ci:playwright:test-suite:start', (testSuite) => {
      const store = storage.getStore()
      const testSuiteMetadata = getTestSuiteCommonTags(
        this.command,
        this.frameworkVersion,
        getTestSuitePath(testSuite, this.rootDir)
      )

      const testSuiteSpan = this.tracer.startSpan('playwright.test_suite', {
        childOf: this.testSessionSpan,
        tags: {
          [COMPONENT]: this.constructor.name,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
      this.enter(testSuiteSpan, store)

      this._testSuites.set(testSuite, testSuiteSpan)
    })

    this.addSub('ci:playwright:test-suite:finish', (status) => {
      const span = storage.getStore().span
      span.setTag(TEST_STATUS, status)
      span.finish()
    })

    this.addSub('ci:playwright:test:start', (test) => {
      const store = storage.getStore()
      const span = this.startTestSpan(test)

      this.enter(span, store)
    })
    this.addSub('ci:playwright:test:finish', ({ testStatus, steps, error }) => {
      const span = storage.getStore().span

      span.setTag(TEST_STATUS, testStatus)

      if (error) {
        span.setTag('error', error)
      }

      steps.forEach(step => {
        const stepStartTime = step.startTime.getTime()
        const stepSpan = this.tracer.startSpan('playwright.step', {
          childOf: span,
          startTime: stepStartTime,
          tags: {
            [COMPONENT]: this.constructor.name,
            'playwright.step': step.title,
            [RESOURCE_NAME]: step.title
          }
        })
        if (step.error) {
          stepSpan.setTag('error', step.error)
        }
        stepSpan.finish(stepStartTime + step.duration)
      })

      span.finish()
      finishAllTraceSpans(span)
    })
  }

  startTestSpan (test) {
    const { title: testName, location: { file } } = test
    const testSuite = getTestSuitePath(file, this.rootDir)

    const testSuiteTags = {}

    const testSuiteSpan = this._testSuites.get(file)
    if (testSuiteSpan) {
      const testSuiteId = testSuiteSpan.context()._spanId.toString(10)
      testSuiteTags[TEST_SUITE_ID] = testSuiteId
    }

    if (this.testSessionSpan) {
      const testSessionId = this.testSessionSpan.context()._traceId.toString(10)
      testSuiteTags[TEST_SESSION_ID] = testSessionId
      testSuiteTags[TEST_COMMAND] = this.command
    }

    return super.startTestSpan(testName, testSuite, testSuiteTags)
  }
}

module.exports = PlaywrightPlugin
