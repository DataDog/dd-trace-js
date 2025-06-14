const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')
const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')

const {
  TEST_STATUS,
  JEST_TEST_RUNNER,
  finishAllTraceSpans,
  getTestSuiteCommonTags,
  addIntelligentTestRunnerSpanTags,
  TEST_PARAMETERS,
  TEST_COMMAND,
  TEST_FRAMEWORK_VERSION,
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
  JEST_DISPLAY_NAME,
  TEST_IS_RUM_ACTIVE,
  TEST_BROWSER_DRIVER,
  getFormattedError,
  TEST_RETRY_REASON,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED
} = require('../../dd-trace/src/plugins/util/test')
const { COMPONENT } = require('../../dd-trace/src/constants')
const id = require('../../dd-trace/src/id')
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

const isJestWorker = !!getEnvironmentVariable('JEST_WORKER_ID')

// https://github.com/facebook/jest/blob/d6ad15b0f88a05816c2fe034dd6900d28315d570/packages/jest-worker/src/types.ts#L38
const CHILD_MESSAGE_END = 2

function withTimeout (promise, timeoutMs) {
  return new Promise(resolve => {
    // Set a timeout to resolve after 1s
    setTimeout(resolve, timeoutMs)

    // Also resolve if the original promise resolves
    promise.then(resolve)
  })
}

class JestPlugin extends CiPlugin {
  static get id () {
    return 'jest'
  }

  // The lists are the same for every test suite, so we can cache them
  getUnskippableSuites (unskippableSuitesList) {
    if (!this.unskippableSuites) {
      this.unskippableSuites = JSON.parse(unskippableSuitesList)
    }
    return this.unskippableSuites
  }

  getForcedToRunSuites (forcedToRunSuitesList) {
    if (!this.forcedToRunSuites) {
      this.forcedToRunSuites = JSON.parse(forcedToRunSuitesList)
    }
    return this.forcedToRunSuites
  }

  constructor (...args) {
    super(...args)

    if (isJestWorker) {
      // Used to handle the end of a jest worker to be able to flush
      const handler = ([message]) => {
        if (message === CHILD_MESSAGE_END) {
          // testSuiteSpan is not defined for older versions of jest, where jest-jasmine2 is still used
          if (this.testSuiteSpan) {
            this.testSuiteSpan.finish()
            finishAllTraceSpans(this.testSuiteSpan)
          }
          this.tracer._exporter.flush()
          process.removeListener('message', handler)
        }
      }
      process.on('message', handler)
    }

    this.addSub('ci:jest:session:finish', ({
      status,
      isSuitesSkipped,
      isSuitesSkippingEnabled,
      isCodeCoverageEnabled,
      testCodeCoverageLinesTotal,
      numSkippedSuites,
      hasUnskippableSuites,
      hasForcedToRunSuites,
      error,
      isEarlyFlakeDetectionEnabled,
      isEarlyFlakeDetectionFaulty,
      isTestManagementTestsEnabled,
      onDone
    }) => {
      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.setTag(TEST_STATUS, status)

      if (error) {
        this.testSessionSpan.setTag('error', error)
        this.testModuleSpan.setTag('error', error)
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
          hasForcedToRunSuites
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

      this.testModuleSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
      this.testSessionSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
      finishAllTraceSpans(this.testSessionSpan)

      this.telemetry.count(TELEMETRY_TEST_SESSION, {
        provider: this.ciProviderName,
        autoInjected: !!getEnvironmentVariable('DD_CIVISIBILITY_AUTO_INSTRUMENTATION_PROVIDER')
      })

      this.tracer._exporter.flush(() => {
        if (onDone) {
          onDone()
        }
      })
    })

    // Test suites can be run in a different process from jest's main one.
    // This subscriber changes the configuration objects from jest to inject the trace id
    // of the test session to the processes that run the test suites, and other data.
    this.addSub('ci:jest:session:configuration', configs => {
      configs.forEach(config => {
        config._ddTestSessionId = this.testSessionSpan.context().toTraceId()
        config._ddTestModuleId = this.testModuleSpan.context().toSpanId()
        config._ddTestCommand = this.testSessionSpan.context()._tags[TEST_COMMAND]
        config._ddItrCorrelationId = this.itrCorrelationId
        config._ddIsEarlyFlakeDetectionEnabled = !!this.libraryConfig?.isEarlyFlakeDetectionEnabled
        config._ddEarlyFlakeDetectionNumRetries = this.libraryConfig?.earlyFlakeDetectionNumRetries ?? 0
        config._ddRepositoryRoot = this.repositoryRoot
        config._ddIsFlakyTestRetriesEnabled = this.libraryConfig?.isFlakyTestRetriesEnabled ?? false
        config._ddIsTestManagementTestsEnabled = this.libraryConfig?.isTestManagementEnabled ?? false
        config._ddTestManagementAttemptToFixRetries = this.libraryConfig?.testManagementAttemptToFixRetries ?? 0
        config._ddFlakyTestRetriesCount = this.libraryConfig?.flakyTestRetriesCount
        config._ddIsDiEnabled = this.libraryConfig?.isDiEnabled ?? false
        config._ddIsKnownTestsEnabled = this.libraryConfig?.isKnownTestsEnabled ?? false
        config._ddIsImpactedTestsEnabled = this.libraryConfig?.isImpactedTestsEnabled ?? false
      })
    })

    this.addSub('ci:jest:test-suite:start', ({
      testSuite,
      testSourceFile,
      testEnvironmentOptions,
      frameworkVersion,
      displayName
    }) => {
      const {
        _ddTestSessionId: testSessionId,
        _ddTestCommand: testCommand,
        _ddTestModuleId: testModuleId,
        _ddItrCorrelationId: itrCorrelationId,
        _ddForcedToRun,
        _ddUnskippable,
        _ddTestCodeCoverageEnabled
      } = testEnvironmentOptions

      const testSessionSpanContext = this.tracer.extract('text_map', {
        'x-datadog-trace-id': testSessionId,
        'x-datadog-parent-id': testModuleId
      })

      const testSuiteMetadata = getTestSuiteCommonTags(testCommand, frameworkVersion, testSuite, 'jest')

      if (_ddUnskippable) {
        const unskippableSuites = this.getUnskippableSuites(_ddUnskippable)
        if (unskippableSuites[testSuite]) {
          this.telemetry.count(TELEMETRY_ITR_UNSKIPPABLE, { testLevel: 'suite' })
          testSuiteMetadata[TEST_ITR_UNSKIPPABLE] = 'true'
        }
        if (_ddForcedToRun) {
          const forcedToRunSuites = this.getForcedToRunSuites(_ddForcedToRun)
          if (forcedToRunSuites[testSuite]) {
            this.telemetry.count(TELEMETRY_ITR_FORCED_TO_RUN, { testLevel: 'suite' })
            testSuiteMetadata[TEST_ITR_FORCED_RUN] = 'true'
          }
        }
      }
      if (itrCorrelationId) {
        testSuiteMetadata[ITR_CORRELATION_ID] = itrCorrelationId
      }
      if (displayName) {
        testSuiteMetadata[JEST_DISPLAY_NAME] = displayName
      }
      if (testSourceFile) {
        testSuiteMetadata[TEST_SOURCE_FILE] = testSourceFile
        // Test suite is the whole test file, so we can use the first line as the start
        testSuiteMetadata[TEST_SOURCE_START] = 1
      }

      const codeOwners = this.getCodeOwners(testSuiteMetadata)
      if (codeOwners) {
        testSuiteMetadata[TEST_CODE_OWNERS] = codeOwners
      }

      this.testSuiteSpan = this.tracer.startSpan('jest.test_suite', {
        childOf: testSessionSpanContext,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      if (_ddTestCodeCoverageEnabled) {
        this.telemetry.ciVisEvent(TELEMETRY_CODE_COVERAGE_STARTED, 'suite', { library: 'istanbul' })
      }
    })

    this.addSub('ci:jest:worker-report:trace', traces => {
      const formattedTraces = JSON.parse(traces).map(trace =>
        trace.map(span => ({
          ...span,
          span_id: id(span.span_id),
          trace_id: id(span.trace_id),
          parent_id: id(span.parent_id)
        }))
      )

      formattedTraces.forEach(trace => {
        this.tracer._exporter.export(trace)
      })
    })

    this.addSub('ci:jest:worker-report:coverage', data => {
      const formattedCoverages = JSON.parse(data).map(coverage => ({
        sessionId: id(coverage.sessionId),
        suiteId: id(coverage.suiteId),
        files: coverage.files
      }))
      formattedCoverages.forEach(formattedCoverage => {
        this.tracer._exporter.exportCoverage(formattedCoverage)
      })
    })

    this.addSub('ci:jest:worker-report:logs', (logsPayloads) => {
      JSON.parse(logsPayloads).forEach(({ testConfiguration, logMessage }) => {
        this.tracer._exporter.exportDiLogs(testConfiguration, logMessage)
      })
    })

    this.addSub('ci:jest:test-suite:finish', ({ status, errorMessage, error }) => {
      this.testSuiteSpan.setTag(TEST_STATUS, status)
      if (error) {
        this.testSuiteSpan.setTag('error', error)
      } else if (errorMessage) {
        this.testSuiteSpan.setTag('error', new Error(errorMessage))
      }
      this.testSuiteSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
      // Suites potentially run in a different process than the session,
      // so calling finishAllTraceSpans on the session span is not enough
      finishAllTraceSpans(this.testSuiteSpan)
      // Flushing within jest workers is cheap, as it's just interprocess communication
      // We do not want to flush after every suite if jest is running tests serially,
      // as every flush is an HTTP request.
      if (isJestWorker) {
        this.tracer._exporter.flush()
      }
      this.removeAllDiProbes()
    })

    /**
     * This can't use `this.libraryConfig` like `ci:mocha:test-suite:code-coverage`
     * because this subscription happens in a different process from the one
     * fetching the ITR config.
     */
    this.addSub('ci:jest:test-suite:code-coverage', ({ coverageFiles, testSuite, mockedFiles }) => {
      if (!coverageFiles.length) {
        this.telemetry.count(TELEMETRY_CODE_COVERAGE_EMPTY)
      }
      const files = [...coverageFiles, ...mockedFiles, testSuite]

      const { _traceId, _spanId } = this.testSuiteSpan.context()
      const formattedCoverage = {
        sessionId: _traceId,
        suiteId: _spanId,
        files
      }

      this.tracer._exporter.exportCoverage(formattedCoverage)
      this.telemetry.ciVisEvent(TELEMETRY_CODE_COVERAGE_FINISHED, 'suite', { library: 'istanbul' })
      this.telemetry.distribution(TELEMETRY_CODE_COVERAGE_NUM_FILES, {}, files.length)
    })

    this.addBind('ci:jest:test:start', (ctx) => {
      const store = storage('legacy').getStore()
      const span = this.startTestSpan(ctx)

      ctx.parentStore = store
      ctx.currentStore = { ...store, span }

      this.activeTestSpan = span

      return ctx.currentStore
    })

    this.addBind('ci:jest:test:fn', (ctx) => {
      return ctx.currentStore
    })

    this.addSub('ci:jest:test:finish', ({
      span,
      status,
      testStartLine,
      attemptToFixPassed,
      failedAllTests,
      attemptToFixFailed,
      isAtrRetry
    }) => {
      span.setTag(TEST_STATUS, status)
      if (testStartLine) {
        span.setTag(TEST_SOURCE_START, testStartLine)
      }
      if (attemptToFixPassed) {
        span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'true')
      } else if (attemptToFixFailed) {
        span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
      }
      if (failedAllTests) {
        span.setTag(TEST_HAS_FAILED_ALL_RETRIES, 'true')
      }
      if (isAtrRetry) {
        span.setTag(TEST_IS_RETRY, 'true')
        span.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atr)
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
    })

    this.addSub('ci:jest:test:err', ({ span, error, shouldSetProbe, promises }) => {
      if (error && span) {
        span.setTag(TEST_STATUS, 'fail')
        span.setTag('error', getFormattedError(error, this.repositoryRoot))
        if (shouldSetProbe) {
          const probeInformation = this.addDiProbe(error)
          if (probeInformation) {
            const { setProbePromise } = probeInformation
            promises.isProbeReady = withTimeout(setProbePromise, 2000)
          }
        }
      }
    })

    this.addSub('ci:jest:test:skip', ({
      test,
      isDisabled
    }) => {
      const span = this.startTestSpan(test)
      span.setTag(TEST_STATUS, 'skip')

      if (isDisabled) {
        span.setTag(TEST_MANAGEMENT_IS_DISABLED, 'true')
      }

      span.finish()
    })
  }

  startTestSpan (test) {
    const {
      suite,
      name,
      displayName,
      testParameters,
      frameworkVersion,
      testStartLine,
      testSourceFile,
      isNew,
      isEfdRetry,
      isAttemptToFix,
      isAttemptToFixRetry,
      isJestRetry,
      isDisabled,
      isQuarantined,
      isModified
    } = test

    const extraTags = {
      [JEST_TEST_RUNNER]: 'jest-circus',
      [TEST_PARAMETERS]: testParameters,
      [TEST_FRAMEWORK_VERSION]: frameworkVersion
    }
    if (testStartLine) {
      extraTags[TEST_SOURCE_START] = testStartLine
    }
    // If for whatever we don't have the source file, we'll fall back to the suite name
    extraTags[TEST_SOURCE_FILE] = testSourceFile || suite

    if (displayName) {
      extraTags[JEST_DISPLAY_NAME] = displayName
    }

    if (isAttemptToFix) {
      extraTags[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] = 'true'
    }

    if (isAttemptToFixRetry) {
      extraTags[TEST_IS_RETRY] = 'true'
      extraTags[TEST_RETRY_REASON] = TEST_RETRY_REASON_TYPES.atf
    } else if (isEfdRetry) {
      extraTags[TEST_IS_RETRY] = 'true'
      extraTags[TEST_RETRY_REASON] = TEST_RETRY_REASON_TYPES.efd
    } else if (isJestRetry) {
      extraTags[TEST_IS_RETRY] = 'true'
      extraTags[TEST_RETRY_REASON] = TEST_RETRY_REASON_TYPES.ext
    }

    if (isDisabled) {
      extraTags[TEST_MANAGEMENT_IS_DISABLED] = 'true'
    }

    if (isQuarantined) {
      extraTags[TEST_MANAGEMENT_IS_QUARANTINED] = 'true'
    }

    if (isModified) {
      extraTags[TEST_IS_MODIFIED] = 'true'
    }

    if (isNew) {
      extraTags[TEST_IS_NEW] = 'true'
    }

    return super.startTestSpan(name, suite, this.testSuiteSpan, extraTags)
  }
}

module.exports = JestPlugin
