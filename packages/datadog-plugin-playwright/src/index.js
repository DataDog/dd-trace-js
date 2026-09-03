'use strict'

const { basename } = require('node:path')

const { storage } = require('../../datadog-core')
const id = require('../../dd-trace/src/id')
const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const getConfig = require('../../dd-trace/src/config')
const {
  SCREENSHOT_UPLOAD_RESULT_ERROR,
  SCREENSHOT_UPLOAD_RESULT_UPLOADED,
  getScreenshotCapturedAtMs,
  getScreenshotUploadResult,
  getScreenshotUploadTag,
} = require('../../dd-trace/src/ci-visibility/test-screenshot')
const {
  VIDEO_UPLOAD_RESULT_ERROR,
  VIDEO_UPLOAD_RESULT_UPLOADED,
  getVideoUploadResult,
  getVideoUploadTag,
} = require('../../dd-trace/src/ci-visibility/test-video')

const {
  finishAllTraceSpans,
  getTestSuiteCommonTags,
  getTestSuitePath,
  isModifiedTest,
  setRumTestCorrelation,
  TEST_BROWSER_NAME,
  TEST_CODE_OWNERS,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_FRAMEWORK_VERSION,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_IS_MODIFIED,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_IS_RUM_ACTIVE,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MODULE_ID,
  TEST_MODULE,
  TEST_NAME,
  TEST_PARAMETERS,
  TEST_RETRY_REASON_TYPES,
  TEST_RETRY_REASON,
  TEST_SESSION_ID,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
  TEST_STATUS,
  TEST_SUITE_ID,
  TEST_SUITE,
  TEST_HAS_DYNAMIC_NAME,
  DYNAMIC_NAME_RE,
  TEST_FINAL_STATUS,
} = require('../../dd-trace/src/plugins/util/test')
const { RESOURCE_NAME } = require('../../../ext/tags')
const { COMPONENT } = require('../../dd-trace/src/constants')
const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED,
  TELEMETRY_TEST_SESSION,
} = require('../../dd-trace/src/ci-visibility/telemetry')
const { appClosing: appClosingTelemetry } = require('../../dd-trace/src/telemetry')
const log = require('../../dd-trace/src/log')

const PLAYWRIGHT_FAILURE_SCREENSHOT_RE = /^test-failed-\d+\.png$/
const PLAYWRIGHT_VIDEO_CONTENT_TYPES = new Set(['video/mp4', 'video/webm'])
const noop = () => {}

/**
 * Returns whether an attachment is an automatic Playwright failure screenshot.
 *
 * @param {object} attachment - Playwright test attachment
 * @returns {boolean}
 */
function isPlaywrightFailureScreenshot (attachment) {
  return attachment?.name === 'screenshot' &&
    attachment.contentType === 'image/png' &&
    typeof attachment.path === 'string' &&
    PLAYWRIGHT_FAILURE_SCREENSHOT_RE.test(basename(attachment.path))
}

/**
 * Returns whether an attachment is a Playwright test video.
 *
 * @param {object} attachment - Playwright test attachment
 * @returns {boolean}
 */
function isPlaywrightFailureVideo (attachment) {
  return attachment?.name === 'video' &&
    PLAYWRIGHT_VIDEO_CONTENT_TYPES.has(attachment.contentType) &&
    typeof attachment.path === 'string'
}

class PlaywrightPlugin extends CiPlugin {
  static id = 'playwright'

  #isFinalizingAfterError = false
  #finishPendingTestFinishes
  #pendingTestFinishCallbacks = new Map()

  constructor (...args) {
    super(...args)

    this._testSuiteSpansByTestSuiteAbsolutePath = new Map()
    this.numFailedTests = 0
    this.numFailedSuites = 0
    this.pendingTestFinishes = 0

    this.addSub('ci:playwright:test:is-modified', ({
      filePath,
      modifiedFiles,
      onDone,
    }) => {
      const testSuite = getTestSuitePath(filePath, this.repositoryRoot)
      const isModified = isModifiedTest(testSuite, 0, 0, modifiedFiles, this.constructor.id)
      onDone(isModified)
    })

    this.addSub('ci:playwright:session:start', ({
      isFailureScreenshotEnabled,
      isFailureVideoEnabled,
      isFailureVideoUploadSupported,
    }) => {
      this.#isFinalizingAfterError = false
      const testOptimizationConfig = getConfig().testOptimization

      if (testOptimizationConfig.DD_TEST_FAILURE_SCREENSHOTS_ENABLED && !isFailureScreenshotEnabled) {
        log.warn(
          '%s %s',
          'DD_TEST_FAILURE_SCREENSHOTS_ENABLED is true, but Playwright screenshot capture is disabled.',
          'Set Playwright use.screenshot to "only-on-failure", "on-first-failure", or "on".'
        )
      }
      if (testOptimizationConfig.DD_TEST_FAILURE_VIDEOS_ENABLED && !isFailureVideoUploadSupported) {
        log.warn(
          '%s %s',
          'DD_TEST_FAILURE_VIDEOS_ENABLED is true, but Playwright video upload requires Playwright 1.38.0 or later.',
          'Upgrade Playwright to enable failure video uploads.'
        )
      } else if (testOptimizationConfig.DD_TEST_FAILURE_VIDEOS_ENABLED && !isFailureVideoEnabled) {
        log.warn(
          '%s %s',
          'DD_TEST_FAILURE_VIDEOS_ENABLED is true, but Playwright video capture is disabled.',
          'Set Playwright use.video to "retain-on-failure" or "on".'
        )
      }
    })

    this.addSub('ci:playwright:session:configuration', ({
      isFailureScreenshotEnabled,
      isFailureVideoEnabled,
      isFailureVideoUploadSupported,
    }) => {
      const testOptimizationConfig = getConfig().testOptimization

      if (testOptimizationConfig.DD_TEST_FAILURE_SCREENSHOTS_ENABLED && isFailureScreenshotEnabled &&
        !this.tracer._exporter?.canUploadTestScreenshots?.()) {
        log.warn(
          '%s %s',
          'DD_TEST_FAILURE_SCREENSHOTS_ENABLED is true, but Playwright screenshot upload is not supported',
          'by the active Test Optimization transport.'
        )
      }
      if (testOptimizationConfig.DD_TEST_FAILURE_VIDEOS_ENABLED && isFailureVideoEnabled &&
        isFailureVideoUploadSupported &&
        !this.tracer._exporter?.canUploadTestVideos?.()) {
        log.warn(
          '%s %s',
          'DD_TEST_FAILURE_VIDEOS_ENABLED is true, but Playwright video upload is not supported',
          'by the active Test Optimization transport.'
        )
      }
    })

    this.addSub('ci:playwright:session:finish', ({
      status,
      isEarlyFlakeDetectionEnabled,
      isEarlyFlakeDetectionFaulty,
      isTestManagementTestsEnabled,
      error,
      onDone,
    }) => {
      if (error) {
        this.#isFinalizingAfterError = true
        for (const testSuiteSpan of this._testSuiteSpansByTestSuiteAbsolutePath.values()) {
          testSuiteSpan.setTag(TEST_STATUS, 'fail')
          testSuiteSpan.setTag('error', error)
        }
        for (const [finishTest, pendingTestFinish] of this.#pendingTestFinishCallbacks) {
          finishTest(
            pendingTestFinish.hasScreenshot ? SCREENSHOT_UPLOAD_RESULT_ERROR : undefined,
            pendingTestFinish.hasVideo ? VIDEO_UPLOAD_RESULT_ERROR : undefined
          )
          pendingTestFinish.abortController.abort()
        }
      }

      const finishSession = (flushDone) => {
        this.testModuleSpan.setTag(TEST_STATUS, status)
        this.testSessionSpan.setTag(TEST_STATUS, status)

        if (isEarlyFlakeDetectionEnabled) {
          this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ENABLED, 'true')
        }
        if (isEarlyFlakeDetectionFaulty) {
          this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ABORT_REASON, 'faulty')
        }
        let sessionError = error
        if (!sessionError && status === 'fail' && this.numFailedSuites > 0) {
          let errorMessage = `Test suites failed: ${this.numFailedSuites}.`
          if (this.numFailedTests > 0) {
            errorMessage += ` Tests failed: ${this.numFailedTests}`
          }
          sessionError = new Error(errorMessage)
        }
        if (sessionError) {
          this.testModuleSpan.setTag('error', sessionError)
          this.testSessionSpan.setTag('error', sessionError)
        }

        if (isTestManagementTestsEnabled) {
          this.testSessionSpan.setTag(TEST_MANAGEMENT_ENABLED, 'true')
        }

        this.testModuleSpan.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
        this.testSessionSpan.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
        finishAllTraceSpans(this.testSessionSpan)
        this.telemetry.count(TELEMETRY_TEST_SESSION, {
          provider: this.ciProviderName,
          autoInjected: !!this._tracerConfig.testOptimization.DD_CIVISIBILITY_AUTO_INSTRUMENTATION_PROVIDER,
        })
        appClosingTelemetry()
        this.tracer._exporter.flush(flushDone)
        this.numFailedTests = 0
        this.numFailedSuites = 0
      }

      if (this.pendingTestFinishes > 0) {
        this.#finishPendingTestFinishes = () => this.tracer._exporter.flush(onDone)
        finishSession(noop)
      } else {
        finishSession(onDone)
      }
    })

    this.addBind('ci:playwright:test-suite:start', (ctx) => {
      const { testSuiteAbsolutePath, testSourceFileAbsolutePath } = ctx

      const store = storage('legacy').getStore()
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.rootDir)
      const testSourceFile = getTestSuitePath(
        testSourceFileAbsolutePath || testSuiteAbsolutePath,
        this.repositoryRoot
      )

      const testSuiteMetadata = {
        ...getTestSuiteCommonTags(
          this.command,
          this.frameworkVersion,
          testSuite,
          'playwright'
        ),
        ...this.getSessionRequestErrorTags(),
      }
      if (testSourceFile) {
        testSuiteMetadata[TEST_SOURCE_FILE] = testSourceFile
        testSuiteMetadata[TEST_SOURCE_START] = 1
      }
      const codeOwners = this.getCodeOwners(testSuiteMetadata)
      if (codeOwners) {
        testSuiteMetadata[TEST_CODE_OWNERS] = codeOwners
      }

      const testSuiteSpan = this.tracer.startSpan('playwright.test_suite', {
        childOf: this.testModuleSpan,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata,
        },
      })
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      ctx.parentStore = store
      ctx.currentStore = { ...store, testSuiteSpan }

      this._testSuiteSpansByTestSuiteAbsolutePath.set(testSuiteAbsolutePath, testSuiteSpan)

      return ctx.currentStore
    })

    this.addSub('ci:playwright:test-suite:finish', ({ testSuiteSpan, status, error }) => {
      if (!testSuiteSpan) return
      if (error) {
        testSuiteSpan.setTag('error', error)
        testSuiteSpan.setTag(TEST_STATUS, 'fail')
      } else {
        testSuiteSpan.setTag(TEST_STATUS, status)
      }

      if (status === 'fail' || error) {
        this.numFailedSuites++
      }

      testSuiteSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
    })

    this.addSub('ci:playwright:test:page-goto', (ctx) => {
      const activeSpan = storage('legacy').getStore()?.span
      if (!setRumTestCorrelation(ctx, activeSpan)) {
        log.error('ci:playwright:test:page-goto: test span not found')
      }
    })

    this.addSub('ci:playwright:worker:report', ({ serializedTraces, screenshots, videos }) => {
      const traces = JSON.parse(serializedTraces)
      const formattedTraces = []
      let formattedTestSpan

      for (const trace of traces) {
        const formattedTrace = []
        for (const span of trace) {
          const formattedSpan = {
            ...span,
            span_id: id(span.span_id),
            trace_id: id(span.trace_id),
            parent_id: id(span.parent_id),
          }
          if (span.meta[TEST_IS_NEW] === 'true' && DYNAMIC_NAME_RE.test(span.meta[TEST_NAME] || '')) {
            formattedSpan.meta[TEST_HAS_DYNAMIC_NAME] = 'true'
          }
          if (span.name === 'playwright.test') {
            formattedTestSpan = formattedSpan
            // TODO: remove this comment
            // TODO: Let's pass rootDir, repositoryRoot, command, session id and module id as env vars
            // so we don't need this re-serialization logic. This can be passed just once, since they're unique
            // for a test session. They can be passed the same way `DD_PLAYWRIGHT_WORKER` is passed.
            formattedSpan.meta[TEST_SESSION_ID] = this.testSessionSpan.context().toTraceId()
            formattedSpan.meta[TEST_MODULE_ID] = this.testModuleSpan.context().toSpanId()
            Object.assign(formattedSpan.meta, this.getSessionRequestErrorTags())
            formattedSpan.meta[TEST_FRAMEWORK_VERSION] = this.frameworkVersion
            formattedSpan.meta[TEST_MODULE] = this.constructor.id
            // MISSING _trace.startTime and _trace.ticks - because by now the suite is already serialized
            const testSuite = this._testSuiteSpansByTestSuiteAbsolutePath.get(
              formattedSpan.meta.test_suite_absolute_path
            )
            if (testSuite) {
              formattedSpan.meta[TEST_SUITE_ID] = testSuite.context().toSpanId()
            }
            // test_suite_absolute_path is just a hack because in the worker we don't have rootDir and repositoryRoot
            // but if we pass those the same way we pass `DD_PLAYWRIGHT_WORKER` this is not necessary
            const testSuitePath = getTestSuitePath(formattedSpan.meta.test_suite_absolute_path, this.rootDir)
            const testSourceAbsolutePath = formattedSpan.meta.test_source_absolute_path ||
              formattedSpan.meta.test_suite_absolute_path
            const testSourceFile = getTestSuitePath(testSourceAbsolutePath, this.repositoryRoot)
            // we need to rewrite this because this.rootDir and this.repositoryRoot are not available in the worker
            formattedSpan.meta[TEST_SUITE] = testSuitePath
            formattedSpan.meta[TEST_SOURCE_FILE] = testSourceFile
            formattedSpan.resource = `${testSuitePath}.${formattedSpan.meta[TEST_NAME]}`
            delete formattedSpan.meta.test_suite_absolute_path
            delete formattedSpan.meta.test_source_absolute_path
          }
          formattedTrace.push(formattedSpan)
        }
        formattedTraces.push(formattedTrace)
      }

      const exportTraces = () => {
        for (const trace of formattedTraces) {
          this.tracer._exporter.export(trace)
        }
      }

      if (!formattedTestSpan || (!screenshots && !videos) || this.#isFinalizingAfterError) {
        exportTraces()
        return
      }

      this.pendingTestFinishes++
      const abortController = new AbortController()
      const finishTest = (screenshotUploadResult, videoUploadResult) => {
        if (!this.#pendingTestFinishCallbacks.delete(finishTest)) return

        const screenshotUploadTag = getScreenshotUploadTag(screenshotUploadResult)
        if (screenshotUploadTag) {
          formattedTestSpan.meta[screenshotUploadTag] = 'true'
        }
        const videoUploadTag = getVideoUploadTag(videoUploadResult)
        if (videoUploadTag) {
          formattedTestSpan.meta[videoUploadTag] = 'true'
        }
        exportTraces()
        this.pendingTestFinishes--
        if (this.pendingTestFinishes === 0 && this.#finishPendingTestFinishes) {
          const finishPendingTestFinishes = this.#finishPendingTestFinishes
          this.#finishPendingTestFinishes = undefined
          finishPendingTestFinishes()
        }
      }
      const pendingTestFinish = {
        abortController,
        hasScreenshot: false,
        hasVideo: false,
      }
      this.#pendingTestFinishCallbacks.set(finishTest, pendingTestFinish)
      let pendingMedia = 0
      let screenshotUploadResult
      let videoUploadResult
      const finishMedia = () => {
        pendingMedia--
        if (pendingMedia === 0) finishTest(screenshotUploadResult, videoUploadResult)
      }
      const screenshotUploadStarted = this.uploadTestScreenshots({
        screenshots,
        traceId: formattedTestSpan.trace_id.toString(10),
        signal: abortController.signal,
      }, (uploadResult) => {
        screenshotUploadResult = uploadResult
        finishMedia()
      })
      if (screenshotUploadStarted) {
        pendingMedia++
        pendingTestFinish.hasScreenshot = true
      }
      const videoUploadStarted = this.uploadTestVideos({
        videos,
        traceId: formattedTestSpan.trace_id.toString(10),
        signal: abortController.signal,
      }, (uploadResult) => {
        videoUploadResult = uploadResult
        finishMedia()
      })
      if (videoUploadStarted) {
        pendingMedia++
        pendingTestFinish.hasVideo = true
      }
      if (pendingMedia > 0) return

      finishTest()
    })

    this.addBind('ci:playwright:test:start', (ctx) => {
      const {
        testName,
        testSuiteAbsolutePath,
        testSourceFileAbsolutePath,
        testSourceLine,
        browserName,
        isDisabled,
      } = ctx
      const store = storage('legacy').getStore()
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.rootDir)
      const testSourceFile = getTestSuitePath(
        testSourceFileAbsolutePath || testSuiteAbsolutePath,
        this.repositoryRoot
      )
      const span = this.startTestSpan(
        testName,
        testSuiteAbsolutePath,
        testSuite,
        testSourceFile,
        testSourceLine,
        browserName,
        testSourceFileAbsolutePath
      )

      if (isDisabled) {
        span.setTag(TEST_MANAGEMENT_IS_DISABLED, 'true')
      }

      ctx.parentStore = store
      ctx.currentStore = { ...store, span }

      return ctx.currentStore
    })

    this.addSub('ci:playwright:test:finish', ({
      span,
      testStatus,
      steps,
      error,
      extraTags,
      isNew,
      hasDynamicName,
      isEfdRetry,
      isRetry,
      isAttemptToFix,
      isDisabled,
      isQuarantined,
      isAttemptToFixRetry,
      hasFailedAllRetries,
      hasPassedAttemptToFixRetries,
      hasFailedAttemptToFixRetries,
      isAtrRetry,
      isModified,
      finalStatus,
      earlyFlakeAbortReason,
      onDone,
    }) => {
      if (!span) {
        onDone?.()
        return
      }

      const isRUMActive = span.context().getTag(TEST_IS_RUM_ACTIVE)

      span.setTag(TEST_STATUS, testStatus)

      if (error) {
        span.setTag('error', error)
      }
      if (extraTags) {
        span.addTags(extraTags)
      }
      if (isNew) {
        span.setTag(TEST_IS_NEW, 'true')
        if (isEfdRetry) {
          span.setTag(TEST_IS_RETRY, 'true')
          span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.efd)
        }
      }
      if (hasDynamicName) {
        span.setTag(TEST_HAS_DYNAMIC_NAME, 'true')
      }
      if (isRetry) {
        span.setTag(TEST_IS_RETRY, 'true')
        if (isAtrRetry) {
          span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atr)
        } else {
          span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.ext)
        }
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
      }
      if (hasPassedAttemptToFixRetries) {
        span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'true')
      } else if (hasFailedAttemptToFixRetries) {
        span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
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
      if (finalStatus) {
        span.setTag(TEST_FINAL_STATUS, finalStatus)
      }
      if (earlyFlakeAbortReason) {
        span.setTag(TEST_EARLY_FLAKE_ABORT_REASON, earlyFlakeAbortReason)
      }
      for (const step of steps) {
        const stepStartTime = step.startTime.getTime()
        const stepSpan = this.tracer.startSpan('playwright.step', {
          childOf: span,
          startTime: stepStartTime,
          tags: {
            [COMPONENT]: this.constructor.id,
            'playwright.step': step.title,
            [RESOURCE_NAME]: step.title,
          },
        })
        if (step.error) {
          stepSpan.setTag('error', step.error)
        }
        let stepDuration = step.duration
        if (stepDuration <= 0 || Number.isNaN(stepDuration)) {
          stepDuration = 0
        }
        stepSpan.finish(stepStartTime + stepDuration)
      }
      if (finalStatus === 'fail') {
        this.numFailedTests++
      }

      this.telemetry.ciVisEvent(
        TELEMETRY_EVENT_FINISHED,
        'test',
        {
          hasCodeOwners: !!span.context().getTag(TEST_CODE_OWNERS),
          isNew,
          isRum: isRUMActive === 'true' || undefined,
          browserDriver: 'playwright',
          isQuarantined,
          isDisabled,
          isModified,
        }
      )
      span.finish()

      finishAllTraceSpans(span)
      if (this._tracerConfig.DD_PLAYWRIGHT_WORKER) {
        try {
          this.tracer._exporter.flush(onDone)
        } catch (error) {
          // A synchronous flush failure must still release the worker, otherwise it hangs.
          // Log rather than rethrow: an exception from this diagnostics-channel subscriber
          // would surface as an uncaught error in the worker and crash the user's test run.
          onDone?.()
          log.error('Error flushing traces at Playwright worker shutdown', error)
        }
      }
    })

    this.addSub('ci:playwright:test:skip', ({
      testName,
      testSuiteAbsolutePath,
      testSourceFileAbsolutePath,
      testSourceLine,
      browserName,
      isNew,
      isAttemptToFix,
      isDisabled,
      isModified,
      isQuarantined,
    }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.rootDir)
      const testSourceFile = getTestSuitePath(
        testSourceFileAbsolutePath || testSuiteAbsolutePath,
        this.repositoryRoot
      )
      const span = this.startTestSpan(
        testName,
        testSuiteAbsolutePath,
        testSuite,
        testSourceFile,
        testSourceLine,
        browserName,
        testSourceFileAbsolutePath
      )

      span.setTag(TEST_STATUS, 'skip')
      span.setTag(TEST_FINAL_STATUS, 'skip')

      if (isNew) {
        span.setTag(TEST_IS_NEW, 'true')
      }
      if (isAttemptToFix) {
        span.setTag(TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX, 'true')
      }
      if (isDisabled) {
        span.setTag(TEST_MANAGEMENT_IS_DISABLED, 'true')
      }
      if (isModified) {
        span.setTag(TEST_IS_MODIFIED, 'true')
      }
      if (isQuarantined) {
        span.setTag(TEST_MANAGEMENT_IS_QUARANTINED, 'true')
      }

      span.finish()
    })
  }

  /**
   * Uploads automatic failure screenshots for a Playwright test attempt.
   *
   * @param {object} options - Upload options
   * @param {Array<object>} options.screenshots - Playwright test attachments
   * @param {string} options.traceId - Test trace id used as the screenshot key
   * @param {AbortSignal} options.signal - Signal used to cancel uploads during error finalization
   * @param {(result: string|undefined) => void} onDone - Completion callback
   * @returns {boolean} Whether at least one upload was started
   */
  uploadTestScreenshots ({ screenshots, traceId, signal }, onDone) {
    const exporter = this.tracer?._exporter
    if (!Array.isArray(screenshots) || !screenshots.length ||
      !exporter?.canUploadTestScreenshots?.() ||
      !exporter.uploadTestScreenshot) {
      return false
    }

    const screenshotPaths = new Set()
    for (const screenshot of screenshots) {
      if (isPlaywrightFailureScreenshot(screenshot)) {
        screenshotPaths.add(screenshot.path)
      }
    }
    if (!screenshotPaths.size) return false

    const uploadResults = new Array(screenshotPaths.size)
    let pendingUploads = screenshotPaths.size
    let index = 0
    for (const filePath of screenshotPaths) {
      const resultIndex = index++
      exporter.uploadTestScreenshot({
        filePath,
        traceId,
        idempotencyKey: `${traceId}:${basename(filePath)}`,
        capturedAtMs: getScreenshotCapturedAtMs(filePath, filePath),
        signal,
      }, (error, uploaded = true) => {
        if (uploaded) {
          uploadResults[resultIndex] = error
            ? SCREENSHOT_UPLOAD_RESULT_ERROR
            : SCREENSHOT_UPLOAD_RESULT_UPLOADED
        }
        pendingUploads--
        if (pendingUploads === 0) {
          const uploadResult = getScreenshotUploadResult(uploadResults)
          queueMicrotask(() => onDone(uploadResult))
        }
      })
    }
    return true
  }

  /**
   * Uploads failure videos for a Playwright test attempt.
   *
   * @param {object} options - Upload options
   * @param {Array<object>} options.videos - Playwright test attachments
   * @param {string} options.traceId - Test trace id used as the video key
   * @param {AbortSignal} options.signal - Signal used to cancel uploads during error finalization
   * @param {(result: string|undefined) => void} onDone - Completion callback
   * @returns {boolean} Whether at least one upload was started
   */
  uploadTestVideos ({ videos, traceId, signal }, onDone) {
    const exporter = this.tracer?._exporter
    if (!Array.isArray(videos) || !videos.length ||
      !exporter?.canUploadTestVideos?.() || !exporter.uploadTestVideo) {
      return false
    }

    const videoPaths = new Set()
    for (const video of videos) {
      if (isPlaywrightFailureVideo(video)) videoPaths.add(video.path)
    }
    if (!videoPaths.size) return false

    const uploadResults = new Array(videoPaths.size)
    let pendingUploads = videoPaths.size
    let index = 0
    for (const filePath of videoPaths) {
      const resultIndex = index++
      exporter.uploadTestVideo({
        filePath,
        traceId,
        idempotencyKey: `${traceId}:${basename(filePath)}`,
        capturedAtMs: Date.now(),
        signal,
      }, (error, uploaded = true) => {
        if (uploaded) {
          uploadResults[resultIndex] = error
            ? VIDEO_UPLOAD_RESULT_ERROR
            : VIDEO_UPLOAD_RESULT_UPLOADED
        }
        pendingUploads--
        if (pendingUploads === 0) {
          const uploadResult = getVideoUploadResult(uploadResults)
          queueMicrotask(() => onDone(uploadResult))
        }
      })
    }
    return true
  }

  // TODO: this runs both in worker and main process (main process: skipped tests that do not go through _runTest)
  startTestSpan (
    testName,
    testSuiteAbsolutePath,
    testSuite,
    testSourceFile,
    testSourceLine,
    browserName,
    testSourceFileAbsolutePath
  ) {
    const testSuiteSpan = this._testSuiteSpansByTestSuiteAbsolutePath.get(testSuiteAbsolutePath)

    const extraTags = {
      [TEST_SOURCE_START]: testSourceLine,
    }
    if (testSourceFile) {
      extraTags[TEST_SOURCE_FILE] = testSourceFile
    }
    if (browserName) {
      // Added as parameter too because it should affect the test fingerprint
      extraTags[TEST_PARAMETERS] = JSON.stringify({ arguments: { browser: browserName }, metadata: {} })
      extraTags[TEST_BROWSER_NAME] = browserName
    }

    extraTags.test_suite_absolute_path = testSuiteAbsolutePath
    if (testSourceFileAbsolutePath) {
      extraTags.test_source_absolute_path = testSourceFileAbsolutePath
    }

    return super.startTestSpan(testName, testSuite, testSuiteSpan, extraTags)
  }
}

module.exports = PlaywrightPlugin
