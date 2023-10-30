'use strict'

const { storage } = require('../../datadog-core')
const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')

const {
  TEST_STATUS,
  finishAllTraceSpans,
  getTestSuitePath,
  getTestSuiteCommonTags,
  TEST_SOURCE_START
} = require('../../dd-trace/src/plugins/util/test')
const { RESOURCE_NAME } = require('../../../ext/tags')
const { COMPONENT } = require('../../dd-trace/src/constants')

class PlaywrightPlugin extends CiPlugin {
  static get id () {
    return 'playwright'
  }

  constructor (...args) {
    super(...args)

    this._testSuites = new Map()

    this.addSub('ci:playwright:session:finish', ({ status, onDone }) => {
      this.testModuleSpan.setTag(TEST_STATUS, status)
      this.testSessionSpan.setTag(TEST_STATUS, status)

      this.testModuleSpan.finish()
      this.testSessionSpan.finish()
      finishAllTraceSpans(this.testSessionSpan)
      this.tracer._exporter.flush(onDone)
    })

    this.addSub('ci:playwright:test-suite:start', (testSuiteAbsolutePath) => {
      const store = storage.getStore()
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.rootDir)

      const testSuiteMetadata = getTestSuiteCommonTags(
        this.command,
        this.frameworkVersion,
        testSuite,
        'playwright'
      )

      const testSuiteSpan = this.tracer.startSpan('playwright.test_suite', {
        childOf: this.testModuleSpan,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
      this.enter(testSuiteSpan, store)

      this._testSuites.set(testSuite, testSuiteSpan)
    })

    this.addSub('ci:playwright:test-suite:finish', (status) => {
      const store = storage.getStore()
      const span = store && store.span
      if (!span) return
      span.setTag(TEST_STATUS, status)
      span.finish()
    })

    this.addSub('ci:playwright:test:start', ({ testName, testSuiteAbsolutePath, testSourceLine }) => {
      const store = storage.getStore()
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.rootDir)
      const span = this.startTestSpan(testName, testSuite, testSourceLine)

      this.enter(span, store)
    })
    this.addSub('ci:playwright:test:finish', ({ testStatus, steps, error, extraTags }) => {
      const store = storage.getStore()
      const span = store && store.span
      if (!span) return

      span.setTag(TEST_STATUS, testStatus)

      if (error) {
        span.setTag('error', error)
      }
      if (extraTags) {
        span.addTags(extraTags)
      }

      steps.forEach(step => {
        const stepStartTime = step.startTime.getTime()
        const stepSpan = this.tracer.startSpan('playwright.step', {
          childOf: span,
          startTime: stepStartTime,
          tags: {
            [COMPONENT]: this.constructor.id,
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

  startTestSpan (testName, testSuite, testSourceLine) {
    const testSuiteSpan = this._testSuites.get(testSuite)
    return super.startTestSpan(testName, testSuite, testSuiteSpan, { [TEST_SOURCE_START]: testSourceLine })
  }
}

module.exports = PlaywrightPlugin
