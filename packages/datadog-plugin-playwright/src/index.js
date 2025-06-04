'use strict'

const { storage } = require('../../datadog-core')
const id = require('../../dd-trace/src/id')
const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')

const {
  TEST_STATUS,
  finishAllTraceSpans,
  getTestSuitePath,
  getTestSuiteCommonTags,
  TEST_SOURCE_START,
  TEST_CODE_OWNERS,
  TEST_SOURCE_FILE,
  TEST_PARAMETERS,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TELEMETRY_TEST_SESSION,
  TEST_RETRY_REASON,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_ENABLED,
  TEST_BROWSER_NAME,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_SESSION_ID,
  TEST_MODULE_ID,
  TEST_COMMAND,
  TEST_MODULE,
  TEST_SUITE,
  TEST_SUITE_ID,
  TEST_NAME,
  TEST_IS_RUM_ACTIVE,
  TEST_BROWSER_VERSION,
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED,
  isModifiedTest
} = require('../../dd-trace/src/plugins/util/test')
const { RESOURCE_NAME } = require('../../../ext/tags')
const { COMPONENT } = require('../../dd-trace/src/constants')
const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED
} = require('../../dd-trace/src/ci-visibility/telemetry')
const { appClosing: appClosingTelemetry } = require('../../dd-trace/src/telemetry')

class PlaywrightPlugin extends CiPlugin {
  static get id () {
    return 'playwright'
  }

  constructor (...args) {
    super(...args)

    this._testSuites = new Map()
    this.numFailedTests = 0
    this.numFailedSuites = 0

    this.addSub('ci:playwright:test:is-modified', ({
      filePath,
      modifiedTests,
      onDone
    }) => {
      const testSuite = getTestSuitePath(filePath, this.repositoryRoot)
      const isModified = isModifiedTest(testSuite, 0, 0, modifiedTests, this.constructor.id)
      onDone({ isModified })
    })

    this.addSub('ci:playwright:session:finish', ({
      status,
      isEarlyFlakeDetectionEnabled,
      isTestManagementTestsEnabled,
      onDone
    }) => {
      this.testModuleSpan.setTag(TEST_STATUS, status)
      this.testSessionSpan.setTag(TEST_STATUS, status)

      if (isEarlyFlakeDetectionEnabled) {
        this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ENABLED, 'true')
      }

      if (this.numFailedSuites > 0) {
        let errorMessage = `Test suites failed: ${this.numFailedSuites}.`
        if (this.numFailedTests > 0) {
          errorMessage += ` Tests failed: ${this.numFailedTests}`
        }
        const error = new Error(errorMessage)
        this.testModuleSpan.setTag('error', error)
        this.testSessionSpan.setTag('error', error)
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
        autoInjected: !!getEnvironmentVariable('DD_CIVISIBILITY_AUTO_INSTRUMENTATION_PROVIDER')
      })
      appClosingTelemetry()
      this.tracer._exporter.flush(onDone)
      this.numFailedTests = 0
    })

    this.addBind('ci:playwright:test-suite:start', (ctx) => {
      const { testSuiteAbsolutePath } = ctx

      const store = storage('legacy').getStore()
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.rootDir)
      const testSourceFile = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)

      const testSuiteMetadata = getTestSuiteCommonTags(
        this.command,
        this.frameworkVersion,
        testSuite,
        'playwright'
      )
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
          ...testSuiteMetadata
        }
      })
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      ctx.parentStore = store
      ctx.currentStore = { ...store, testSuiteSpan }

      this._testSuites.set(testSuiteAbsolutePath, testSuiteSpan)

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

    this.addSub('ci:playwright:test:page-goto', ({
      isRumActive,
      page
    }) => {
      const store = storage('legacy').getStore()
      const span = store && store.span
      if (!span) return

      if (isRumActive) {
        span.setTag(TEST_IS_RUM_ACTIVE, 'true')

        if (page) {
          const browserVersion = page.context().browser().version()

          if (browserVersion) {
            span.setTag(TEST_BROWSER_VERSION, browserVersion)
          }

          const url = page.url()
          const domain = new URL(url).hostname
          page.context().addCookies([{
            name: 'datadog-ci-visibility-test-execution-id',
            value: span.context().toTraceId(),
            domain,
            path: '/'
          }])
        }
      }
    })

    this.addBind('ci:playwright:test:start', (ctx) => {
      const {
        testName,
        testSuiteAbsolutePath,
        testSourceLine,
        browserName,
        isDisabled
      } = ctx
      const store = storage('legacy').getStore()
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.rootDir)
      const testSourceFile = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const span = this.startTestSpan(
        testName,
        testSuiteAbsolutePath,
        testSuite,
        testSourceFile,
        testSourceLine,
        browserName
      )

      if (isDisabled) {
        span.setTag(TEST_MANAGEMENT_IS_DISABLED, 'true')
      }

      ctx.parentStore = store
      ctx.currentStore = { ...store, span }

      return ctx.currentStore
    })

    this.addSub('ci:playwright:worker:report', (serializedTraces) => {
      const traces = JSON.parse(serializedTraces)
      const formattedTraces = []

      for (const trace of traces) {
        const formattedTrace = []
        for (const span of trace) {
          const formattedSpan = {
            ...span,
            span_id: id(span.span_id),
            trace_id: id(span.trace_id),
            parent_id: id(span.parent_id)
          }
          if (span.name === 'playwright.test') {
            // TODO: remove this comment
            // TODO: Let's pass rootDir, repositoryRoot, command, session id and module id as env vars
            // so we don't need this re-serialization logic. This can be passed just once, since they're unique
            // for a test session. They can be passed the same way `DD_PLAYWRIGHT_WORKER` is passed.
            formattedSpan.meta[TEST_SESSION_ID] = this.testSessionSpan.context().toTraceId()
            formattedSpan.meta[TEST_MODULE_ID] = this.testModuleSpan.context().toSpanId()
            formattedSpan.meta[TEST_COMMAND] = this.command
            formattedSpan.meta[TEST_MODULE] = this.constructor.id
            // MISSING _trace.startTime and _trace.ticks - because by now the suite is already serialized
            const testSuite = this._testSuites.get(formattedSpan.meta.test_suite_absolute_path)
            if (testSuite) {
              formattedSpan.meta[TEST_SUITE_ID] = testSuite.context().toSpanId()
            }
            // test_suite_absolute_path is just a hack because in the worker we don't have rootDir and repositoryRoot
            // but if we pass those the same way we pass `DD_PLAYWRIGHT_WORKER` this is not necessary
            const testSuitePath = getTestSuitePath(formattedSpan.meta.test_suite_absolute_path, this.rootDir)
            const testSourceFile = getTestSuitePath(formattedSpan.meta.test_suite_absolute_path, this.repositoryRoot)
            // we need to rewrite this because this.rootDir and this.repositoryRoot are not available in the worker
            formattedSpan.meta[TEST_SUITE] = testSuitePath
            formattedSpan.meta[TEST_SOURCE_FILE] = testSourceFile
            formattedSpan.resource = `${testSuitePath}.${formattedSpan.meta[TEST_NAME]}`
            delete formattedSpan.meta.test_suite_absolute_path
          }
          formattedTrace.push(formattedSpan)
        }
        formattedTraces.push(formattedTrace)
      }

      formattedTraces.forEach(trace => {
        this.tracer._exporter.export(trace)
      })
    })

    this.addSub('ci:playwright:test:finish', ({
      span,
      testStatus,
      steps,
      error,
      extraTags,
      isNew,
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
      onDone
    }) => {
      if (!span) return

      const isRUMActive = span.context()._tags[TEST_IS_RUM_ACTIVE]

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
        let stepDuration = step.duration
        if (stepDuration <= 0 || Number.isNaN(stepDuration)) {
          stepDuration = 0
        }
        stepSpan.finish(stepStartTime + stepDuration)
      })
      if (testStatus === 'fail') {
        this.numFailedTests++
      }

      this.telemetry.ciVisEvent(
        TELEMETRY_EVENT_FINISHED,
        'test',
        {
          hasCodeOwners: !!span.context()._tags[TEST_CODE_OWNERS],
          isNew,
          isRum: isRUMActive,
          browserDriver: 'playwright'
        }
      )
      span.finish()

      finishAllTraceSpans(span)
      if (getEnvironmentVariable('DD_PLAYWRIGHT_WORKER')) {
        this.tracer._exporter.flush(onDone)
      }
    })
  }

  // TODO: this runs both in worker and main process (main process: skipped tests that do not go through _runTest)
  startTestSpan (testName, testSuiteAbsolutePath, testSuite, testSourceFile, testSourceLine, browserName) {
    const testSuiteSpan = this._testSuites.get(testSuiteAbsolutePath)

    const extraTags = {
      [TEST_SOURCE_START]: testSourceLine
    }
    if (testSourceFile) {
      extraTags[TEST_SOURCE_FILE] = testSourceFile || testSuite
    }
    if (browserName) {
      // Added as parameter too because it should affect the test fingerprint
      extraTags[TEST_PARAMETERS] = JSON.stringify({ arguments: { browser: browserName }, metadata: {} })
      extraTags[TEST_BROWSER_NAME] = browserName
    }

    extraTags.test_suite_absolute_path = testSuiteAbsolutePath

    return super.startTestSpan(testName, testSuite, testSuiteSpan, extraTags)
  }
}

module.exports = PlaywrightPlugin
