const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

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
  JEST_DISPLAY_NAME
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
  TELEMETRY_CODE_COVERAGE_NUM_FILES
} = require('../../dd-trace/src/ci-visibility/telemetry')

const isJestWorker = !!process.env.JEST_WORKER_ID

// https://github.com/facebook/jest/blob/d6ad15b0f88a05816c2fe034dd6900d28315d570/packages/jest-worker/src/types.ts#L38
const CHILD_MESSAGE_END = 2

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

      this.testModuleSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
      this.testSessionSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
      finishAllTraceSpans(this.testSessionSpan)

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
      })
    })

    this.addSub('ci:jest:test-suite:start', ({ testSuite, testEnvironmentOptions, frameworkVersion, displayName }) => {
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
    })

    /**
     * This can't use `this.libraryConfig` like `ci:mocha:test-suite:code-coverage`
     * because this subscription happens in a different process from the one
     * fetching the ITR config.
     */
    this.addSub('ci:jest:test-suite:code-coverage', ({ coverageFiles, testSuite }) => {
      if (!coverageFiles.length) {
        this.telemetry.count(TELEMETRY_CODE_COVERAGE_EMPTY)
      }
      const files = [...coverageFiles, testSuite]

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

    this.addSub('ci:jest:test:start', (test) => {
      const store = storage.getStore()
      const span = this.startTestSpan(test)

      this.enter(span, store)
    })

    this.addSub('ci:jest:test:finish', ({ status, testStartLine }) => {
      const span = storage.getStore().span
      span.setTag(TEST_STATUS, status)
      if (testStartLine) {
        span.setTag(TEST_SOURCE_START, testStartLine)
      }
      span.finish()
      this.telemetry.ciVisEvent(
        TELEMETRY_EVENT_FINISHED,
        'test',
        { hasCodeOwners: !!span.context()._tags[TEST_CODE_OWNERS] }
      )
      finishAllTraceSpans(span)
    })

    this.addSub('ci:jest:test:err', (error) => {
      if (error) {
        const store = storage.getStore()
        if (store && store.span) {
          const span = store.span
          span.setTag(TEST_STATUS, 'fail')
          span.setTag('error', error)
        }
      }
    })

    this.addSub('ci:jest:test:skip', (test) => {
      const span = this.startTestSpan(test)
      span.setTag(TEST_STATUS, 'skip')
      span.finish()
    })
  }

  startTestSpan (test) {
    const {
      suite,
      name,
      runner,
      displayName,
      testParameters,
      frameworkVersion,
      testStartLine,
      testSourceFile,
      isNew,
      isEfdRetry
    } = test

    const extraTags = {
      [JEST_TEST_RUNNER]: runner,
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

    if (isNew) {
      extraTags[TEST_IS_NEW] = 'true'
      if (isEfdRetry) {
        extraTags[TEST_IS_RETRY] = 'true'
      }
    }

    return super.startTestSpan(name, suite, this.testSuiteSpan, extraTags)
  }
}

module.exports = JestPlugin
