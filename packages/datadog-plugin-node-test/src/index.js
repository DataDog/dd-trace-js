'use strict'

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')
const { DD_MAJOR } = require('../../../version')

const {
  TEST_STATUS,
  TEST_SUITE,
  TEST_PARENT_TRACE_ID,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
  TEST_FINAL_STATUS,
  TEST_CODE_OWNERS,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_IS_MODIFIED,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_LEVEL_EVENT_TYPES,
  TEST_SESSION_NAME,
  finishAllTraceSpans,
  getLibraryCapabilitiesTags,
  getTestSessionName,
  getTestSuitePath,
  getTestSuiteCommonTags,
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
    this._testSpansByContext = new WeakMap()

    this.addBind('ci:node-test:test-suite:start', (ctx) => {
      const { testSuiteAbsolutePath, frameworkVersion, requestErrorTags } = ctx
      this.command = this.command || this._tracerConfig.DD_CIVISIBILITY_TEST_COMMAND
      this.frameworkVersion = this.frameworkVersion || frameworkVersion
      const testModuleParent = this.testModuleSpan || this.getWorkerTestModuleSpanContext()

      if (!testModuleParent) {
        return
      }

      this.addWorkerMetadata()

      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.sourceRoot)
      const testSuiteMetadata = {
        ...getTestSuiteCommonTags(this.command, this.frameworkVersion, testSuite, this.constructor.id),
        ...this.getSessionRequestErrorTags(),
        ...requestErrorTags,
        ...this.getSessionItrSkippingEnabledTags(),
        [TEST_SOURCE_FILE]: this.getTestSourceFile(testSuiteAbsolutePath, testSuite),
        [TEST_SOURCE_START]: 1,
      }

      const codeOwners = this.getCodeOwners(testSuiteMetadata)
      if (codeOwners) {
        testSuiteMetadata[TEST_CODE_OWNERS] = codeOwners
      }

      const testSuiteSpan = this.tracer.startSpan('node-test.test_suite', {
        childOf: testModuleParent,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata,
        },
        integrationName: this.constructor.id,
      })

      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      this._testSuiteSpansByTestSuite.set(testSuite, testSuiteSpan)

      const store = storage('legacy').getStore()
      ctx.parentStore = store
      ctx.currentStore = { ...store, testSuiteSpan }

      return ctx.currentStore
    })

    this.addSub('ci:node-test:test-suite:finish', ({ status, testSuiteAbsolutePath, onFinish }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.sourceRoot)
      const testSuiteSpan = this._testSuiteSpansByTestSuite.get(testSuite)

      if (testSuiteSpan) {
        testSuiteSpan.setTag(TEST_STATUS, status)
        testSuiteSpan.finish()
        finishAllTraceSpans(testSuiteSpan, [this.testSessionSpan, this.testModuleSpan])
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
        this._testSuiteSpansByTestSuite.delete(testSuite)
      }
      if (!this.testSessionSpan) {
        return this.tracer._exporter.flush(onFinish)
      }
      onFinish?.()
    })

    this.addBind('ci:node-test:test:start', (ctx) => {
      const {
        testName,
        testSuiteAbsolutePath,
        testStartLine,
        testContext,
        isRetry,
        isNew,
        isModified,
        isAttemptToFix,
        isDisabled,
        isQuarantined,
        retryReason,
        parentTestContext,
        requestErrorTags,
      } = ctx

      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.sourceRoot)
      const testSuiteSpan = this._testSuiteSpansByTestSuite.get(testSuite)
      const store = storage('legacy').getStore()
      const extraTags = {
        ...requestErrorTags,
        [TEST_SOURCE_FILE]: this.getTestSourceFile(testSuiteAbsolutePath, testSuite),
      }

      if (testStartLine) {
        extraTags[TEST_SOURCE_START] = testStartLine
      }
      if (isNew) {
        extraTags[TEST_IS_NEW] = 'true'
      }
      if (isModified) {
        extraTags[TEST_IS_MODIFIED] = 'true'
      }
      if (isAttemptToFix) {
        extraTags[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] = 'true'
      }
      if (isDisabled) {
        extraTags[TEST_MANAGEMENT_IS_DISABLED] = 'true'
      }
      if (isQuarantined) {
        extraTags[TEST_MANAGEMENT_IS_QUARANTINED] = 'true'
      }
      if (isRetry) {
        extraTags[TEST_IS_RETRY] = 'true'
        extraTags[TEST_RETRY_REASON] = retryReason || TEST_RETRY_REASON_TYPES.ext
      }
      if (parentTestContext && typeof parentTestContext === 'object') {
        const parentSpan = this._testSpansByContext.get(parentTestContext)
        if (parentSpan) {
          extraTags[TEST_PARENT_TRACE_ID] = parentSpan.context().toTraceId()
        }
      }

      const span = this.startTestSpan(testName, testSuite, testSuiteSpan, extraTags)

      ctx.parentStore = store
      ctx.currentStore = { ...store, span }
      this.activeTestSpan = span

      if (testContext && typeof testContext === 'object') {
        this._testSpansByContext.set(testContext, span)
      }

      return ctx.currentStore
    })

    this.addBind('ci:node-test:test:fn', (ctx) => {
      return ctx.currentStore
    })

    this.addSub('ci:node-test:test:finish', ({
      status,
      error,
      finalStatus,
      hasFailedAllRetries,
      attemptToFixPassed,
      attemptToFixFailed,
      testContext,
    }) => {
      const span = testContext && typeof testContext === 'object'
        ? this._testSpansByContext.get(testContext)
        : this.activeTestSpan

      if (!span || span.context()._isFinished) {
        return
      }

      span.setTag(TEST_STATUS, status)
      if (finalStatus) {
        span.setTag(TEST_FINAL_STATUS, finalStatus)
      }

      if (status === 'fail' && finalStatus === 'fail') {
        this.testSessionSpan?.setTag(TEST_STATUS, 'fail')
        this.testModuleSpan?.setTag(TEST_STATUS, 'fail')
        for (const testSuiteSpan of this._testSuiteSpansByTestSuite.values()) {
          testSuiteSpan.setTag(TEST_STATUS, 'fail')
        }
      }

      if (error) {
        span.setTag('error', error)
      }
      if (hasFailedAllRetries) {
        span.setTag(TEST_HAS_FAILED_ALL_RETRIES, 'true')
      }
      if (attemptToFixPassed) {
        span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'true')
      } else if (attemptToFixFailed) {
        span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
      }
      if (this.libraryConfig?.isTestManagementEnabled) {
        this.testSessionSpan?.setTag(TEST_MANAGEMENT_ENABLED, 'true')
      }
      if (this.libraryConfig?.isEarlyFlakeDetectionEnabled) {
        this.testSessionSpan?.setTag(TEST_EARLY_FLAKE_ENABLED, 'true')
      }

      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', this.getTestTelemetryTags(span))

      span.finish()
      finishAllTraceSpans(span, [
        this.testSessionSpan,
        this.testModuleSpan,
        this._testSuiteSpansByTestSuite.get(span.context()._tags[TEST_SUITE]),
      ])

      if (testContext && typeof testContext === 'object') {
        this._testSpansByContext.delete(testContext)
      }
      this.activeTestSpan = null

      if (!this.testSessionSpan) {
        this.tracer._exporter.flush()
      }
    })

    this.addSub('ci:node-test:worker-report:flush', () => {
      this.tracer._exporter.flush()
    })

    this.addSub('ci:node-test:session:finish', ({ status, error, onFinish }) => {
      if (!this.testSessionSpan || !this.testModuleSpan) {
        return onFinish?.()
      }

      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.setTag(TEST_STATUS, status)

      if (error) {
        this.testSessionSpan.setTag('error', error)
        this.testModuleSpan.setTag('error', error)
      }
      if (this.libraryConfig?.isTestManagementEnabled) {
        this.testSessionSpan.setTag(TEST_MANAGEMENT_ENABLED, 'true')
      }
      if (this.libraryConfig?.isEarlyFlakeDetectionEnabled) {
        this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ENABLED, 'true')
      }

      this.testModuleSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
      this.testSessionSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
      finishAllTraceSpans(this.testSessionSpan)
      this.telemetry.count(TELEMETRY_TEST_SESSION, {
        provider: this.ciProviderName,
        autoInjected: !!this._tracerConfig.DD_CIVISIBILITY_AUTO_INSTRUMENTATION_PROVIDER,
      })
      this.tracer._exporter.flush(onFinish)
    })
  }

  getWorkerTestModuleSpanContext () {
    const {
      DD_CIVISIBILITY_TEST_SESSION_ID: testSessionId,
      DD_CIVISIBILITY_TEST_MODULE_ID: testModuleId,
    } = this._tracerConfig

    if (!testSessionId || !testModuleId) {
      return
    }

    return this.tracer.extract('text_map', {
      'x-datadog-trace-id': testSessionId,
      'x-datadog-parent-id': testModuleId,
    })
  }

  addWorkerMetadata () {
    if (this.testSessionSpan || !this.tracer._exporter.addMetadataTags) {
      return
    }

    const trimmedCommand = DD_MAJOR < 6 ? this.command : 'node --test'
    const testSessionName = getTestSessionName(this.config, trimmedCommand, this.testEnvironmentMetadata)
    const metadataTags = {}

    for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
      metadataTags[testLevel] = {
        [TEST_SESSION_NAME]: testSessionName,
      }
    }
    metadataTags.test = {
      ...metadataTags.test,
      ...getLibraryCapabilitiesTags(this.constructor.id, this.frameworkVersion),
    }
    this.tracer._exporter.addMetadataTags(metadataTags)
  }

  getTestSourceFile (testSuiteAbsolutePath, testSuite) {
    return this.repositoryRoot !== this.sourceRoot && !!this.repositoryRoot
      ? getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      : testSuite
  }
}

module.exports = NodeTestPlugin
