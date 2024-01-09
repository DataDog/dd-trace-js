'use strict'

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

const {
  TEST_STATUS,
  TEST_PARAMETERS,
  finishAllTraceSpans,
  getTestSuitePath,
  getTestParametersString,
  getTestSuiteCommonTags,
  addIntelligentTestRunnerSpanTags,
  TEST_SOURCE_START,
  TEST_ITR_UNSKIPPABLE,
  TEST_ITR_FORCED_RUN,
  TEST_CODE_OWNERS
} = require('../../dd-trace/src/plugins/util/test')
const { COMPONENT } = require('../../dd-trace/src/constants')
const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED,
  TELEMETRY_CODE_COVERAGE_STARTED,
  TELEMETRY_CODE_COVERAGE_FINISHED,
  TELEMETRY_ITR_FORCED_TO_RUN,
  TELEMETRY_CODE_COVERAGE_EMPTY,
  TELEMETRY_ITR_UNSKIPPABLE,
  TELEMETRY_CODE_COVERAGE_NUM_FILES
} = require('../../dd-trace/src/ci-visibility/telemetry')

class MochaPlugin extends CiPlugin {
  static get id () {
    return 'mocha'
  }

  constructor (...args) {
    super(...args)

    this._testSuites = new Map()
    this._testNameToParams = {}
    this.sourceRoot = process.cwd()

    this.addSub('ci:mocha:test-suite:code-coverage', ({ coverageFiles, suiteFile }) => {
      if (!this.itrConfig || !this.itrConfig.isCodeCoverageEnabled) {
        return
      }
      const testSuiteSpan = this._testSuites.get(suiteFile)

      if (!coverageFiles.length) {
        this.telemetry.count(TELEMETRY_CODE_COVERAGE_EMPTY)
      }

      const relativeCoverageFiles = [...coverageFiles, suiteFile]
        .map(filename => getTestSuitePath(filename, this.sourceRoot))

      const { _traceId, _spanId } = testSuiteSpan.context()

      const formattedCoverage = {
        sessionId: _traceId,
        suiteId: _spanId,
        files: relativeCoverageFiles
      }

      this.tracer._exporter.exportCoverage(formattedCoverage)
      this.telemetry.ciVisEvent(TELEMETRY_CODE_COVERAGE_FINISHED, 'suite', { library: 'istanbul' })
      this.telemetry.distribution(TELEMETRY_CODE_COVERAGE_NUM_FILES, {}, relativeCoverageFiles.length)
    })

    this.addSub('ci:mocha:test-suite:start', ({ testSuite, isUnskippable, isForcedToRun }) => {
      const store = storage.getStore()
      const testSuiteMetadata = getTestSuiteCommonTags(
        this.command,
        this.frameworkVersion,
        getTestSuitePath(testSuite, this.sourceRoot),
        'mocha'
      )
      if (isUnskippable) {
        testSuiteMetadata[TEST_ITR_UNSKIPPABLE] = 'true'
        this.telemetry.count(TELEMETRY_ITR_UNSKIPPABLE, { testLevel: 'suite' })
      }
      if (isForcedToRun) {
        testSuiteMetadata[TEST_ITR_FORCED_RUN] = 'true'
        this.telemetry.count(TELEMETRY_ITR_FORCED_TO_RUN, { testLevel: 'suite' })
      }

      const testSuiteSpan = this.tracer.startSpan('mocha.test_suite', {
        childOf: this.testModuleSpan,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      if (this.itrConfig?.isCodeCoverageEnabled) {
        this.telemetry.ciVisEvent(TELEMETRY_CODE_COVERAGE_STARTED, 'suite', { library: 'istanbul' })
      }
      this.enter(testSuiteSpan, store)
      this._testSuites.set(testSuite, testSuiteSpan)
    })

    this.addSub('ci:mocha:test-suite:finish', (status) => {
      const store = storage.getStore()
      if (store && store.span) {
        const span = store.span
        // the test status of the suite may have been set in ci:mocha:test-suite:error already
        if (!span.context()._tags[TEST_STATUS]) {
          span.setTag(TEST_STATUS, status)
        }
        span.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
      }
    })

    this.addSub('ci:mocha:test-suite:error', (err) => {
      const store = storage.getStore()
      if (store && store.span) {
        const span = store.span
        span.setTag('error', err)
        span.setTag(TEST_STATUS, 'fail')
      }
    })

    this.addSub('ci:mocha:test:start', ({ test, testStartLine }) => {
      const store = storage.getStore()
      const span = this.startTestSpan(test, testStartLine)

      this.enter(span, store)
    })

    this.addSub('ci:mocha:test:finish', (status) => {
      const store = storage.getStore()

      if (store && store.span) {
        const span = store.span

        span.setTag(TEST_STATUS, status)

        span.finish()
        this.telemetry.ciVisEvent(
          TELEMETRY_EVENT_FINISHED,
          'test',
          { hasCodeOwners: !!span.context()._tags[TEST_CODE_OWNERS] }
        )
        finishAllTraceSpans(span)
      }
    })

    this.addSub('ci:mocha:test:skip', (test) => {
      const store = storage.getStore()
      // skipped through it.skip, so the span is not created yet
      // for this test
      if (!store) {
        const testSpan = this.startTestSpan(test)
        this.enter(testSpan, store)
      }
    })

    this.addSub('ci:mocha:test:error', (err) => {
      const store = storage.getStore()
      if (err && store && store.span) {
        const span = store.span
        if (err.constructor.name === 'Pending' && !this.forbidPending) {
          span.setTag(TEST_STATUS, 'skip')
        } else {
          span.setTag(TEST_STATUS, 'fail')
          span.setTag('error', err)
        }
      }
    })

    this.addSub('ci:mocha:test:parameterize', ({ name, params }) => {
      this._testNameToParams[name] = params
    })

    this.addSub('ci:mocha:session:finish', ({
      status,
      isSuitesSkipped,
      testCodeCoverageLinesTotal,
      numSkippedSuites,
      hasForcedToRunSuites,
      hasUnskippableSuites,
      error
    }) => {
      if (this.testSessionSpan) {
        const { isSuitesSkippingEnabled, isCodeCoverageEnabled } = this.itrConfig || {}
        this.testSessionSpan.setTag(TEST_STATUS, status)
        this.testModuleSpan.setTag(TEST_STATUS, status)

        if (error) {
          this.testSessionSpan.setTag('error', error)
          this.testModuleSpan.setTag('error', error)
        }

        addIntelligentTestRunnerSpanTags(
          this.testSessionSpan,
          this.testModuleSpan,
          {
            isSuitesSkipped,
            isSuitesSkippingEnabled,
            isCodeCoverageEnabled,
            testCodeCoverageLinesTotal,
            skippingCount: numSkippedSuites,
            skippingType: 'suite',
            hasForcedToRunSuites,
            hasUnskippableSuites
          }
        )

        this.testModuleSpan.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
        this.testSessionSpan.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
        finishAllTraceSpans(this.testSessionSpan)
      }
      this.itrConfig = null
      this.tracer._exporter.flush()
    })
  }

  startTestSpan (test, testStartLine) {
    const testName = test.fullTitle()
    const { file: testSuiteAbsolutePath, title } = test

    const extraTags = {}
    const testParametersString = getTestParametersString(this._testNameToParams, title)
    if (testParametersString) {
      extraTags[TEST_PARAMETERS] = testParametersString
    }

    if (testStartLine) {
      extraTags[TEST_SOURCE_START] = testStartLine
    }

    const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.sourceRoot)
    const testSuiteSpan = this._testSuites.get(testSuiteAbsolutePath)

    return super.startTestSpan(testName, testSuite, testSuiteSpan, extraTags)
  }
}

module.exports = MochaPlugin
