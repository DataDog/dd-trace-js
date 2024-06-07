'use strict'

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

const {
  TEST_SKIP_REASON,
  TEST_STATUS,
  TEST_SOURCE_START,
  finishAllTraceSpans,
  getTestSuitePath,
  getTestSuiteCommonTags,
  addIntelligentTestRunnerSpanTags,
  TEST_ITR_UNSKIPPABLE,
  TEST_ITR_FORCED_RUN,
  TEST_CODE_OWNERS,
  ITR_CORRELATION_ID,
  TEST_SOURCE_FILE,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_SUITE_ID,
  TEST_SESSION_ID,
  TEST_COMMAND,
  TEST_MODULE,
  TEST_MODULE_ID,
  TEST_SUITE,
  CUCUMBER_IS_PARALLEL
} = require('../../dd-trace/src/plugins/util/test')
const { RESOURCE_NAME } = require('../../../ext/tags')
const { COMPONENT, ERROR_MESSAGE } = require('../../dd-trace/src/constants')
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

const isCucumberWorker = !!process.env.CUCUMBER_WORKER_ID

function getTestSuiteTags (testSuiteSpan) {
  const suiteTags = {
    [TEST_SUITE_ID]: testSuiteSpan.context().toSpanId(),
    [TEST_SESSION_ID]: testSuiteSpan.context().toTraceId(),
    [TEST_COMMAND]: testSuiteSpan.context()._tags[TEST_COMMAND],
    [TEST_MODULE]: 'cucumber'
  }
  if (testSuiteSpan.context()._parentId) {
    suiteTags[TEST_MODULE_ID] = testSuiteSpan.context()._parentId.toString(10)
  }
  return suiteTags
}

class CucumberPlugin extends CiPlugin {
  static get id () {
    return 'cucumber'
  }

  constructor (...args) {
    super(...args)

    this.sourceRoot = process.cwd()

    this.testSuiteSpanByPath = {}

    this.addSub('ci:cucumber:session:finish', ({
      status,
      isSuitesSkipped,
      numSkippedSuites,
      testCodeCoverageLinesTotal,
      hasUnskippableSuites,
      hasForcedToRunSuites,
      isEarlyFlakeDetectionEnabled,
      isParallel
    }) => {
      const { isSuitesSkippingEnabled, isCodeCoverageEnabled } = this.libraryConfig || {}
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
          hasUnskippableSuites,
          hasForcedToRunSuites
        }
      )
      if (isEarlyFlakeDetectionEnabled) {
        this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ENABLED, 'true')
      }
      if (isParallel) {
        this.testSessionSpan.setTag(CUCUMBER_IS_PARALLEL, 'true')
      }

      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
      this.testSessionSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
      finishAllTraceSpans(this.testSessionSpan)

      this.libraryConfig = null
      this.tracer._exporter.flush()
    })

    this.addSub('ci:cucumber:test-suite:start', ({ testSuitePath, isUnskippable, isForcedToRun, itrCorrelationId }) => {
      const testSuiteMetadata = getTestSuiteCommonTags(
        this.command,
        this.frameworkVersion,
        testSuitePath,
        'cucumber'
      )
      if (isUnskippable) {
        this.telemetry.count(TELEMETRY_ITR_UNSKIPPABLE, { testLevel: 'suite' })
        testSuiteMetadata[TEST_ITR_UNSKIPPABLE] = 'true'
      }
      if (isForcedToRun) {
        this.telemetry.count(TELEMETRY_ITR_FORCED_TO_RUN, { testLevel: 'suite' })
        testSuiteMetadata[TEST_ITR_FORCED_RUN] = 'true'
      }
      if (itrCorrelationId) {
        testSuiteMetadata[ITR_CORRELATION_ID] = itrCorrelationId
      }
      const testSuiteSpan = this.tracer.startSpan('cucumber.test_suite', {
        childOf: this.testModuleSpan,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
      this.testSuiteSpanByPath[testSuitePath] = testSuiteSpan

      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      if (this.libraryConfig?.isCodeCoverageEnabled) {
        this.telemetry.ciVisEvent(TELEMETRY_CODE_COVERAGE_STARTED, 'suite', { library: 'istanbul' })
      }
    })

    this.addSub('ci:cucumber:test-suite:finish', ({ status, testSuitePath }) => {
      const testSuiteSpan = this.testSuiteSpanByPath[testSuitePath]
      testSuiteSpan.setTag(TEST_STATUS, status)
      testSuiteSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
    })

    this.addSub('ci:cucumber:test-suite:code-coverage', ({ coverageFiles, suiteFile, testSuitePath }) => {
      if (!this.libraryConfig?.isCodeCoverageEnabled) {
        return
      }
      if (!coverageFiles.length) {
        this.telemetry.count(TELEMETRY_CODE_COVERAGE_EMPTY)
      }
      const testSuiteSpan = this.testSuiteSpanByPath[testSuitePath]

      const relativeCoverageFiles = [...coverageFiles, suiteFile]
        .map(filename => getTestSuitePath(filename, this.repositoryRoot))

      this.telemetry.distribution(TELEMETRY_CODE_COVERAGE_NUM_FILES, {}, relativeCoverageFiles.length)

      const formattedCoverage = {
        sessionId: testSuiteSpan.context()._traceId,
        suiteId: testSuiteSpan.context()._spanId,
        files: relativeCoverageFiles
      }

      this.tracer._exporter.exportCoverage(formattedCoverage)
      this.telemetry.ciVisEvent(TELEMETRY_CODE_COVERAGE_FINISHED, 'suite', { library: 'istanbul' })
    })

    this.addSub('ci:cucumber:test:start', ({ testName, testFileAbsolutePath, testSourceLine, isParallel }) => {
      const store = storage.getStore()
      const testSuite = getTestSuitePath(testFileAbsolutePath, this.sourceRoot)
      const testSourceFile = getTestSuitePath(testFileAbsolutePath, this.repositoryRoot)

      const extraTags = {
        [TEST_SOURCE_START]: testSourceLine,
        [TEST_SOURCE_FILE]: testSourceFile
      }
      if (isParallel) {
        extraTags[CUCUMBER_IS_PARALLEL] = 'true'
      }

      const testSpan = this.startTestSpan(testName, testSuite, extraTags)

      this.enter(testSpan, store)
    })

    this.addSub('ci:cucumber:test-step:start', ({ resource }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('cucumber.step', {
        childOf,
        tags: {
          [COMPONENT]: this.constructor.id,
          'cucumber.step': resource,
          [RESOURCE_NAME]: resource
        }
      })
      this.enter(span, store)
    })

    this.addSub('ci:cucumber:worker-report:trace', (traces) => {
      const formattedTraces = JSON.parse(traces).map(trace =>
        trace.map(span => ({
          ...span,
          span_id: id(span.span_id),
          trace_id: id(span.trace_id),
          parent_id: id(span.parent_id)
        }))
      )

      // We have to update the test session, test module and test suite ids
      // before we export them in the main process
      formattedTraces.forEach(trace => {
        trace.forEach(span => {
          if (span.name === 'cucumber.test') {
            const testSuite = span.meta[TEST_SUITE]
            const testSuiteSpan = this.testSuiteSpanByPath[testSuite]

            const testSuiteTags = getTestSuiteTags(testSuiteSpan)
            span.meta = {
              ...span.meta,
              ...testSuiteTags
            }
          }
        })

        this.tracer._exporter.export(trace)
      })
    })

    this.addSub('ci:cucumber:test:finish', ({ isStep, status, skipReason, errorMessage, isNew, isEfdRetry }) => {
      const span = storage.getStore().span
      const statusTag = isStep ? 'step.status' : TEST_STATUS

      span.setTag(statusTag, status)

      if (isNew) {
        span.setTag(TEST_IS_NEW, 'true')
        if (isEfdRetry) {
          span.setTag(TEST_IS_RETRY, 'true')
        }
      }

      if (skipReason) {
        span.setTag(TEST_SKIP_REASON, skipReason)
      }

      if (errorMessage) {
        span.setTag(ERROR_MESSAGE, errorMessage)
      }

      span.finish()
      if (!isStep) {
        this.telemetry.ciVisEvent(
          TELEMETRY_EVENT_FINISHED,
          'test',
          { hasCodeOwners: !!span.context()._tags[TEST_CODE_OWNERS] }
        )
        finishAllTraceSpans(span)
        // If it's a worker, flushing is cheap, as it's just sending data to the main process
        if (isCucumberWorker) {
          this.tracer._exporter.flush()
        }
      }
    })

    this.addSub('ci:cucumber:error', (err) => {
      if (err) {
        const span = storage.getStore().span
        span.setTag('error', err)
      }
    })
  }

  startTestSpan (testName, testSuite, extraTags) {
    const testSuiteSpan = this.testSuiteSpanByPath[testSuite]
    return super.startTestSpan(
      testName,
      testSuite,
      testSuiteSpan,
      extraTags
    )
  }
}

module.exports = CucumberPlugin
