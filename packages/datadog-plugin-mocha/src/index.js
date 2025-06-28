'use strict'

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')
const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')

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
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_SESSION_ID,
  TEST_MODULE_ID,
  TEST_MODULE,
  TEST_SUITE_ID,
  TEST_COMMAND,
  TEST_SUITE,
  MOCHA_IS_PARALLEL,
  TEST_IS_RUM_ACTIVE,
  TEST_BROWSER_DRIVER,
  TEST_RETRY_REASON,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED,
  isModifiedTest
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
  TELEMETRY_TEST_SESSION
} = require('../../dd-trace/src/ci-visibility/telemetry')
const id = require('../../dd-trace/src/id')
const log = require('../../dd-trace/src/log')

const BREAKPOINT_SET_GRACE_PERIOD_MS = 200

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
        .map(filename => getTestSuitePath(filename, this.repositoryRoot || this.sourceRoot))

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

    this.addBind('ci:mocha:test-suite:start', (ctx) => {
      const { testSuiteAbsolutePath, isUnskippable, isForcedToRun, itrCorrelationId } = ctx

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
          ...testSuiteMetadata
        },
        integrationName: this.constructor.id
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
      this._testSuites.set(testSuite, testSuiteSpan)
    })

    this.addSub('ci:mocha:test-suite:finish', ({ testSuiteSpan, status }) => {
      if (testSuiteSpan) {
        // the test status of the suite may have been set in ci:mocha:test-suite:error already
        if (!testSuiteSpan.context()._tags[TEST_STATUS]) {
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

    this.addSub('ci:mocha:test:is-modified', ({ modifiedTests, file, onDone }) => {
      const testPath = getTestSuitePath(file, this.repositoryRoot)
      const isModified = isModifiedTest(
        testPath,
        null,
        null,
        modifiedTests,
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

    this.addSub('ci:mocha:worker:finish', () => {
      this.tracer._exporter.flush()
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
      isAtrRetry
    }) => {
      if (span) {
        span.setTag(TEST_STATUS, status)
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

        const spanTags = span.context()._tags
        this.telemetry.ciVisEvent(
          TELEMETRY_EVENT_FINISHED,
          'test',
          {
            hasCodeOwners: !!spanTags[TEST_CODE_OWNERS],
            isNew: spanTags[TEST_IS_NEW] === 'true',
            isRum: spanTags[TEST_IS_RUM_ACTIVE] === 'true',
            browserDriver: spanTags[TEST_BROWSER_DRIVER]
          }
        )

        span.finish()
        finishAllTraceSpans(span)
        this.activeTestSpan = null
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

    this.addSub('ci:mocha:test:retry', ({ span, isFirstAttempt, willBeRetried, err, test, isAtrRetry }) => {
      if (span) {
        span.setTag(TEST_STATUS, 'fail')
        if (!isFirstAttempt) {
          span.setTag(TEST_IS_RETRY, 'true')
          if (isAtrRetry) {
            span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atr)
          } else {
            span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.ext)
          }
        }
        if (err) {
          span.setTag('error', err)
        }

        const spanTags = span.context()._tags
        this.telemetry.ciVisEvent(
          TELEMETRY_EVENT_FINISHED,
          'test',
          {
            hasCodeOwners: !!spanTags[TEST_CODE_OWNERS],
            isNew: spanTags[TEST_IS_NEW] === 'true',
            isRum: spanTags[TEST_IS_RUM_ACTIVE] === 'true',
            browserDriver: spanTags[TEST_BROWSER_DRIVER]
          }
        )
        if (isFirstAttempt && willBeRetried && this.di && this.libraryConfig?.isDiEnabled) {
          const probeInformation = this.addDiProbe(err)
          if (probeInformation) {
            const { file, line, stackIndex } = probeInformation
            this.runningTestProbe = { file, line }
            this.testErrorStackIndex = stackIndex
            test._ddShouldWaitForHitProbe = true
            const waitUntil = Date.now() + BREAKPOINT_SET_GRACE_PERIOD_MS
            while (Date.now() < waitUntil) {
              // TODO: To avoid a race condition, we should wait until `probeInformation.setProbePromise` has resolved.
              // However, Mocha doesn't have a mechanism for waiting asyncrounously here, so for now, we'll have to
              // fall back to a fixed syncronous delay.
            }
          }
        }

        span.finish()
        finishAllTraceSpans(span)
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
      isEarlyFlakeDetectionFaulty,
      isTestManagementEnabled,
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
            hasUnskippableSuites
          }
        )

        if (isEarlyFlakeDetectionEnabled) {
          this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ENABLED, 'true')
        }
        if (isEarlyFlakeDetectionFaulty) {
          this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ABORT_REASON, 'faulty')
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
              log.warn('Test suite span not found for test span with test suite', testSuite)
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

    this.addBind('ci:mocha:global:run', (ctx) => {
      return ctx.currentStore
    })
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
      isModified
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
    const testSuiteSpan = this._testSuites.get(testSuite)

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

    return super.startTestSpan(testName, testSuite, testSuiteSpan, extraTags)
  }
}

module.exports = MochaPlugin
