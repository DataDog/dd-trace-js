'use strict'

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')
const { getValueFromEnvSources } = require('../../dd-trace/src/config/helper')

const {
  finishAllTraceSpans,
  getTestSuitePath,
  getTestSuiteCommonTags,
  TEST_STATUS,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
} = require('../../dd-trace/src/plugins/util/test')
const { COMPONENT } = require('../../dd-trace/src/constants')
const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED,
  TELEMETRY_TEST_SESSION,
} = require('../../dd-trace/src/ci-visibility/telemetry')

class NodeTestPlugin extends CiPlugin {
  static id = 'node-test'

  constructor (...args) {
    super(...args)

    this.sourceRoot = process.cwd()

    this.addBind('ci:node-test:test-suite:start', (ctx) => {
      const { testSuiteAbsolutePath } = ctx

      if (!this.testModuleSpan) {
        return
      }

      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.sourceRoot)
      const testSuiteMetadata = getTestSuiteCommonTags(
        this.command,
        this.frameworkVersion,
        testSuite,
        this.constructor.id
      )
      testSuiteMetadata[TEST_SOURCE_FILE] = this.repositoryRoot !== this.sourceRoot && !!this.repositoryRoot
        ? getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
        : testSuite

      const testSuiteSpan = this.tracer.startSpan('node_test.test_suite', {
        childOf: this.testModuleSpan,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata,
        },
        integrationName: this.constructor.id,
      })

      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      this._testSuiteSpansByTestSuite = this._testSuiteSpansByTestSuite || new Map()
      this._testSuiteSpansByTestSuite.set(testSuite, testSuiteSpan)

      const store = storage('legacy').getStore()
      ctx.parentStore = store
      ctx.currentStore = { ...store, testSuiteSpan }
    })

    this.addSub('ci:node-test:test-suite:finish', ({ status, testSuiteAbsolutePath }) => {
      if (!this._testSuiteSpansByTestSuite) return

      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.sourceRoot)
      const testSuiteSpan = this._testSuiteSpansByTestSuite.get(testSuite)

      if (testSuiteSpan) {
        testSuiteSpan.setTag(TEST_STATUS, status)
        testSuiteSpan.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
        this._testSuiteSpansByTestSuite.delete(testSuite)
      }
    })

    this._testSpansByKey = new Map()

    this.addBind('ci:node-test:test:start', (ctx) => {
      const store = storage('legacy').getStore()
      const span = this.startTestSpan(ctx)

      ctx.parentStore = store
      ctx.currentStore = { ...store, span }

      this.activeTestSpan = span
      if (ctx._testKey) {
        this._testSpansByKey.set(ctx._testKey, span)
      }
      return ctx.currentStore
    })

    this.addSub('ci:node-test:test:finish', ({ status, isStep, _testKey }) => {
      const span = _testKey ? this._testSpansByKey.get(_testKey) : this.activeTestSpan
      if (_testKey) {
        this._testSpansByKey.delete(_testKey)
      }

      if (span) {
        span.setTag(TEST_STATUS, status)

        this.telemetry.ciVisEvent(
          TELEMETRY_EVENT_FINISHED,
          isStep ? 'step' : 'test',
          this.getTestTelemetryTags(span)
        )

        span.finish()
        finishAllTraceSpans(span)
        this.activeTestSpan = null
      }
    })

    this.addSub('ci:node-test:session:finish', ({ status, error }) => {
      if (this.testSessionSpan) {
        this.testSessionSpan.setTag(TEST_STATUS, status)
        this.testModuleSpan.setTag(TEST_STATUS, status)

        if (error) {
          this.testSessionSpan.setTag('error', error)
          this.testModuleSpan.setTag('error', error)
        }

        this.testModuleSpan.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
        this.testSessionSpan.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
        finishAllTraceSpans(this.testSessionSpan)
        this.telemetry.count(TELEMETRY_TEST_SESSION, {
          provider: this.ciProviderName,
          autoInjected: !!getValueFromEnvSources('DD_CIVISIBILITY_AUTO_INSTRUMENTATION_PROVIDER'),
        })
      }
      this.tracer._exporter.flush()
    })
  }

  startTestSpan (testInfo) {
    const {
      testName,
      testSuiteAbsolutePath,
      testStartLine,
      isStep,
    } = testInfo

    const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.sourceRoot)
    const testSuiteSpan = this._testSuiteSpansByTestSuite?.get(testSuite)

    const extraTags = {}
    if (testStartLine) {
      extraTags[TEST_SOURCE_START] = testStartLine
    }
    extraTags[TEST_SOURCE_FILE] = this.repositoryRoot !== this.sourceRoot && !!this.repositoryRoot
      ? getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      : testSuite

    if (isStep) {
      const parentSpan = this.activeTestSpan || testSuiteSpan
      return this.tracer.startSpan('node_test.test_step', {
        childOf: parentSpan,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...getTestSuiteCommonTags(this.command, this.frameworkVersion, testSuite, this.constructor.id),
          ...extraTags,
        },
        integrationName: this.constructor.id,
      })
    }

    return super.startTestSpan(testName, testSuite, testSuiteSpan, extraTags)
  }
}

module.exports = NodeTestPlugin
