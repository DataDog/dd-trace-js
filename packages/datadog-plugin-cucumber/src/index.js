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
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_SUITE_ID,
  TEST_SESSION_ID,
  TEST_COMMAND,
  TEST_MODULE,
  TEST_MODULE_ID,
  TEST_SUITE,
  CUCUMBER_IS_PARALLEL,
  TEST_RETRY_REASON,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED
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
  TELEMETRY_CODE_COVERAGE_NUM_FILES,
  TEST_IS_RUM_ACTIVE,
  TEST_BROWSER_DRIVER,
  TELEMETRY_TEST_SESSION
} = require('../../dd-trace/src/ci-visibility/telemetry')
const id = require('../../dd-trace/src/id')

const BREAKPOINT_HIT_GRACE_PERIOD_MS = 200
const BREAKPOINT_SET_GRACE_PERIOD_MS = 200
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
      isEarlyFlakeDetectionFaulty,
      isQuarantinedTestsEnabled,
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
      if (isEarlyFlakeDetectionFaulty) {
        this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ABORT_REASON, 'faulty')
      }
      if (isParallel) {
        this.testSessionSpan.setTag(CUCUMBER_IS_PARALLEL, 'true')
      }
      if (isQuarantinedTestsEnabled) {
        this.testSessionSpan.setTag(TEST_MANAGEMENT_ENABLED, 'true')
      }

      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
      this.testSessionSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
      finishAllTraceSpans(this.testSessionSpan)
      this.telemetry.count(TELEMETRY_TEST_SESSION, { provider: this.ciProviderName })

      this.libraryConfig = null
      this.tracer._exporter.flush()
    })

    this.addSub('ci:cucumber:test-suite:start', ({
      testFileAbsolutePath,
      isUnskippable,
      isForcedToRun,
      itrCorrelationId
    }) => {
      const testSuitePath = getTestSuitePath(testFileAbsolutePath, process.cwd())
      const testSourceFile = getTestSuitePath(testFileAbsolutePath, this.repositoryRoot)

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
      if (testSourceFile) {
        testSuiteMetadata[TEST_SOURCE_FILE] = testSourceFile
        testSuiteMetadata[TEST_SOURCE_START] = 1
      }

      const codeOwners = this.getCodeOwners(testSuiteMetadata)
      if (codeOwners) {
        testSuiteMetadata[TEST_CODE_OWNERS] = codeOwners
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
      if (coverageFiles.length === 0) {
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

    this.addSub('ci:cucumber:test:start', ({
      testName,
      testFileAbsolutePath,
      testSourceLine,
      isParallel,
      promises
    }) => {
      const store = storage('legacy').getStore()
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

      this.activeTestSpan = testSpan
      // Time we give the breakpoint to be hit
      if (promises && this.runningTestProbe) {
        promises.hitBreakpointPromise = new Promise((resolve) => {
          setTimeout(resolve, BREAKPOINT_HIT_GRACE_PERIOD_MS)
        })
      }
    })

    this.addSub('ci:cucumber:test:retry', ({ isFirstAttempt, error }) => {
      const store = storage('legacy').getStore()
      const span = store.span
      if (!isFirstAttempt) {
        span.setTag(TEST_IS_RETRY, 'true')
      }
      span.setTag('error', error)
      if (isFirstAttempt && this.di && error && this.libraryConfig?.isDiEnabled) {
        const probeInformation = this.addDiProbe(error)
        if (probeInformation) {
          const { file, line, stackIndex } = probeInformation
          this.runningTestProbe = { file, line }
          this.testErrorStackIndex = stackIndex
          const waitUntil = Date.now() + BREAKPOINT_SET_GRACE_PERIOD_MS
          while (Date.now() < waitUntil) {
            // TODO: To avoid a race condition, we should wait until `probeInformation.setProbePromise` has resolved.
            // However, Cucumber doesn't have a mechanism for waiting asyncrounously here, so for now, we'll have to
            // fall back to a fixed syncronous delay.
          }
        }
      }
      span.setTag(TEST_STATUS, 'fail')
      span.finish()
      finishAllTraceSpans(span)
    })

    this.addSub('ci:cucumber:test-step:start', ({ resource }) => {
      const store = storage('legacy').getStore()
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
      for (const trace of formattedTraces) {
        for (const span of trace) {
          if (span.name === 'cucumber.test') {
            const testSuite = span.meta[TEST_SUITE]
            const testSuiteSpan = this.testSuiteSpanByPath[testSuite]

            const testSuiteTags = getTestSuiteTags(testSuiteSpan)
            span.meta = {
              ...span.meta,
              ...testSuiteTags
            }
          }
        }

        this.tracer._exporter.export(trace)
      }
    })

    this.addSub('ci:cucumber:test:finish', ({
      isStep,
      status,
      skipReason,
      error,
      errorMessage,
      isNew,
      isEfdRetry,
      isFlakyRetry,
      isQuarantined
    }) => {
      const span = storage('legacy').getStore().span
      const statusTag = isStep ? 'step.status' : TEST_STATUS

      span.setTag(statusTag, status)

      if (isNew) {
        span.setTag(TEST_IS_NEW, 'true')
        if (isEfdRetry) {
          span.setTag(TEST_IS_RETRY, 'true')
          span.setTag(TEST_RETRY_REASON, 'efd')
        }
      }

      if (skipReason) {
        span.setTag(TEST_SKIP_REASON, skipReason)
      }

      if (error) {
        span.setTag('error', error)
      } else if (errorMessage) { // we can't get a full error in cucumber steps
        span.setTag(ERROR_MESSAGE, errorMessage)
      }

      if (isFlakyRetry > 0) {
        span.setTag(TEST_IS_RETRY, 'true')
      }

      if (isQuarantined) {
        span.setTag(TEST_MANAGEMENT_IS_QUARANTINED, 'true')
      }

      span.finish()
      if (!isStep) {
        const spanTags = span.context()._tags
        this.telemetry.ciVisEvent(
          TELEMETRY_EVENT_FINISHED,
          'test',
          {
            hasCodeOwners: !!spanTags[TEST_CODE_OWNERS],
            isNew,
            isRum: spanTags[TEST_IS_RUM_ACTIVE] === 'true',
            browserDriver: spanTags[TEST_BROWSER_DRIVER]
          }
        )
        finishAllTraceSpans(span)
        // If it's a worker, flushing is cheap, as it's just sending data to the main process
        if (isCucumberWorker) {
          this.tracer._exporter.flush()
        }
        this.activeTestSpan = null
        if (this.runningTestProbe) {
          this.removeDiProbe(this.runningTestProbe)
          this.runningTestProbe = null
        }
      }
    })

    this.addSub('ci:cucumber:error', (err) => {
      if (err) {
        const span = storage('legacy').getStore().span
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
