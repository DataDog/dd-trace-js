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
  TEST_CODE_OWNERS,
  ITR_CORRELATION_ID,
  TEST_SOURCE_FILE,
  removeEfdStringFromTestName,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_SESSION_ID,
  TEST_MODULE_ID,
  TEST_MODULE,
  TEST_SUITE_ID,
  TEST_COMMAND,
  TEST_SUITE,
  MOCHA_IS_PARALLEL
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
const id = require('../../dd-trace/src/id')
const log = require('../../dd-trace/src/log')

function getTestSuiteLevelVisibilityTags (testSuiteSpan) {
  const testSuiteSpanContext = testSuiteSpan.context()
  const suiteTags = {
    [TEST_SUITE_ID]: testSuiteSpanContext.toSpanId(),
    [TEST_SESSION_ID]: testSuiteSpanContext.toTraceId(),
    [TEST_COMMAND]: testSuiteSpanContext._tags[TEST_COMMAND],
    [TEST_MODULE]: 'mocha'
  }
  if (testSuiteSpanContext._parentId) {
    suiteTags[TEST_MODULE_ID] = testSuiteSpanContext._parentId.toString(10)
  }
  return suiteTags
}

class MochaPlugin extends CiPlugin {
  static get id () {
    return 'mocha'
  }

  constructor (...args) {
    super(...args)

    this._testSuites = new Map()
    this._testTitleToParams = {}
    this.sourceRoot = process.cwd()

    this.addSub('ci:mocha:test-suite:code-coverage', ({ coverageFiles, suiteFile }) => {
      if (!this.libraryConfig?.isCodeCoverageEnabled) {
        return
      }
      const testSuite = getTestSuitePath(suiteFile, this.sourceRoot)
      const testSuiteSpan = this._testSuites.get(testSuite)

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

    this.addSub('ci:mocha:test-suite:start', ({
      testSuiteAbsolutePath,
      isUnskippable,
      isForcedToRun,
      itrCorrelationId
    }) => {
      // If the test module span is undefined, the plugin has not been initialized correctly and we bail out
      if (!this.testModuleSpan) {
        return
      }
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.sourceRoot)
      const testSuiteMetadata = getTestSuiteCommonTags(
        this.command,
        this.frameworkVersion,
        testSuite,
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
      if (this.libraryConfig?.isCodeCoverageEnabled) {
        this.telemetry.ciVisEvent(TELEMETRY_CODE_COVERAGE_STARTED, 'suite', { library: 'istanbul' })
      }
      if (itrCorrelationId) {
        testSuiteSpan.setTag(ITR_CORRELATION_ID, itrCorrelationId)
      }
      const store = storage.getStore()
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

    this.addSub('ci:mocha:test:start', (testInfo) => {
      const store = storage.getStore()
      const span = this.startTestSpan(testInfo)

      this.enter(span, store)
    })

    this.addSub('ci:mocha:worker:finish', () => {
      this.tracer._exporter.flush()
    })

    this.addSub('ci:mocha:test:finish', (status) => {
      const store = storage.getStore()
      const span = store?.span

      if (span) {
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

    this.addSub('ci:mocha:test:skip', (testInfo) => {
      const store = storage.getStore()
      // skipped through it.skip, so the span is not created yet
      // for this test
      if (!store) {
        const testSpan = this.startTestSpan(testInfo)
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

    this.addSub('ci:mocha:test:parameterize', ({ title, params }) => {
      this._testTitleToParams[title] = params
    })

    this.addSub('ci:mocha:session:finish', ({
      status,
      isSuitesSkipped,
      testCodeCoverageLinesTotal,
      numSkippedSuites,
      hasForcedToRunSuites,
      hasUnskippableSuites,
      error,
      isEarlyFlakeDetectionEnabled,
      isParallel
    }) => {
      if (this.testSessionSpan) {
        const { isSuitesSkippingEnabled, isCodeCoverageEnabled } = this.libraryConfig || {}
        this.testSessionSpan.setTag(TEST_STATUS, status)
        this.testModuleSpan.setTag(TEST_STATUS, status)

        if (error) {
          this.testSessionSpan.setTag('error', error)
          this.testModuleSpan.setTag('error', error)
        }

        if (isParallel) {
          this.testSessionSpan.setTag(MOCHA_IS_PARALLEL, 'true')
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

        if (isEarlyFlakeDetectionEnabled) {
          this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ENABLED, 'true')
        }

        this.testModuleSpan.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
        this.testSessionSpan.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
        finishAllTraceSpans(this.testSessionSpan)
      }
      this.libraryConfig = null
      this.tracer._exporter.flush()
    })

    this.addSub('ci:mocha:worker-report:trace', (traces) => {
      const formattedTraces = JSON.parse(traces).map(trace =>
        trace.map(span => {
          const formattedSpan = {
            ...span,
            span_id: id(span.span_id),
            trace_id: id(span.trace_id),
            parent_id: id(span.parent_id)
          }
          if (formattedSpan.name === 'mocha.test') {
            const testSuite = span.meta[TEST_SUITE]
            const testSuiteSpan = this._testSuites.get(testSuite)
            if (!testSuiteSpan) {
              log.warn(`Test suite span not found for test span with test suite ${testSuite}`)
              return formattedSpan
            }
            const suiteTags = getTestSuiteLevelVisibilityTags(testSuiteSpan)
            formattedSpan.meta = {
              ...formattedSpan.meta,
              ...suiteTags
            }
          }
          return formattedSpan
        })
      )

      formattedTraces.forEach(trace => {
        this.tracer._exporter.export(trace)
      })
    })
  }

  startTestSpan (testInfo) {
    const {
      testSuiteAbsolutePath,
      title,
      isNew,
      isEfdRetry,
      testStartLine,
      isParallel
    } = testInfo

    const testName = removeEfdStringFromTestName(testInfo.testName)

    const extraTags = {}
    const testParametersString = getTestParametersString(this._testTitleToParams, title)
    if (testParametersString) {
      extraTags[TEST_PARAMETERS] = testParametersString
    }

    if (testStartLine) {
      extraTags[TEST_SOURCE_START] = testStartLine
    }

    if (isParallel) {
      extraTags[MOCHA_IS_PARALLEL] = 'true'
    }

    const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.sourceRoot)
    const testSuiteSpan = this._testSuites.get(testSuite)

    if (this.repositoryRoot !== this.sourceRoot && !!this.repositoryRoot) {
      extraTags[TEST_SOURCE_FILE] = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
    } else {
      extraTags[TEST_SOURCE_FILE] = testSuite
    }

    if (isNew) {
      extraTags[TEST_IS_NEW] = 'true'
      if (isEfdRetry) {
        extraTags[TEST_IS_RETRY] = 'true'
      }
    }

    return super.startTestSpan(testName, testSuite, testSuiteSpan, extraTags)
  }
}

module.exports = MochaPlugin
