'use strict'

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')
const { writeDatadogParentId, writeDatadogTraceId } = require('../../dd-trace/src/carrier')

const {
  TEST_STATUS,
  TEST_TYPE,
  VITEST_POOL,
  addIntelligentTestRunnerSpanTags,
  finishAllTraceSpans,
  getTestSuitePath,
  getTestSuiteCommonTags,
  getTestLevelsMetadataTags,
  getTestSessionName,
  TEST_SOURCE_FILE,
  TEST_IS_RETRY,
  TEST_CODE_OWNERS,
  TEST_COMMAND,
  TEST_LEVELS_METADATA,
  TEST_SESSION_NAME,
  TEST_SOURCE_START,
  TEST_IS_NEW,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_RETRY_REASON,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_HAS_FAILED_ALL_RETRIES,
  getLibraryCapabilitiesTags: getDefaultLibraryCapabilitiesTags,
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED,
  TEST_HAS_DYNAMIC_NAME,
  TEST_FINAL_STATUS,
  TEST_IS_TEST_FRAMEWORK_WORKER,
  TEST_BROWSER_DRIVER,
  TEST_BROWSER_NAME,
  TEST_IS_RUM_ACTIVE,
  TEST_PARAMETERS,
  TEST_ITR_UNSKIPPABLE,
  TEST_ITR_FORCED_RUN,
  ITR_CORRELATION_ID,
} = require('../../dd-trace/src/plugins/util/test')
const { COMPONENT } = require('../../dd-trace/src/constants')
const id = require('../../dd-trace/src/id')
const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED,
  TELEMETRY_CODE_COVERAGE_STARTED,
  TELEMETRY_CODE_COVERAGE_FINISHED,
  TELEMETRY_CODE_COVERAGE_EMPTY,
  TELEMETRY_CODE_COVERAGE_NUM_FILES,
  TELEMETRY_ITR_FORCED_TO_RUN,
  TELEMETRY_ITR_UNSKIPPABLE,
  TELEMETRY_TEST_SESSION,
} = require('../../dd-trace/src/ci-visibility/telemetry')
const { DD_MAJOR } = require('../../../version')

// Milliseconds that we subtract from the error test duration
// so that they do not overlap with the following test
// This is because there's some loss of resolution.
const MILLISECONDS_TO_SUBTRACT_FROM_FAILED_TEST_DURATION = 5

function setBrowserTags (tags, browserEnvironment, includeParameters) {
  if (!browserEnvironment.isBrowserMode) return

  tags[TEST_TYPE] = 'browser'
  if (browserEnvironment.browserDriver) {
    tags[TEST_BROWSER_DRIVER] = browserEnvironment.browserDriver
  }
  if (browserEnvironment.browserName) {
    tags[TEST_BROWSER_NAME] = browserEnvironment.browserName
  }
  if (includeParameters && (browserEnvironment.browserName || browserEnvironment.browserProjectName)) {
    const parameters = {}
    if (browserEnvironment.browserName) {
      parameters.browser = browserEnvironment.browserName
    }
    if (browserEnvironment.browserProjectName) {
      parameters.project = browserEnvironment.browserProjectName
    }
    tags[TEST_PARAMETERS] = JSON.stringify({ arguments: parameters, metadata: {} })
  }
}

class VitestPlugin extends CiPlugin {
  static id = 'vitest'

  constructor (...args) {
    super(...args)

    this.taskToFinishTime = new WeakMap()

    this.addSub('ci:vitest:session:configuration', ({ onDone }) => {
      const testSessionSpanContext = this.testSessionSpan?.context()
      const testModuleSpanContext = this.testModuleSpan?.context()
      onDone({
        testSessionId: testSessionSpanContext?.toTraceId(),
        testModuleId: testModuleSpanContext?.toSpanId(),
        testCommand: this.command,
        repositoryRoot: this.repositoryRoot,
        codeOwnersEntries: this.codeOwnersEntries,
      })
    })

    this.addBind('ci:vitest:test:start', (ctx) => {
      const {
        testName,
        testSuiteAbsolutePath,
        isRetry,
        isNew,
        hasDynamicName,
        isAttemptToFix,
        isQuarantined,
        isDisabled,
        mightHitProbe,
        isRetryReasonEfd,
        isRetryReasonAttemptToFix,
        isRetryReasonAtr,
        isModified,
        isTestFrameworkWorker,
        requestErrorTags,
        isBrowserMode,
        browserDriver,
        browserName,
        browserProjectName,
        isRumActive,
        testExecutionId,
        testStartLine,
        startTime,
      } = ctx

      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const store = ctx.currentStore || storage('legacy').getStore()
      const testSuiteSpan = store?.testSuiteSpan || this.testSuiteSpan

      const extraTags = {
        ...requestErrorTags,
        [TEST_SOURCE_FILE]: testSuite,
        [TEST_SOURCE_START]: testStartLine || 1,
      }
      if (isRetry) {
        extraTags[TEST_IS_RETRY] = 'true'
        if (isRetryReasonAttemptToFix) {
          extraTags[TEST_RETRY_REASON] = TEST_RETRY_REASON_TYPES.atf
        } else if (isRetryReasonEfd) {
          extraTags[TEST_RETRY_REASON] = TEST_RETRY_REASON_TYPES.efd
        } else if (isRetryReasonAtr) {
          extraTags[TEST_RETRY_REASON] = TEST_RETRY_REASON_TYPES.atr
        } else {
          extraTags[TEST_RETRY_REASON] = TEST_RETRY_REASON_TYPES.ext
        }
      }
      if (isNew) {
        extraTags[TEST_IS_NEW] = 'true'
      }
      if (hasDynamicName) {
        extraTags[TEST_HAS_DYNAMIC_NAME] = 'true'
      }
      if (isAttemptToFix) {
        extraTags[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] = 'true'
      }
      if (isQuarantined) {
        extraTags[TEST_MANAGEMENT_IS_QUARANTINED] = 'true'
      }
      if (isDisabled) {
        extraTags[TEST_MANAGEMENT_IS_DISABLED] = 'true'
      }
      if (isModified) {
        extraTags[TEST_IS_MODIFIED] = 'true'
      }
      if (isTestFrameworkWorker) {
        extraTags[TEST_IS_TEST_FRAMEWORK_WORKER] = 'true'
      }
      if (isRumActive) {
        extraTags[TEST_IS_RUM_ACTIVE] = 'true'
      }
      setBrowserTags(extraTags, {
        browserDriver,
        browserName,
        browserProjectName,
        isBrowserMode,
      }, true)

      const span = this.startTestSpan(
        testName,
        testSuite,
        testSuiteSpan,
        extraTags,
        testExecutionId,
        startTime
      )

      ctx.parentStore = store
      ctx.currentStore = { ...store, span }

      // TODO: there might be multiple tests for which mightHitProbe is true, so activeTestSpan
      // might be wrongly overwritten.
      if (mightHitProbe) {
        this.activeTestSpan = span
      }

      return ctx.currentStore
    })

    this.addBind('ci:vitest:test:fn', (ctx) => {
      return ctx.currentStore
    })

    this.addBind('ci:vitest:test:finish-time', (ctx) => {
      const { status, task, attemptToFixPassed, attemptToFixFailed, duration } = ctx
      const span = ctx.currentStore?.span

      // we store the finish time to finish at a later hook
      // this is because the test might fail at a `afterEach` hook
      if (span) {
        span.setTag(TEST_STATUS, status)

        if (attemptToFixPassed) {
          span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'true')
        } else if (attemptToFixFailed) {
          span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
        }

        const finishTime = typeof duration === 'number' ? span._startTime + duration : span._getTime()
        this.taskToFinishTime.set(task, finishTime)

        ctx.parentStore = ctx.currentStore
        ctx.currentStore = { ...ctx.currentStore, span }
      }

      return ctx.currentStore
    })

    this.addSub('ci:vitest:test:pass', ({ span, task, finalStatus, earlyFlakeAbortReason, promises }) => {
      if (span) {
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', this.getTestTelemetryTags(span))
        span.setTag(TEST_STATUS, 'pass')
        if (finalStatus) {
          span.setTag(TEST_FINAL_STATUS, finalStatus)
        }
        if (earlyFlakeAbortReason) {
          span.setTag(TEST_EARLY_FLAKE_ABORT_REASON, earlyFlakeAbortReason)
        }
        const finish = () => {
          span.finish(this.taskToFinishTime.get(task))
          finishAllTraceSpans(span)
        }

        if (finalStatus) {
          if (promises && this.diBreakpointHitPromise) {
            promises.hitBreakpointPromise = this.waitForPreparedDiBreakpointHit().then(finish)
            return
          }
          finish()
          this.cancelDiBreakpointHitWait()
          return
        }
        finish()
      }
    })

    this.addSub('ci:vitest:test:error', ({
      span,
      duration,
      error,
      shouldSetProbe,
      shouldWaitForHitProbe,
      promises,
      hasFailedAllRetries,
      attemptToFixFailed,
      finalStatus,
      earlyFlakeAbortReason,
    }) => {
      if (!span) {
        return
      }
      if (shouldSetProbe && this.di && error?.stack) {
        const probeInformation = this.addDiProbe(error)
        if (probeInformation) {
          const { file, line, stackIndex, setProbePromise } = probeInformation
          this.runningTestProbe = { file, line }
          this.testErrorStackIndex = stackIndex
          this.prepareDiBreakpointHitWait()
          promises.setProbePromise = this.waitForDiOperation(setProbePromise)
        }
      }
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', this.getTestTelemetryTags(span))
      span.setTag(TEST_STATUS, 'fail')

      if (error) {
        span.setTag('error', error)
      }
      if (hasFailedAllRetries) {
        span.setTag(TEST_HAS_FAILED_ALL_RETRIES, 'true')
      }
      if (attemptToFixFailed) {
        span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
      }
      if (finalStatus) {
        span.setTag(TEST_FINAL_STATUS, finalStatus)
      }
      if (earlyFlakeAbortReason) {
        span.setTag(TEST_EARLY_FLAKE_ABORT_REASON, earlyFlakeAbortReason)
      }
      const finish = () => {
        if (Number.isFinite(duration) && duration >= 0) {
          span.finish(
            span._startTime + Math.max(duration - MILLISECONDS_TO_SUBTRACT_FROM_FAILED_TEST_DURATION, 0)
          ) // milliseconds
        } else {
          span.finish() // `duration` is empty for retries, so we'll use clock time
        }
        finishAllTraceSpans(span)
      }

      if (!shouldSetProbe && finalStatus && promises && this.diBreakpointHitPromise) {
        promises.hitBreakpointPromise = this.waitForPreparedDiBreakpointHit().then(finish)
        return
      }
      finish()
      if (shouldWaitForHitProbe) {
        this.prepareDiBreakpointHitWait()
      } else if (!shouldSetProbe) {
        this.cancelDiBreakpointHitWait()
      }
    })

    this.addSub('ci:vitest:test:di:wait', ({ promises }) => {
      if (this.di) {
        promises.hitBreakpointPromise = this.waitForDiBreakpointHits()
      }
    })

    this.addSub('ci:vitest:test:skip', ({
      testName,
      testSuiteAbsolutePath,
      isNew,
      isAttemptToFix,
      isDisabled,
      isQuarantined,
      isRumActive,
      isTestFrameworkWorker,
      requestErrorTags,
      testSuiteSpan,
      isBrowserMode,
      browserDriver,
      browserName,
      browserProjectName,
      testExecutionId,
      testStartLine,
    }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const extraTags = {
        ...requestErrorTags,
        [TEST_SOURCE_FILE]: testSuite,
        [TEST_SOURCE_START]: testStartLine || 1,
        [TEST_STATUS]: 'skip',
        [TEST_FINAL_STATUS]: 'skip',
        ...(isAttemptToFix ? { [TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX]: 'true' } : {}),
        ...(isDisabled ? { [TEST_MANAGEMENT_IS_DISABLED]: 'true' } : {}),
        ...(isQuarantined ? { [TEST_MANAGEMENT_IS_QUARANTINED]: 'true' } : {}),
        ...(isNew ? { [TEST_IS_NEW]: 'true' } : {}),
        ...(isRumActive ? { [TEST_IS_RUM_ACTIVE]: 'true' } : {}),
        ...(isTestFrameworkWorker ? { [TEST_IS_TEST_FRAMEWORK_WORKER]: 'true' } : {}),
      }
      setBrowserTags(extraTags, {
        browserDriver,
        browserName,
        browserProjectName,
        isBrowserMode,
      }, true)
      const testSpan = this.startTestSpan(
        testName,
        testSuite,
        testSuiteSpan || this.testSuiteSpan,
        extraTags,
        testExecutionId
      )
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', this.getTestTelemetryTags(testSpan))
      testSpan.finish()
    })

    this.addBind('ci:vitest:test-suite:start', (ctx) => {
      const {
        codeOwnersEntries,
        repositoryRoot,
        requestErrorTags,
        testSuiteAbsolutePath,
        frameworkVersion,
        isTestFrameworkWorker,
        isVitestNoWorkerInitActive,
        disableTestImpactAnalysis,
        isBrowserMode,
        browserDriver,
        browserName,
        browserProjectName,
        isCodeCoverageEnabled,
        coverageLibrary,
        itrCorrelationId,
        isUnskippable,
        isForcedToRun,
      } = ctx

      const testCommand = ctx.testCommand || 'vitest run'
      const { testSessionId, testModuleId } = ctx
      this._setRepositoryRoot(repositoryRoot, codeOwnersEntries)
      this.command = testCommand
      this.frameworkVersion = frameworkVersion
      let testSessionSpanContext
      if (testSessionId && testModuleId) {
        const carrier = /** @type {Record<string, unknown>} */ ({})
        writeDatadogTraceId(carrier, testSessionId)
        writeDatadogParentId(carrier, testModuleId)
        testSessionSpanContext = this.tracer.extract('text_map', carrier)
      }

      const trimmedCommand = DD_MAJOR < 6 ? this.command : 'vitest run'
      // test suites run in a different process, so they also need to init the metadata dictionary
      const testSessionName = getTestSessionName(this.config, trimmedCommand, this.testEnvironmentMetadata)
      if (this.tracer._exporter.addMetadataTags) {
        const libraryCapabilitiesTags = this.getLibraryCapabilitiesTags(frameworkVersion, {
          disableTestImpactAnalysis,
          isVitestNoWorkerInitActive,
        })
        this.tracer._exporter.addMetadataTags({
          [TEST_LEVELS_METADATA]: {
            [TEST_COMMAND]: testCommand,
            [TEST_SESSION_NAME]: testSessionName,
            ...getTestLevelsMetadataTags(this.testEnvironmentMetadata),
          },
          test: libraryCapabilitiesTags,
        })
      }

      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      // Request error tags are applied to test spans in the main process (worker-report:trace handler)
      const testSuiteMetadata = {
        ...getTestSuiteCommonTags(
          this.command,
          this.frameworkVersion,
          testSuite,
          'vitest'
        ),
        ...requestErrorTags,
        [TEST_SOURCE_FILE]: testSuite,
        [TEST_SOURCE_START]: 1,
      }
      if (isTestFrameworkWorker) {
        testSuiteMetadata[TEST_IS_TEST_FRAMEWORK_WORKER] = 'true'
      }
      if (itrCorrelationId) {
        testSuiteMetadata[ITR_CORRELATION_ID] = itrCorrelationId
      }
      if (isUnskippable) {
        testSuiteMetadata[TEST_ITR_UNSKIPPABLE] = 'true'
        this.telemetry.count(TELEMETRY_ITR_UNSKIPPABLE, { testLevel: 'suite' })
      }
      if (isForcedToRun) {
        testSuiteMetadata[TEST_ITR_FORCED_RUN] = 'true'
        this.telemetry.count(TELEMETRY_ITR_FORCED_TO_RUN, { testLevel: 'suite' })
      }
      if (isCodeCoverageEnabled) {
        this.telemetry.ciVisEvent(TELEMETRY_CODE_COVERAGE_STARTED, 'suite', { library: coverageLibrary })
      }
      setBrowserTags(testSuiteMetadata, {
        browserDriver,
        browserName,
        browserProjectName,
        isBrowserMode,
      }, false)

      const codeOwners = this.getCodeOwners(testSuiteMetadata)
      if (codeOwners) {
        testSuiteMetadata[TEST_CODE_OWNERS] = codeOwners
      }

      const testSuiteSpan = this.tracer.startSpan('vitest.test_suite', {
        childOf: testSessionSpanContext,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata,
        },
      })
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      const store = storage('legacy').getStore()
      ctx.parentStore = store
      ctx.currentStore = { ...store, testSuiteSpan }
      this.testSuiteSpan = testSuiteSpan

      return ctx.currentStore
    })

    this.addSub('ci:vitest:test-suite:finish', ({
      testSuiteSpan,
      status,
      coverageFiles,
      coverageLibrary,
      testSuiteAbsolutePath,
      deferFlush,
      onDone,
    }) => {
      if (testSuiteSpan) {
        testSuiteSpan.setTag(TEST_STATUS, status)
        if (coverageFiles) {
          if (!coverageFiles.length) {
            this.telemetry.count(TELEMETRY_CODE_COVERAGE_EMPTY)
          }
          const files = new Set(coverageFiles)
          files.add(testSuiteAbsolutePath)
          const relativeFiles = [...files].map(filename => getTestSuitePath(filename, this.repositoryRoot))
          const { _traceId, _spanId } = testSuiteSpan.context()
          this.tracer._exporter.exportCoverage({
            sessionId: _traceId,
            suiteId: _spanId,
            files: relativeFiles,
          })
          this.telemetry.ciVisEvent(TELEMETRY_CODE_COVERAGE_FINISHED, 'suite', { library: coverageLibrary })
          this.telemetry.distribution(TELEMETRY_CODE_COVERAGE_NUM_FILES, {}, relativeFiles.length)
        }
        this.tracer._exporter.deferTestSuiteSpan?.(testSuiteSpan)
        testSuiteSpan.finish()
        finishAllTraceSpans(testSuiteSpan)
      }
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
      if (deferFlush) {
        onDone()
        return
      }
      this.tracer._exporter.flush(onDone)
      if (this.runningTestProbe) {
        this.removeDiProbe(this.runningTestProbe)
      }
    })

    this.addSub('ci:vitest:worker-report:coverage', data => {
      const formattedCoverages = JSON.parse(data).map(coverage => ({
        sessionId: id(coverage.sessionId),
        suiteId: id(coverage.suiteId),
        files: coverage.files,
      }))
      for (const formattedCoverage of formattedCoverages) {
        this.tracer._exporter.exportCoverage(formattedCoverage)
      }
    })

    this.addBind('ci:vitest:test-suite:error', (ctx) => {
      const { error } = ctx
      const testSuiteSpan = ctx.currentStore?.testSuiteSpan

      if (testSuiteSpan && error) {
        testSuiteSpan.setTag('error', error)
        testSuiteSpan.setTag(TEST_STATUS, 'fail')

        ctx.parentStore = ctx.currentStore
        ctx.currentStore = { ...ctx.currentStore, testSuiteSpan }
      }

      return ctx.currentStore
    })

    this.addSub('ci:vitest:session:finish', ({
      status,
      error,
      isTestSessionFinalizationError,
      testCodeCoverageLinesTotal,
      isEarlyFlakeDetectionEnabled,
      isEarlyFlakeDetectionFaulty,
      isTestManagementTestsEnabled,
      isCodeCoverageEnabled,
      isSuitesSkippingEnabled,
      isSuitesSkipped,
      numSkippedSuites,
      hasUnskippableSuites,
      hasForcedToRunSuites,
      requestErrorTags,
      vitestPool,
      isVitestNoWorkerInitActive,
      onDone,
    }) => {
      for (const [tag, value] of Object.entries(requestErrorTags)) {
        this.testSessionSpan.setTag(tag, value)
        this.testModuleSpan.setTag(tag, value)
      }
      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.setTag(TEST_STATUS, status)
      if (error) {
        if (isTestSessionFinalizationError) {
          this.tracer._exporter.setDeferredTestSuiteError?.(error)
        }
        this.testModuleSpan.setTag('error', error)
        this.testSessionSpan.setTag('error', error)
      }
      addIntelligentTestRunnerSpanTags(
        this.testSessionSpan,
        this.testModuleSpan,
        {
          isSuitesSkipped,
          isSuitesSkippingEnabled,
          isCodeCoverageEnabled,
          testCodeCoverageLinesTotal,
          skippingType: 'suite',
          skippingCount: numSkippedSuites,
          hasUnskippableSuites,
          hasForcedToRunSuites,
        }
      )
      if (isEarlyFlakeDetectionEnabled) {
        this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ENABLED, 'true')
      }
      if (isEarlyFlakeDetectionFaulty) {
        this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ABORT_REASON, 'faulty')
      }
      if (isTestManagementTestsEnabled) {
        this.testSessionSpan.setTag(TEST_MANAGEMENT_ENABLED, 'true')
      }
      if (vitestPool) {
        this.testSessionSpan.setTag(VITEST_POOL, vitestPool)
      }
      this.tracer._exporter.exportDeferredTestSuiteSpans?.()
      this.testModuleSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
      this.testSessionSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session', {
        hasFailedTestReplay: this.libraryConfig?.isDiEnabled && !isVitestNoWorkerInitActive ? true : undefined,
      })
      finishAllTraceSpans(this.testSessionSpan)
      this.telemetry.count(TELEMETRY_TEST_SESSION, {
        provider: this.ciProviderName,
        autoInjected: !!this._tracerConfig.testOptimization.DD_CIVISIBILITY_AUTO_INSTRUMENTATION_PROVIDER,
      })
      this.tracer._exporter.flush(onDone)
    })

    this.addSub('ci:vitest:coverage-report', ({ rootDir, onDone }) => {
      this.handleCoverageReport(rootDir, onDone)
    })
  }

  /**
   * Returns Vitest library capability metadata tags.
   * @param {string} frameworkVersion - The Vitest version.
   * @param {object} [ctx] - Diagnostic channel context.
   * @param {boolean} [ctx.disableTestImpactAnalysis] - Whether TIA is unsupported for this run.
   * @param {boolean} [ctx.isVitestNoWorkerInitActive] - Whether no-worker init is active for this run.
   * @returns {Record<string, string|undefined>}
   */
  getLibraryCapabilitiesTags (frameworkVersion, ctx = {}) {
    return getDefaultLibraryCapabilitiesTags(this.constructor.id, frameworkVersion, {
      omitFailedTestReplay: ctx.isVitestNoWorkerInitActive,
      omitTestImpactAnalysis: ctx.disableTestImpactAnalysis || ctx.isVitestNoWorkerInitActive,
    })
  }

  /**
   * Handles the coverage report by discovering and uploading it if enabled.
   * @param {string} rootDir - The root directory where coverage reports are located.
   * @param {Function} [onDone] - Callback to signal completion.
   */
  handleCoverageReport (rootDir, onDone) {
    if (!this.libraryConfig?.isCoverageReportUploadEnabled) {
      onDone()
      return
    }
    this.uploadCoverageReports({
      rootDir,
      testEnvironmentMetadata: this.testEnvironmentMetadata,
      onDone,
    })
  }
}

module.exports = VitestPlugin
