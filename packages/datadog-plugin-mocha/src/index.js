'use strict'

const { performance } = require('node:perf_hooks')
const { fileURLToPath } = require('node:url')

const { channel } = require('dc-polyfill')

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')
const {
  getEfdRetryCountForDuration,
  hasEfdRetries,
} = require('../../dd-trace/src/ci-visibility/efd-retry-policy')
const log = require('../../dd-trace/src/log')
const {
  sendWebdriverioWorkerMessage,
  SUITE_FINISH,
} = require('../../datadog-instrumentations/src/mocha/webdriverio-protocol')

const {
  TEST_STATUS,
  TEST_PARAMETERS,
  finishAllTraceSpans,
  getTestSuitePath,
  getRelativeCoverageFiles,
  getTestParametersString,
  getTestSuiteCommonTags,
  addIntelligentTestRunnerSpanTags,
  TEST_SOURCE_START,
  TEST_ITR_UNSKIPPABLE,
  TEST_ITR_FORCED_RUN,
  TEST_CODE_OWNERS,
  ITR_CORRELATION_ID,
  TEST_SOURCE_FILE,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  MOCHA_IS_PARALLEL,
  TEST_RETRY_REASON,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED,
  TEST_FINAL_STATUS,
  TEST_HAS_DYNAMIC_NAME,
  TEST_FRAMEWORK_ADAPTER,
  DYNAMIC_NAME_RE,
  getFailedTestReplayPromise,
  getTestSuiteExecutionKey,
  isModifiedTest,
  setRumTestCorrelation,
  TEST_BROWSER_NAME,
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
  TELEMETRY_CODE_COVERAGE_NUM_FILES,
  TELEMETRY_TEST_SESSION,
} = require('../../dd-trace/src/ci-visibility/telemetry')

const jasmineAdapterRunAsyncEndCh = 'tracing:orchestrion:@wdio/jasmine-framework:JasmineAdapter_run:asyncEnd'
const jasmineDoneCh = 'ci:webdriverio:jasmine:done'
const jasmineExecuteAsyncEndCh = 'tracing:orchestrion:@wdio/utils:executeAsync:asyncEnd'
const jasmineExecuteAsyncErrorCh = 'tracing:orchestrion:@wdio/utils:executeAsync:error'
const jasmineExecuteAsyncStartCh = 'tracing:orchestrion:@wdio/utils:executeAsync:start'
const jasmineReporterSpecDoneEndCh = 'tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end'
const jasmineReporterSpecDoneStartCh = 'tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:start'
const jasmineReporterSpecStartedEndCh = 'tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specStarted:end'
const jasmineReporterSuiteDoneEndCh = 'tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_suiteDone:end'
const jasmineReporterSuiteStartedEndCh = 'tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_suiteStarted:end'
const jasmineSpecAttemptDoneEndCh = 'tracing:orchestrion:jasmine-core:Spec_attemptDone:end'
const jasmineSpecExecuteStartCh = 'tracing:orchestrion:jasmine-core:Spec_execute:start'
const jasmineTestFunctionStartCh = 'tracing:orchestrion:@wdio/utils:testFrameworkFnWrapper:start'
const testFinishCh = channel('ci:mocha:test:finish')
const testRetryCh = channel('ci:mocha:test:retry')
const WEBDRIVERIO_JASMINE_ADAPTER = 'jasmine'
const workerFinishCh = channel('ci:mocha:worker:finish')
const WEBDRIVERIO_JASMINE_FAILED_EXPECTATION_COUNT = Symbol('webdriverioJasmineFailedExpectationCount')
const WEBDRIVERIO_JASMINE_FUNCTION_TYPE = Symbol('webdriverioJasmineFunctionType')
const WEBDRIVERIO_JASMINE_TEST = Symbol('webdriverioJasmineTest')

/** @typedef {{done: boolean, value?: unknown}} RumGeneratorStep */
/**
 * @typedef {object} RumGenerator
 * @property {(value?: unknown) => RumGeneratorStep} next
 * @property {(error: unknown) => RumGeneratorStep} throw
 */

/**
 * @typedef {object} WebdriverioJasmineResult
 * @property {string|undefined} id
 * @property {string|undefined} description
 * @property {Array<{message?: string, stack?: string}>|undefined} failedExpectations
 * @property {string|undefined} file
 * @property {string|undefined} filename
 * @property {string|undefined} fullName
 * @property {string|undefined} parentSuiteId
 * @property {string|undefined} status
 */

/**
 * Normalizes a WebdriverIO Jasmine spec identifier to a filesystem path.
 *
 * @param {string|undefined} file
 * @returns {string|undefined}
 */
function normalizeJasmineFile (file) {
  return file?.startsWith('file://') ? fileURLToPath(file) : file
}

/**
 * Maps a Jasmine result status to the Test Optimization status vocabulary.
 *
 * @param {string|undefined} status
 * @returns {'pass'|'fail'|'skip'}
 */
function getJasmineStatus (status) {
  if (status === 'passed') return 'pass'
  if (status === 'failed') return 'fail'
  return 'skip'
}

/**
 * Converts Jasmine's failed-expectation shape to an Error.
 *
 * @param {WebdriverioJasmineResult} result
 * @returns {Error|undefined}
 */
function getJasmineError (result) {
  const failedExpectation = result.failedExpectations?.[0]
  if (!failedExpectation) return

  const error = new Error(failedExpectation.message)
  if (failedExpectation.stack) {
    error.stack = failedExpectation.stack
  }
  return error
}

/**
 * Resolves the spec file responsible for a run-level Jasmine failure.
 *
 * @param {WebdriverioJasmineResult|undefined} result
 * @param {string[]} specs
 * @returns {string|undefined}
 */
function getJasmineFailureFile (result, specs) {
  const resultFile = normalizeJasmineFile(result?.file || result?.filename)
  if (resultFile) {
    return resultFile
  }

  const stack = result?.failedExpectations?.[0]?.stack
  if (stack) {
    for (const spec of specs) {
      const file = normalizeJasmineFile(spec)
      if (file && stack.includes(file)) {
        return file
      }
    }
  }

  return specs.length === 1 ? normalizeJasmineFile(specs[0]) : undefined
}

class MochaPlugin extends CiPlugin {
  static id = 'mocha'

  constructor (...args) {
    super(...args)

    this._testTitleToParams = {}
    this.sourceRoot = process.cwd()

    this.addSub('ci:mocha:worker:configuration', ({
      libraryConfig,
      repositoryRoot,
      specs,
      testFramework,
      testFrameworkAdapter,
    }) => {
      this.libraryConfig = libraryConfig
      this.testFramework = testFramework
      this.testFrameworkAdapter = testFrameworkAdapter
      this._setRepositoryRoot(repositoryRoot)
      if (testFrameworkAdapter === WEBDRIVERIO_JASMINE_ADAPTER) {
        this._webdriverioJasmineState = {
          completedTestStatuses: new Map(),
          currentResult: undefined,
          pendingTestFinishCallbacks: [],
          pendingTestFinishes: 0,
          specs: specs || [],
          suiteErrors: new Map(),
          suiteFiles: new Map(),
          suiteStatuses: new Map(),
          tests: new Map(),
        }
      }
    })

    this.addSub('ci:webdriverio:rum:page-navigate', (ctx) => {
      if (this.testFramework !== 'webdriverio') return

      const activeSpan = storage('legacy').getStore()?.span
      const testSpan = setRumTestCorrelation(ctx, activeSpan)
      if (!testSpan) {
        log.error('ci:webdriverio:rum:page-navigate: test span not found')
        return
      }
      if (ctx.browserName) {
        testSpan.setTag(TEST_BROWSER_NAME, ctx.browserName)
      }
    })

    this.addBind(jasmineTestFunctionStartCh, (ctx) => {
      if (this.testFrameworkAdapter !== WEBDRIVERIO_JASMINE_ADAPTER) {
        return storage('legacy').getStore()
      }

      const result = this._webdriverioJasmineState?.currentResult
      const type = ctx.arguments?.[1]
      if (type === 'Test' || (type === 'Hook' && result)) {
        return this.#configureWebdriverioJasmineFunction(ctx, result, type)
      }
      return storage('legacy').getStore()
    })

    this.addBind(jasmineExecuteAsyncStartCh, (ctx) => {
      const currentStore = storage('legacy').getStore()
      const test = currentStore?.[WEBDRIVERIO_JASMINE_TEST]
      if (this.testFrameworkAdapter !== WEBDRIVERIO_JASMINE_ADAPTER || !test) {
        return currentStore
      }

      const functionType = currentStore[WEBDRIVERIO_JASMINE_FUNCTION_TYPE]
      if (functionType === 'Test') {
        ctx.retryGenerator = this.#retryWebdriverioJasmineTestAfterRumCleanup.bind(this, ctx, test)
      }
      const nextStore = {
        ...test.currentStore,
        [WEBDRIVERIO_JASMINE_FUNCTION_TYPE]: functionType,
      }
      if (functionType === 'Hook') {
        nextStore[WEBDRIVERIO_JASMINE_FAILED_EXPECTATION_COUNT] =
          this._webdriverioJasmineState.currentResult?.failedExpectations?.length || 0
      }
      return nextStore
    })

    this.addBind(jasmineSpecExecuteStartCh, (ctx) => {
      if (this.testFrameworkAdapter !== WEBDRIVERIO_JASMINE_ADAPTER) {
        return storage('legacy').getStore()
      }

      this.#configureWebdriverioJasmineLifecycle(ctx)
      return storage('legacy').getStore()
    })

    this.addSub(jasmineSpecAttemptDoneEndCh, (ctx) => {
      if (this.testFrameworkAdapter !== WEBDRIVERIO_JASMINE_ADAPTER) {
        return
      }

      const status = typeof ctx.result === 'string' ? ctx.result : ctx.self?.result?.status
      const runnerStatus = this.#prepareWebdriverioJasmineAttempt(ctx.self, status)
      if (typeof ctx.result === 'string') {
        ctx.result = runnerStatus
      } else if (ctx.self?.result) {
        ctx.self.result.status = runnerStatus
      }
    })

    this.addSub(jasmineExecuteAsyncErrorCh, (ctx) => {
      const currentStore = ctx.currentStore || storage('legacy').getStore()
      const test = currentStore?.[WEBDRIVERIO_JASMINE_TEST]
      if (
        this.testFrameworkAdapter === WEBDRIVERIO_JASMINE_ADAPTER &&
        test &&
        currentStore[WEBDRIVERIO_JASMINE_FUNCTION_TYPE] === 'Hook'
      ) {
        test.hasFinalHookFailure = true
      }
    })

    this.addSub(jasmineExecuteAsyncEndCh, (ctx) => {
      const currentStore = ctx.currentStore || storage('legacy').getStore()
      const test = currentStore?.[WEBDRIVERIO_JASMINE_TEST]
      const failedExpectationCount = currentStore?.[WEBDRIVERIO_JASMINE_FAILED_EXPECTATION_COUNT]
      if (
        this.testFrameworkAdapter === WEBDRIVERIO_JASMINE_ADAPTER &&
        test &&
        currentStore[WEBDRIVERIO_JASMINE_FUNCTION_TYPE] === 'Hook' &&
        this._webdriverioJasmineState.currentResult?.failedExpectations?.length > failedExpectationCount
      ) {
        test.hasFinalHookFailure = true
      }
    })

    this.addSub(jasmineReporterSuiteStartedEndCh, (ctx) => {
      if (this.testFrameworkAdapter === WEBDRIVERIO_JASMINE_ADAPTER) {
        const suite = ctx.arguments?.[0]
        const file = normalizeJasmineFile(suite?.filename)
        if (suite?.id && file) {
          this._webdriverioJasmineState.suiteFiles.set(suite.id, file)
        }
      }
    })

    this.addSub(jasmineReporterSuiteDoneEndCh, (ctx) => {
      if (this.testFrameworkAdapter === WEBDRIVERIO_JASMINE_ADAPTER) {
        const state = this._webdriverioJasmineState
        const suite = ctx.arguments?.[0]
        const error = suite && getJasmineError(suite)
        const file = normalizeJasmineFile(
          suite?.filename ||
          state.suiteFiles.get(suite?.id) ||
          (state.specs.length === 1 ? state.specs[0] : undefined)
        )
        if (error && file) {
          state.suiteErrors.set(file, error)
          state.suiteStatuses.set(file, 'fail')
        }
      }
    })

    this.addSub(jasmineDoneCh, ({ result } = {}) => {
      if (this.testFrameworkAdapter === WEBDRIVERIO_JASMINE_ADAPTER) {
        const state = this._webdriverioJasmineState
        const error = result && getJasmineError(result)
        const file = getJasmineFailureFile(result, state.specs)
        if (error && file) {
          state.suiteErrors.set(file, error)
          state.suiteStatuses.set(file, 'fail')
        }
      }
    })

    this.addSub(jasmineReporterSpecStartedEndCh, (ctx) => {
      if (this.testFrameworkAdapter === WEBDRIVERIO_JASMINE_ADAPTER) {
        this._webdriverioJasmineState.currentResult = ctx.arguments?.[0]
        this.#startWebdriverioJasmineTest(ctx.arguments?.[0], ctx.self?._specs, ctx.self?.startedSuite)
      }
    })

    this.addBind(jasmineReporterSpecDoneStartCh, (ctx) => {
      if (this.testFrameworkAdapter !== WEBDRIVERIO_JASMINE_ADAPTER) {
        return storage('legacy').getStore()
      }

      const result = ctx.arguments?.[0]
      const test = this._webdriverioJasmineState?.tests.get(result?.id)
      const recoveredEarlyFlakeDetection = test?.isEarlyFlakeDetection &&
        !test.hasFinalHookFailure && test.statuses.includes('pass')
      if (
        result.status === 'failed' &&
        ((test?.isQuarantined && !test.isAttemptToFix) || recoveredEarlyFlakeDetection)
      ) {
        test.reportedStatus = result.status
        result.status = 'passed'
      }
      return test?.currentStore || storage('legacy').getStore()
    })

    this.addSub(jasmineReporterSpecDoneEndCh, (ctx) => {
      if (this.testFrameworkAdapter === WEBDRIVERIO_JASMINE_ADAPTER) {
        const result = ctx.result
        const finishPromise = this.#finishWebdriverioJasmineTest(ctx.arguments?.[0], ctx.self?._specs)
        if (finishPromise) {
          ctx.result = finishPromise.then(() => result)
        }
      }
    })

    this.addSub(jasmineAdapterRunAsyncEndCh, (ctx) => {
      if (this.testFrameworkAdapter === WEBDRIVERIO_JASMINE_ADAPTER) {
        this.#finishWebdriverioJasmineWorker(ctx)
      }
    })

    this.addSub('ci:mocha:test-suite:code-coverage', ({ coverageFiles, suiteFile }) => {
      if (!this.libraryConfig?.isCodeCoverageEnabled) {
        return
      }
      const testSuite = getTestSuitePath(suiteFile, this.sourceRoot)
      const testSuiteSpan = this._testSuiteSpansByTestSuite.get(testSuite)

      if (!coverageFiles.length) {
        this.telemetry.count(TELEMETRY_CODE_COVERAGE_EMPTY)
      }

      const relativeCoverageFiles = [
        ...getRelativeCoverageFiles(coverageFiles, this.repositoryRoot || this.sourceRoot),
        getTestSuitePath(suiteFile, this.repositoryRoot || this.sourceRoot),
      ]

      const { _traceId, _spanId } = testSuiteSpan.context()

      const formattedCoverage = {
        sessionId: _traceId,
        suiteId: _spanId,
        files: relativeCoverageFiles,
      }

      this.tracer._exporter.exportCoverage(formattedCoverage)
      this.telemetry.ciVisEvent(TELEMETRY_CODE_COVERAGE_FINISHED, 'suite', { library: 'istanbul' })
      this.telemetry.distribution(TELEMETRY_CODE_COVERAGE_NUM_FILES, {}, relativeCoverageFiles.length)
    })

    this.addBind('ci:mocha:test-suite:start', (ctx) => {
      const {
        testSuiteAbsolutePath,
        testSuiteExecutionId,
        isUnskippable,
        isForcedToRun,
        itrCorrelationId,
      } = ctx

      // If the test module span is undefined, the plugin has not been initialized correctly and we bail out
      if (!this.testModuleSpan) {
        return
      }
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.sourceRoot)
      const testFramework = this.testFramework || this.constructor.id
      const testSuiteMetadata = {
        ...getTestSuiteCommonTags(
          this.command,
          this.frameworkVersion,
          testSuite,
          testFramework
        ),
        ...this.getSessionRequestErrorTags(),
        ...this.getSessionItrSkippingEnabledTags(),
      }
      if (this.testFrameworkAdapter) {
        testSuiteMetadata[TEST_FRAMEWORK_ADAPTER] = this.testFrameworkAdapter
      }
      if (isUnskippable) {
        testSuiteMetadata[TEST_ITR_UNSKIPPABLE] = 'true'
        this.telemetry.count(TELEMETRY_ITR_UNSKIPPABLE, { testLevel: 'suite' })
      }
      if (isForcedToRun) {
        testSuiteMetadata[TEST_ITR_FORCED_RUN] = 'true'
        this.telemetry.count(TELEMETRY_ITR_FORCED_TO_RUN, { testLevel: 'suite' })
      }
      testSuiteMetadata[TEST_SOURCE_FILE] = this.repositoryRoot !== this.sourceRoot && !!this.repositoryRoot
        ? getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
        : testSuite
      if (testSuiteMetadata[TEST_SOURCE_FILE]) {
        testSuiteMetadata[TEST_SOURCE_START] = 1
      }

      const codeOwners = this.getCodeOwners(testSuiteMetadata)
      if (codeOwners) {
        testSuiteMetadata[TEST_CODE_OWNERS] = codeOwners
      }

      const testSuiteSpan = this.tracer.startSpan('mocha.test_suite', {
        childOf: this.testModuleSpan,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata,
        },
        integrationName: this.constructor.id,
      })
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      if (this.libraryConfig?.isCodeCoverageEnabled) {
        this.telemetry.ciVisEvent(TELEMETRY_CODE_COVERAGE_STARTED, 'suite', { library: 'istanbul' })
      }
      if (itrCorrelationId) {
        testSuiteSpan.setTag(ITR_CORRELATION_ID, itrCorrelationId)
      }
      const store = storage('legacy').getStore()
      ctx.parentStore = store
      ctx.currentStore = { ...store, testSuiteSpan }
      const testSuiteKey = getTestSuiteExecutionKey(testSuite, testSuiteExecutionId)
      this._testSuiteSpansByTestSuite.set(testSuiteKey, testSuiteSpan)
      this._exportPendingWorkerTracesForTestSuite(testSuiteKey)
    })

    this.addSub('ci:mocha:test-suite:finish', ({ testSuiteSpan, status }) => {
      if (testSuiteSpan) {
        // the test status of the suite may have been set in ci:mocha:test-suite:error already
        if (!testSuiteSpan.context().getTag(TEST_STATUS)) {
          testSuiteSpan.setTag(TEST_STATUS, status)
        }
        testSuiteSpan.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
      }
    })

    this.addBind('ci:mocha:test-suite:error', (ctx) => {
      const { error } = ctx
      const testSuiteSpan = ctx.currentStore?.testSuiteSpan

      if (testSuiteSpan) {
        testSuiteSpan.setTag('error', error)
        testSuiteSpan.setTag(TEST_STATUS, 'fail')

        ctx.parentStore = ctx.currentStore
        ctx.currentStore = { ...ctx.currentStore, testSuiteSpan }
      }

      return ctx.currentStore
    })

    this.addSub('ci:mocha:test:is-modified', ({ modifiedFiles, file, onDone }) => {
      const testPath = getTestSuitePath(file, this.repositoryRoot)
      const isModified = isModifiedTest(
        testPath,
        null,
        null,
        modifiedFiles,
        this.constructor.id
      )

      onDone(isModified)
    })

    this.addBind('ci:mocha:test:fn', (ctx) => {
      return ctx.currentStore
    })

    this.addBind('ci:mocha:test:start', (ctx) => {
      const store = storage('legacy').getStore()
      const span = this.startTestSpan(ctx)

      ctx.parentStore = store
      ctx.currentStore = { ...store, span }

      this.activeTestSpan = span

      return ctx.currentStore
    })

    this.addSub('ci:mocha:worker:finish', ({ onDone } = {}) => {
      this.tracer._exporter.flush(onDone)
    })

    this.addSub('ci:mocha:test:finish', ({
      span,
      status,
      hasBeenRetried,
      isLastRetry,
      hasFailedAllRetries,
      attemptToFixPassed,
      attemptToFixFailed,
      isAttemptToFixRetry,
      isAtrRetry,
      finalStatus,
      earlyFlakeAbortReason,
    }) => {
      if (span) {
        span.setTag(TEST_STATUS, status)
        if (finalStatus) {
          span.setTag(TEST_FINAL_STATUS, finalStatus)
        }
        if (earlyFlakeAbortReason) {
          span.setTag(TEST_EARLY_FLAKE_ABORT_REASON, earlyFlakeAbortReason)
        }
        if (hasBeenRetried) {
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
        if (attemptToFixPassed) {
          span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'true')
        } else if (attemptToFixFailed) {
          span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
        }
        if (isAttemptToFixRetry) {
          span.setTag(TEST_IS_RETRY, 'true')
          span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atf)
        }

        this.telemetry.ciVisEvent(
          TELEMETRY_EVENT_FINISHED,
          'test',
          this.getTestTelemetryTags(span)
        )

        span.finish()
        finishAllTraceSpans(span)
        this.activeTestSpan = null
        this.cancelDiBreakpointHitWait()
        if (this.di && this.libraryConfig?.isDiEnabled && this.runningTestProbe && isLastRetry) {
          this.removeDiProbe(this.runningTestProbe)
          this.runningTestProbe = null
        }
      }
    })

    this.addBind('ci:mocha:test:skip', (ctx) => {
      const store = storage('legacy').getStore()
      // skipped through it.skip, so the span is not created yet
      // for this test
      if (!store) {
        const span = this.startTestSpan(ctx)

        ctx.parentStore = store
        ctx.currentStore = { ...store, span }

        this.activeTestSpan = span
      }

      return ctx.currentStore
    })

    this.addBind('ci:mocha:test:error', (ctx) => {
      const { err } = ctx
      const span = ctx.currentStore?.span

      if (err && span) {
        if (err.constructor.name === 'Pending' && !this.forbidPending) {
          span.setTag(TEST_STATUS, 'skip')
        } else {
          span.setTag(TEST_STATUS, 'fail')
          span.setTag('error', err)
        }

        ctx.parentStore = ctx.currentStore
        ctx.currentStore = { ...ctx.currentStore, span }

        this.activeTestSpan = span
      }

      return ctx.currentStore
    })

    this.addSub('ci:mocha:test:retry', ({
      span,
      isFirstAttempt,
      isFirstFailure = isFirstAttempt,
      willBeRetried,
      err,
      test,
      isAttemptToFixRetry,
      isAtrRetry,
      isEfdRetry,
      promises,
    }) => {
      if (span) {
        const finishSpan = () => {
          span.finish()
          finishAllTraceSpans(span)
          if (this.activeTestSpan === span) {
            this.activeTestSpan = null
          }
        }

        span.setTag(TEST_STATUS, 'fail')
        if (!isFirstAttempt) {
          span.setTag(TEST_IS_RETRY, 'true')
          if (isAttemptToFixRetry) {
            span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atf)
          } else if (isAtrRetry) {
            span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atr)
          } else if (isEfdRetry) {
            span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.efd)
          } else {
            span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.ext)
          }
        }
        if (err) {
          span.setTag('error', err)
        }

        this.telemetry.ciVisEvent(
          TELEMETRY_EVENT_FINISHED,
          'test',
          this.getTestTelemetryTags(span)
        )
        if (isFirstFailure && willBeRetried && this.di && this.libraryConfig?.isDiEnabled) {
          const probeInformation = this.addDiProbe(err)
          if (probeInformation) {
            const { file, line, stackIndex, setProbePromise } = probeInformation
            this.runningTestProbe = { file, line }
            this.testErrorStackIndex = stackIndex
            test._ddShouldWaitForHitProbe = true
            this.prepareDiBreakpointHitWait()
            if (promises) {
              promises.setProbePromise = this.waitForDiOperation(setProbePromise)
            }
          }
        }

        if (!isFirstFailure &&
          willBeRetried &&
          this.di &&
          this.libraryConfig?.isDiEnabled &&
          this.runningTestProbe &&
          promises) {
          promises.finishTestPromise = this.waitForInFlightDiBreakpointHits().then(finishSpan, finishSpan)
          return
        }

        finishSpan()
      }
    })

    this.addSub('ci:mocha:test:di:wait', ({ promises }) => {
      if (this.di) {
        promises.hitBreakpointPromise = this.waitForDiBreakpointHits()
      }
    })

    this.addSub('ci:mocha:test:parameterize', ({ title, params }) => {
      this._testTitleToParams[title] = params
    })

    this.addSub('ci:mocha:session:finish', ({
      status,
      isSuitesSkipped,
      testCodeCoverageLinesTotal,
      testSessionCoverageFiles,
      numSkippedSuites,
      hasForcedToRunSuites,
      hasUnskippableSuites,
      error,
      isEarlyFlakeDetectionEnabled,
      isEarlyFlakeDetectionFaulty,
      isTestManagementEnabled,
      isParallel,
      isFrameworkError,
      onDone,
    }) => {
      this._exportPendingWorkerTraces()
      if (this.testSessionSpan) {
        const {
          isSuitesSkippingEnabled,
          isCodeCoverageEnabled,
          isCoverageReportUploadEnabled,
        } = this.libraryConfig || {}
        this.testSessionSpan.setTag(TEST_STATUS, status)
        this.testModuleSpan.setTag(TEST_STATUS, status)

        if (error) {
          this.testSessionSpan.setTag('error', error)
          this.testModuleSpan.setTag('error', error)
          if (isFrameworkError) {
            for (const testSuiteSpan of this._testSuiteSpansByTestSuite.values()) {
              testSuiteSpan.setTag(TEST_STATUS, 'fail')
              testSuiteSpan.setTag('error', error)
            }
          }
        }

        if (isParallel) {
          this.testSessionSpan.setTag(MOCHA_IS_PARALLEL, 'true')
        }

        if (isTestManagementEnabled) {
          this.testSessionSpan.setTag(TEST_MANAGEMENT_ENABLED, 'true')
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
            hasUnskippableSuites,
          }
        )

        if (testSessionCoverageFiles?.length && isCoverageReportUploadEnabled) {
          this.tracer._exporter.exportCoverage({
            sessionId: this.testSessionSpan.context()._traceId,
            files: testSessionCoverageFiles,
          })
        }

        if (isEarlyFlakeDetectionEnabled) {
          this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ENABLED, 'true')
        }
        if (isEarlyFlakeDetectionFaulty) {
          this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ABORT_REASON, 'faulty')
        }

        this.testModuleSpan.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
        this.testSessionSpan.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session', {
          hasFailedTestReplay: this.libraryConfig?.isDiEnabled || undefined,
        })
        finishAllTraceSpans(this.testSessionSpan)
        this.telemetry.count(TELEMETRY_TEST_SESSION, {
          provider: this.ciProviderName,
          autoInjected: !!this._tracerConfig.testOptimization.DD_CIVISIBILITY_AUTO_INSTRUMENTATION_PROVIDER,
        })
      }
      this.libraryConfig = null
      this.tracer._exporter.flush(onDone)
    })

    this.addBind('ci:mocha:global:run', (ctx) => {
      return ctx.currentStore
    })
  }

  /**
   * Starts a Jasmine test span around WebdriverIO's test-function wrapper.
   *
   * @param {WebdriverioJasmineResult|undefined} result
   * @param {string[]} [specs]
   * @param {{filename?: string}|undefined} currentSuite
   * @returns {object|undefined}
   */
  #startWebdriverioJasmineTest (result, specs, currentSuite) {
    const state = this._webdriverioJasmineState
    const currentStore = storage('legacy').getStore()
    if (!state || !result?.id) {
      return currentStore
    }
    if (state.completedTestStatuses.has(result.id)) {
      return currentStore
    }

    const existingTest = state.tests.get(result.id)
    if (existingTest) {
      return existingTest.currentStore
    }

    const candidateSpecs = specs || state.specs
    const testSuiteAbsolutePath = normalizeJasmineFile(
      state.suiteFiles.get(result.parentSuiteId) ||
      currentSuite?.filename ||
      (candidateSpecs.length === 1 ? candidateSpecs[0] : undefined) ||
      result.file ||
      result.filename ||
      candidateSpecs[0]
    )
    if (!testSuiteAbsolutePath) {
      return currentStore
    }

    const testName = result.fullName || result.description
    const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.sourceRoot)
    const properties = this.libraryConfig?.testManagementTests?.mocha
      ?.suites?.[testSuite]?.tests?.[testName]?.properties || {}
    const isAttemptToFix = this.libraryConfig?.isTestManagementTestsEnabled && properties.attempt_to_fix
    const isDisabled = this.libraryConfig?.isTestManagementTestsEnabled && properties.disabled
    const isQuarantined = this.libraryConfig?.isTestManagementTestsEnabled && properties.quarantined
    const isModified = this.libraryConfig?.isImpactedTestsEnabled && isModifiedTest(
      getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot || this.sourceRoot),
      null,
      null,
      this.libraryConfig.modifiedFiles,
      this.constructor.id
    )
    const knownTests = this.libraryConfig?.knownTests?.mocha
    const isNew = this.libraryConfig?.isKnownTestsEnabled && knownTests &&
      !(knownTests[testSuite] || []).includes(testName)
    const isEarlyFlakeDetection = this.libraryConfig?.isEarlyFlakeDetectionEnabled &&
      hasEfdRetries(this.libraryConfig.earlyFlakeDetectionRetryPolicy) &&
      !isAttemptToFix && !isDisabled && (isNew || isModified)
    const isAtr = this.libraryConfig?.isFlakyTestRetriesEnabled &&
      !isAttemptToFix && !isEarlyFlakeDetection
    let retryCount = 0
    if (isAttemptToFix) {
      retryCount = this.libraryConfig.testManagementAttemptToFixRetries
    } else if (isEarlyFlakeDetection) {
      retryCount = this.libraryConfig.earlyFlakeDetectionRetryPolicy.schedulingRetryCount
    } else if (isAtr) {
      retryCount = this.libraryConfig.flakyTestRetriesCount
    }

    const test = {
      attempt: 0,
      attemptStart: undefined,
      currentStore: undefined,
      earlyFlakeAbortReason: undefined,
      hasDynamicName: isNew && DYNAMIC_NAME_RE.test(testName),
      hasFailedAttempt: false,
      hasFinalHookFailure: false,
      isAttemptToFix,
      isAtr,
      isDisabled,
      isEarlyFlakeDetection,
      isModified,
      isNew,
      isQuarantined,
      reportedStatus: undefined,
      retryCount,
      retryWait: undefined,
      runnerStatus: undefined,
      span: undefined,
      statuses: [],
      testName,
      testSuiteAbsolutePath,
      title: result.description,
    }
    state.tests.set(result.id, test)
    this.#startWebdriverioJasmineAttempt(test, currentStore)

    return test.currentStore
  }

  /**
   * Applies a managed Jasmine test's skip and retry policy to WebdriverIO's function wrapper.
   *
   * @param {object} context
   * @param {WebdriverioJasmineResult|undefined} result
   * @param {'Test'|'Hook'} type
   * @returns {object|undefined}
   */
  #configureWebdriverioJasmineFunction (context, result, type) {
    const currentStore = this.#startWebdriverioJasmineTest(result)
    const test = this._webdriverioJasmineState?.tests.get(result?.id)
    if (!test) {
      return currentStore
    }

    if (test.isAttemptToFix || test.isAtr || test.isEarlyFlakeDetection) {
      context.arguments[6] = 0
    }
    return {
      ...test.currentStore,
      [WEBDRIVERIO_JASMINE_FUNCTION_TYPE]: type,
    }
  }

  /**
   * Starts one WebdriverIO Jasmine test attempt under its suite span.
   *
   * @param {object} test
   * @param {object|undefined} parentStore
   * @returns {void}
   */
  #startWebdriverioJasmineAttempt (test, parentStore) {
    test.attemptStart = performance.now()
    test.hasFinalHookFailure = false
    const span = this.startTestSpan({
      hasDynamicName: test.hasDynamicName,
      isAttemptToFix: test.isAttemptToFix,
      isDisabled: test.isDisabled,
      isEfdRetry: test.isEarlyFlakeDetection && test.attempt > 0,
      isModified: test.isModified,
      isNew: test.isNew,
      isParallel: true,
      isQuarantined: test.isQuarantined,
      testName: test.testName,
      testSuiteAbsolutePath: test.testSuiteAbsolutePath,
      title: test.title,
    })
    test.span = span
    test.currentStore = {
      ...parentStore,
      span,
      [WEBDRIVERIO_JASMINE_TEST]: test,
    }
    this.activeTestSpan = span
  }

  /**
   * Delays Jasmine's parent runner until every Datadog-managed spec execution has completed.
   *
   * @param {object} context
   * @returns {void}
   */
  #configureWebdriverioJasmineLifecycle (context) {
    const isLegacyJasmine = Boolean(context.self?.queueableFn)
    const spec = isLegacyJasmine ? context.self : context.arguments?.[0]
    const onComplete = context.arguments?.[1]
    const originalTestFunction = spec?.queueableFn?.fn
    if (!spec?.id || typeof onComplete !== 'function' || typeof originalTestFunction !== 'function') {
      return
    }

    if (this.libraryConfig?.isTestManagementTestsEnabled) {
      this.#startWebdriverioJasmineTest(spec.result)
      const test = this._webdriverioJasmineState?.tests.get(spec.id)
      if (test?.isDisabled && !test.isAttemptToFix) {
        spec.pend('Skipped by Datadog Test Management')
      }
    }

    const executionArguments = [...context.arguments]
    context.arguments[1] = (...completeArguments) => {
      const test = this._webdriverioJasmineState?.tests.get(spec.id)
      if (!test?.willRetry) {
        return onComplete(...completeArguments)
      }

      test.willRetry = false
      const retry = () => {
        try {
          this.#startNextWebdriverioJasmineAttempt(test)
          spec.reset()
          spec.queueableFn.fn = originalTestFunction
          if (isLegacyJasmine) {
            spec.execute(
              executionArguments[0],
              onComplete,
              executionArguments[2],
              executionArguments[3]
            )
          } else {
            context.self._executeSpec(spec, onComplete)
          }
        } catch (error) {
          log.error('WebdriverIO Jasmine retry error', error)
          onComplete(...completeArguments)
        }
      }
      const retryWait = test.retryWait
      test.retryWait = undefined
      if (retryWait?.then) {
        retryWait.then(retry, retry)
      } else {
        retry()
      }
    }
  }

  /**
   * Selects the runner-visible status and whether Jasmine should execute the full spec again.
   *
   * @param {object|undefined} spec
   * @param {string|undefined} status
   * @returns {string|undefined}
   */
  #prepareWebdriverioJasmineAttempt (spec, status) {
    const state = this._webdriverioJasmineState
    const completedStatus = state?.completedTestStatuses.get(spec?.id)
    if (completedStatus) {
      return completedStatus
    }

    const test = state?.tests.get(spec?.id)
    if (!test || !status) {
      return status
    }

    const testStatus = getJasmineStatus(status)
    if (
      testStatus !== 'skip' &&
      test.isEarlyFlakeDetection &&
      test.attempt === 0
    ) {
      test.retryCount = getEfdRetryCountForDuration(
        performance.now() - test.attemptStart,
        this.libraryConfig.earlyFlakeDetectionRetryPolicy
      )
      if (test.retryCount === 0) {
        test.earlyFlakeAbortReason = 'slow'
      }
    }

    const hasManagedRetry = testStatus !== 'skip' && test.attempt < test.retryCount
    test.willRetry = hasManagedRetry && (
      test.isAttemptToFix ||
      test.isEarlyFlakeDetection ||
      (test.isAtr && testStatus === 'fail' && !test.hasFinalHookFailure)
    )

    let runnerStatus = status
    const recoveredEarlyFlakeDetection = test.isEarlyFlakeDetection &&
      !test.hasFinalHookFailure && test.statuses.includes('pass')
    if (
      testStatus === 'fail' &&
      (test.willRetry || (test.isQuarantined && !test.isAttemptToFix) || recoveredEarlyFlakeDetection)
    ) {
      runnerStatus = 'passed'
    } else if (testStatus !== 'skip' && !test.willRetry && test.isAttemptToFix) {
      runnerStatus = test.statuses.every(previousStatus => previousStatus === 'pass') && testStatus === 'pass'
        ? 'passed'
        : 'failed'
    }

    if (runnerStatus !== status) {
      test.reportedStatus = status
    }
    if (!test.willRetry) {
      test.runnerStatus = runnerStatus
    }
    return runnerStatus
  }

  /**
   * Finishes one Datadog-managed Jasmine attempt before the full spec is executed again.
   *
   * @param {object} test
   * @param {WebdriverioJasmineResult} result
   * @returns {void}
   */
  #finishWebdriverioJasmineRetry (test, result) {
    const status = getJasmineStatus(test.reportedStatus || result.status)
    const error = getJasmineError(result)
    test.statuses.push(status)

    if (error) {
      const isFirstFailure = !test.hasFailedAttempt
      test.hasFailedAttempt = true
      const promises = {}
      testRetryCh.publish({
        err: error,
        isAttemptToFixRetry: test.isAttemptToFix && test.attempt > 0,
        isAtrRetry: test.isAtr && test.attempt > 0,
        isEfdRetry: test.isEarlyFlakeDetection && test.attempt > 0,
        isFirstAttempt: test.attempt === 0,
        isFirstFailure,
        promises,
        test,
        willBeRetried: true,
        ...test.currentStore,
      })
      test.retryWait = getFailedTestReplayPromise(promises)
    } else {
      testFinishCh.publish({
        hasBeenRetried: test.isAtr && test.attempt > 0,
        isAttemptToFixRetry: test.isAttemptToFix && test.attempt > 0,
        isAtrRetry: false,
        isLastRetry: false,
        status,
        ...test.currentStore,
      })
    }
  }

  /**
   * Advances a Jasmine test and starts its next attempt span.
   *
   * @param {object} test
   * @returns {void}
   */
  #startNextWebdriverioJasmineAttempt (test) {
    test.attempt++
    test.reportedStatus = undefined
    this.#startWebdriverioJasmineAttempt(test, test.currentStore)
  }

  /**
   * Cleans up RUM before advancing a native WebdriverIO retry.
   *
   * @param {object} context
   * @param {object} test
   * @param {Error|undefined} error
   * @yields {unknown} RUM cleanup or retry setup operation.
   * @returns {RumGenerator}
   */
  * #retryWebdriverioJasmineTestAfterRumCleanup (context, test, error) {
    const cleanup = context.rumCleanupGenerator?.()
    let browsers
    if (cleanup) {
      browsers = yield * cleanup
    }
    yield this.#retryWebdriverioJasmineTest(test, error)

    if (!browsers?.length) return

    const correlationContext = {
      isRumActive: true,
      testExecutionId: undefined,
    }
    setRumTestCorrelation(correlationContext, test.span)
    const correlation = context.rumCorrelationGenerator?.(browsers, correlationContext.testExecutionId)
    if (correlation) {
      yield * correlation
    }
  }

  /**
   * Finishes an intermediate native WebdriverIO retry and starts its next span.
   *
   * @param {object} test
   * @param {Error|undefined} error
   * @returns {Promise<void>|undefined}
   */
  #retryWebdriverioJasmineTest (test, error) {
    test.statuses.push('fail')
    const isFirstFailure = !test.hasFailedAttempt
    test.hasFailedAttempt = true
    const promises = {}
    testRetryCh.publish({
      err: error,
      isAttemptToFixRetry: false,
      isAtrRetry: false,
      isEfdRetry: false,
      isFirstAttempt: test.attempt === 0,
      isFirstFailure,
      promises,
      test,
      willBeRetried: true,
      ...test.currentStore,
    })

    const retryWait = getFailedTestReplayPromise(promises)
    if (retryWait?.then) {
      const startNextAttempt = () => this.#startNextWebdriverioJasmineAttempt(test)
      return retryWait.then(startNextAttempt, startNextAttempt)
    }
    this.#startNextWebdriverioJasmineAttempt(test)
  }

  /**
   * Finishes a Jasmine test after its reporter receives the final result.
   *
   * @param {WebdriverioJasmineResult|undefined} result
   * @param {string[]} [specs]
   * @returns {Promise<void>|undefined}
   */
  #finishWebdriverioJasmineTest (result, specs) {
    const state = this._webdriverioJasmineState
    if (!state || !result?.id) {
      return
    }

    this.#startWebdriverioJasmineTest(result, specs)
    const test = state.tests.get(result.id)
    if (!test) {
      return
    }

    if (state.currentResult?.id === result.id) {
      state.currentResult = undefined
    }
    if (test.willRetry) {
      this.#finishWebdriverioJasmineRetry(test, result)
      return
    }
    if (test._ddShouldWaitForHitProbe) {
      delete test._ddShouldWaitForHitProbe
      state.pendingTestFinishes++
      const finishTest = () => {
        this.#completeWebdriverioJasmineTest(test, result)
        state.pendingTestFinishes--
        if (state.pendingTestFinishes === 0) {
          const callbacks = state.pendingTestFinishCallbacks
          state.pendingTestFinishCallbacks = []
          for (const callback of callbacks) {
            callback()
          }
        }
      }
      return this.waitForDiBreakpointHits().then(finishTest, finishTest)
    }

    this.#completeWebdriverioJasmineTest(test, result)
  }

  /**
   * Finalizes the last reported attempt for one WebdriverIO Jasmine test.
   *
   * @param {object} test
   * @param {WebdriverioJasmineResult} result
   * @returns {void}
   */
  #completeWebdriverioJasmineTest (test, result) {
    const state = this._webdriverioJasmineState

    const status = getJasmineStatus(test.reportedStatus || result.status)
    const error = getJasmineError(result)
    if (error) {
      test.span.setTag('error', error)
    }
    if (!test.isEarlyFlakeDetection || status !== 'skip') {
      test.statuses.push(status)
    }
    const hasFailedAllRetries = test.attempt > 0 &&
      (test.isAttemptToFix || test.isAtr || test.isEarlyFlakeDetection) &&
      test.statuses.every(testStatus => testStatus === 'fail')
    const isSkipped = status === 'skip'
    const attemptToFixPassed = !isSkipped && test.isAttemptToFix &&
      test.statuses.every(testStatus => testStatus === 'pass')
    const attemptToFixFailed = !isSkipped && test.isAttemptToFix && !attemptToFixPassed
    let finalStatus = status
    if (isSkipped || (!test.isAttemptToFix && (test.isDisabled || test.isQuarantined))) {
      finalStatus = 'skip'
    } else if (test.isAttemptToFix) {
      finalStatus = attemptToFixPassed ? 'pass' : 'fail'
    } else if (test.isEarlyFlakeDetection && status !== 'skip' && !test.hasFinalHookFailure) {
      finalStatus = test.statuses.includes('pass') ? 'pass' : 'fail'
    }
    testFinishCh.publish({
      attemptToFixFailed,
      attemptToFixPassed,
      earlyFlakeAbortReason: test.earlyFlakeAbortReason,
      finalStatus,
      hasBeenRetried: !test.isAttemptToFix && !test.isEarlyFlakeDetection && test.attempt > 0,
      hasFailedAllRetries,
      isAttemptToFixRetry: test.isAttemptToFix && test.attempt > 0,
      isAtrRetry: test.isAtr && test.attempt > 0,
      isLastRetry: true,
      status,
      ...test.currentStore,
    })
    state.completedTestStatuses.set(result.id, test.runnerStatus || result.status)
    state.tests.delete(result.id)

    const suiteStatus = test.isQuarantined && !test.isAttemptToFix ? 'pass' : finalStatus
    const previousStatus = state.suiteStatuses.get(test.testSuiteAbsolutePath)
    if (suiteStatus === 'fail' || !previousStatus || previousStatus === 'skip') {
      state.suiteStatuses.set(test.testSuiteAbsolutePath, suiteStatus)
    }
  }

  /**
   * Reports Jasmine suite statuses and flushes worker traces before its run settles.
   *
   * @param {{
   *   resolveCallback?: (onDone: () => void) => void,
   *   rejectCallback?: (onDone: () => void) => void
   * }} context
   * @returns {void}
   */
  #finishWebdriverioJasmineWorker (context) {
    const state = this._webdriverioJasmineState
    const reportWorker = onDone => {
      const results = []
      const reportedFiles = new Set()
      for (const [file, status] of state.suiteStatuses) {
        const error = state.suiteErrors.get(file)
        const result = { file, status }
        if (error) {
          result.error = {
            message: error.message,
            stack: error.stack,
          }
        }
        results.push(result)
        reportedFiles.add(file)
      }
      for (const spec of state.specs) {
        const file = normalizeJasmineFile(spec)
        if (!reportedFiles.has(file)) {
          results.push({ file, status: 'skip' })
        }
      }

      sendWebdriverioWorkerMessage({
        origin: 'datadog',
        name: SUITE_FINISH,
        content: { results },
      }, error => {
        if (error) {
          log.error('WebdriverIO Test Optimization IPC error', error)
        }
      }, () => workerFinishCh.publish({ onDone }))
    }

    const waitForWorker = onDone => {
      if (state?.pendingTestFinishes) {
        state.pendingTestFinishCallbacks.push(() => reportWorker(onDone))
      } else {
        reportWorker(onDone)
      }
    }
    context.resolveCallback = waitForWorker
    context.rejectCallback = waitForWorker
  }

  startTestSpan (testInfo) {
    const {
      testName,
      testSuiteAbsolutePath,
      title,
      isNew,
      isEfdRetry,
      testStartLine,
      isParallel,
      isAttemptToFix,
      isDisabled,
      isQuarantined,
      isModified,
      hasDynamicName,
    } = testInfo

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

    if (isAttemptToFix) {
      extraTags[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] = 'true'
    }

    if (isDisabled) {
      extraTags[TEST_MANAGEMENT_IS_DISABLED] = 'true'
    }

    if (isQuarantined) {
      extraTags[TEST_MANAGEMENT_IS_QUARANTINED] = 'true'
    }

    if (isModified) {
      extraTags[TEST_IS_MODIFIED] = 'true'
      if (isEfdRetry) {
        extraTags[TEST_IS_RETRY] = 'true'
        extraTags[TEST_RETRY_REASON] = TEST_RETRY_REASON_TYPES.efd
      }
    }

    const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.sourceRoot)
    const testSuiteSpan = this._testSuiteSpansByTestSuite.get(testSuite)

    extraTags[TEST_SOURCE_FILE] = this.repositoryRoot !== this.sourceRoot && !!this.repositoryRoot
      ? getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      : testSuite

    if (isNew) {
      extraTags[TEST_IS_NEW] = 'true'
      if (isEfdRetry) {
        extraTags[TEST_IS_RETRY] = 'true'
        extraTags[TEST_RETRY_REASON] = TEST_RETRY_REASON_TYPES.efd
      }
    }

    if (hasDynamicName) {
      extraTags[TEST_HAS_DYNAMIC_NAME] = 'true'
    }

    return super.startTestSpan(testName, testSuite, testSuiteSpan, extraTags)
  }
}

module.exports = MochaPlugin
