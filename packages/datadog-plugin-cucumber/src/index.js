'use strict'

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')
const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')

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
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED,
  isModifiedTest,
  getTestEndLine
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
const isCucumberWorker = !!getEnvironmentVariable('CUCUMBER_WORKER_ID')

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
      isTestManagementTestsEnabled,
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
      if (isTestManagementTestsEnabled) {
        this.testSessionSpan.setTag(TEST_MANAGEMENT_ENABLED, 'true')
      }

      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
      this.testSessionSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
      finishAllTraceSpans(this.testSessionSpan)
      this.telemetry.count(TELEMETRY_TEST_SESSION, {
        provider: this.ciProviderName,
        autoInjected: !!getEnvironmentVariable('DD_CIVISIBILITY_AUTO_INSTRUMENTATION_PROVIDER')
      })

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
        },
        integrationName: this.constructor.id
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

    this.addBind('ci:cucumber:test:start', (ctx) => {
      const { testName, testFileAbsolutePath, testSourceLine, isParallel, promises } = ctx
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

      const span = this.startTestSpan(testName, testSuite, extraTags)

      ctx.parentStore = store
      ctx.currentStore = { ...store, span }

      this.activeTestSpan = span
      // Time we give the breakpoint to be hit
      if (promises && this.runningTestProbe) {
        promises.hitBreakpointPromise = new Promise((resolve) => {
          setTimeout(resolve, BREAKPOINT_HIT_GRACE_PERIOD_MS)
        })
      }

      return ctx.currentStore
    })

    this.addSub('ci:cucumber:test:retry', ({ span, isFirstAttempt, error, isAtrRetry }) => {
      if (!isFirstAttempt) {
        span.setTag(TEST_IS_RETRY, 'true')
        if (isAtrRetry) {
          span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atr)
        } else {
          span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.ext)
        }
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

    this.addBind('ci:cucumber:test-step:start', (ctx) => {
      const { resource } = ctx

      const store = storage('legacy').getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('cucumber.step', {
        childOf,
        tags: {
          [COMPONENT]: this.constructor.id,
          'cucumber.step': resource,
          [RESOURCE_NAME]: resource
        },
        integrationName: this.constructor.id
      })
      ctx.parentStore = store
      ctx.currentStore = { ...store, span }

      return ctx.currentStore
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

    this.addSub('ci:cucumber:test:finish', ({
      span,
      isStep,
      status,
      skipReason,
      error,
      errorMessage,
      isNew,
      isEfdRetry,
      isFlakyRetry,
      isAttemptToFix,
      isAttemptToFixRetry,
      hasFailedAllRetries,
      hasPassedAllRetries,
      hasFailedAttemptToFix,
      isDisabled,
      isQuarantined,
      isModified
    }) => {
      const statusTag = isStep ? 'step.status' : TEST_STATUS

      span.setTag(statusTag, status)

      if (isNew) {
        span.setTag(TEST_IS_NEW, 'true')
        if (isEfdRetry) {
          span.setTag(TEST_IS_RETRY, 'true')
          span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.efd)
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
        span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atr)
      }

      if (hasFailedAllRetries) {
        span.setTag(TEST_HAS_FAILED_ALL_RETRIES, 'true')
      }

      if (isAttemptToFix) {
        span.setTag(TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX, 'true')
      }

      if (isAttemptToFixRetry) {
        span.setTag(TEST_IS_RETRY, 'true')
        span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atf)
        if (hasPassedAllRetries) {
          span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'true')
        } else if (hasFailedAttemptToFix) {
          span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
        }
      }

      if (isDisabled) {
        span.setTag(TEST_MANAGEMENT_IS_DISABLED, 'true')
      }

      if (isQuarantined) {
        span.setTag(TEST_MANAGEMENT_IS_QUARANTINED, 'true')
      }

      if (isModified) {
        span.setTag(TEST_IS_MODIFIED, 'true')
        if (isEfdRetry) {
          span.setTag(TEST_IS_RETRY, 'true')
          span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.efd)
        }
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

    this.addBind('ci:cucumber:error', (ctx) => {
      const { err } = ctx
      if (err) {
        const span = ctx.currentStore.span
        span.setTag('error', err)

        ctx.parentStore = ctx.currentStore
        ctx.currentStore = { ...ctx.currentStore, span }
      }

      return ctx.currentStore
    })

    this.addBind('ci:cucumber:test:fn', (ctx) => {
      return ctx.currentStore
    })

    this.addSub('ci:cucumber:is-modified-test', ({
      scenarios,
      testFileAbsolutePath,
      modifiedTests,
      stepIds,
      stepDefinitions,
      setIsModified
    }) => {
      const testScenarioPath = getTestSuitePath(testFileAbsolutePath, this.repositoryRoot || process.cwd())
      for (const scenario of scenarios) {
        const isModified = isModifiedTest(
          testScenarioPath,
          scenario.location.line,
          scenario.steps[scenario.steps.length - 1].location.line,
          modifiedTests,
          'cucumber'
        )
        if (isModified) {
          setIsModified(true)
          return
        }
      }
      for (const stepDefinition of stepDefinitions) {
        if (!stepIds?.includes(stepDefinition.id)) {
          continue
        }
        const testStartLineStep = stepDefinition.line
        const testEndLineStep = getTestEndLine(stepDefinition.code, testStartLineStep)
        const isModified = isModifiedTest(
          stepDefinition.uri,
          testStartLineStep,
          testEndLineStep,
          modifiedTests,
          'cucumber'
        )
        if (isModified) {
          setIsModified(true)
          return
        }
      }
      setIsModified(false)
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
