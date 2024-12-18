const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

const {
  TEST_STATUS,
  finishAllTraceSpans,
  getTestSuitePath,
  getTestSuiteCommonTags,
  getTestSessionName,
  getIsFaultyEarlyFlakeDetection,
  TEST_SOURCE_FILE,
  TEST_IS_RETRY,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_CODE_OWNERS,
  TEST_LEVEL_EVENT_TYPES,
  TEST_SESSION_NAME,
  TEST_SOURCE_START,
  TEST_IS_NEW,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_NAME,
  DI_ERROR_DEBUG_INFO_CAPTURED,
  DI_DEBUG_ERROR_SNAPSHOT_ID,
  DI_DEBUG_ERROR_FILE,
  DI_DEBUG_ERROR_LINE
} = require('../../dd-trace/src/plugins/util/test')
const { COMPONENT } = require('../../dd-trace/src/constants')
const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED,
  TELEMETRY_TEST_SESSION
} = require('../../dd-trace/src/ci-visibility/telemetry')

// Milliseconds that we subtract from the error test duration
// so that they do not overlap with the following test
// This is because there's some loss of resolution.
const MILLISECONDS_TO_SUBTRACT_FROM_FAILED_TEST_DURATION = 5

const debuggerParameterPerTest = new Map()

class VitestPlugin extends CiPlugin {
  static get id () {
    return 'vitest'
  }

  constructor (...args) {
    super(...args)

    this.taskToFinishTime = new WeakMap()

    this.addSub('ci:vitest:test:is-new', ({ knownTests, testSuiteAbsolutePath, testName, onDone }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const testsForThisTestSuite = knownTests[testSuite] || []
      onDone(!testsForThisTestSuite.includes(testName))
    })

    this.addSub('ci:vitest:is-early-flake-detection-faulty', ({
      knownTests,
      testFilepaths,
      onDone
    }) => {
      const isFaulty = getIsFaultyEarlyFlakeDetection(
        testFilepaths.map(testFilepath => getTestSuitePath(testFilepath, this.repositoryRoot)),
        knownTests,
        this.libraryConfig.earlyFlakeDetectionFaultyThreshold
      )
      onDone(isFaulty)
    })

    this.addSub('ci:vitest:test:start', ({ testName, testSuiteAbsolutePath, isRetry, isNew }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const store = storage.getStore()

      const extraTags = {
        [TEST_SOURCE_FILE]: testSuite
      }
      if (isRetry) {
        extraTags[TEST_IS_RETRY] = 'true'
      }
      if (isNew) {
        extraTags[TEST_IS_NEW] = 'true'
      }

      const span = this.startTestSpan(
        testName,
        testSuite,
        this.testSuiteSpan,
        extraTags
      )

      const debuggerParameters = debuggerParameterPerTest.get(testName)

      if (debuggerParameters) {
        const spanContext = span.context()

        // TODO: handle race conditions with this.retriedTestIds
        this.retriedTestIds = {
          spanId: spanContext.toSpanId(),
          traceId: spanContext.toTraceId()
        }
        const { snapshotId, file, line } = debuggerParameters

        // TODO: should these be added on test:end if and only if the probe is hit?
        // Sync issues: `hitProbePromise` might be resolved after the test ends
        span.setTag(DI_ERROR_DEBUG_INFO_CAPTURED, 'true')
        span.setTag(DI_DEBUG_ERROR_SNAPSHOT_ID, snapshotId)
        span.setTag(DI_DEBUG_ERROR_FILE, file)
        span.setTag(DI_DEBUG_ERROR_LINE, line)
      }

      this.enter(span, store)
    })

    this.addSub('ci:vitest:test:finish-time', ({ status, task }) => {
      const store = storage.getStore()
      const span = store?.span

      // we store the finish time to finish at a later hook
      // this is because the test might fail at a `afterEach` hook
      if (span) {
        span.setTag(TEST_STATUS, status)
        this.taskToFinishTime.set(task, span._getTime())
      }
    })

    this.addSub('ci:vitest:test:pass', ({ task }) => {
      const store = storage.getStore()
      const span = store?.span

      if (span) {
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', {
          hasCodeowners: !!span.context()._tags[TEST_CODE_OWNERS]
        })
        span.setTag(TEST_STATUS, 'pass')
        span.finish(this.taskToFinishTime.get(task))
        finishAllTraceSpans(span)
      }
    })

    this.addSub('ci:vitest:test:error', ({ duration, error, willBeRetried, probe, isDiEnabled }) => {
      const store = storage.getStore()
      const span = store?.span

      if (span) {
        if (willBeRetried && this.di && isDiEnabled) {
          const testName = span.context()._tags[TEST_NAME]
          const debuggerParameters = this.addDiProbe(error, probe)
          debuggerParameterPerTest.set(testName, debuggerParameters)
        }
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', {
          hasCodeowners: !!span.context()._tags[TEST_CODE_OWNERS]
        })
        span.setTag(TEST_STATUS, 'fail')

        if (error) {
          span.setTag('error', error)
        }
        if (duration) {
          span.finish(span._startTime + duration - MILLISECONDS_TO_SUBTRACT_FROM_FAILED_TEST_DURATION) // milliseconds
        } else {
          span.finish() // retries will not have a duration
        }
        finishAllTraceSpans(span)
      }
    })

    this.addSub('ci:vitest:test:skip', ({ testName, testSuiteAbsolutePath }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const testSpan = this.startTestSpan(
        testName,
        testSuite,
        this.testSuiteSpan,
        {
          [TEST_SOURCE_FILE]: testSuite,
          [TEST_SOURCE_START]: 1, // we can't get the proper start line in vitest
          [TEST_STATUS]: 'skip'
        }
      )
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', {
        hasCodeowners: !!testSpan.context()._tags[TEST_CODE_OWNERS]
      })
      testSpan.finish()
    })

    this.addSub('ci:vitest:test-suite:start', ({ testSuiteAbsolutePath, frameworkVersion }) => {
      this.command = process.env.DD_CIVISIBILITY_TEST_COMMAND
      this.frameworkVersion = frameworkVersion
      const testSessionSpanContext = this.tracer.extract('text_map', {
        'x-datadog-trace-id': process.env.DD_CIVISIBILITY_TEST_SESSION_ID,
        'x-datadog-parent-id': process.env.DD_CIVISIBILITY_TEST_MODULE_ID
      })

      // test suites run in a different process, so they also need to init the metadata dictionary
      const testSessionName = getTestSessionName(this.config, this.command, this.testEnvironmentMetadata)
      const metadataTags = {}
      for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
        metadataTags[testLevel] = {
          [TEST_SESSION_NAME]: testSessionName
        }
      }
      if (this.tracer._exporter.setMetadataTags) {
        this.tracer._exporter.setMetadataTags(metadataTags)
      }

      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const testSuiteMetadata = getTestSuiteCommonTags(
        this.command,
        this.frameworkVersion,
        testSuite,
        'vitest'
      )
      testSuiteMetadata[TEST_SOURCE_FILE] = testSuite
      testSuiteMetadata[TEST_SOURCE_START] = 1

      const codeOwners = this.getCodeOwners(testSuiteMetadata)
      if (codeOwners) {
        testSuiteMetadata[TEST_CODE_OWNERS] = codeOwners
      }

      const testSuiteSpan = this.tracer.startSpan('vitest.test_suite', {
        childOf: testSessionSpanContext,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      const store = storage.getStore()
      this.enter(testSuiteSpan, store)
      this.testSuiteSpan = testSuiteSpan
    })

    this.addSub('ci:vitest:test-suite:finish', ({ status, onFinish }) => {
      const store = storage.getStore()
      const span = store?.span
      if (span) {
        span.setTag(TEST_STATUS, status)
        span.finish()
        finishAllTraceSpans(span)
      }
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
      // TODO: too frequent flush - find for method in worker to decrease frequency
      this.tracer._exporter.flush(onFinish)
    })

    this.addSub('ci:vitest:test-suite:error', ({ error }) => {
      const store = storage.getStore()
      const span = store?.span
      if (span && error) {
        span.setTag('error', error)
        span.setTag(TEST_STATUS, 'fail')
      }
    })

    this.addSub('ci:vitest:session:finish', ({
      status,
      error,
      testCodeCoverageLinesTotal,
      isEarlyFlakeDetectionEnabled,
      isEarlyFlakeDetectionFaulty,
      onFinish
    }) => {
      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.setTag(TEST_STATUS, status)
      if (error) {
        this.testModuleSpan.setTag('error', error)
        this.testSessionSpan.setTag('error', error)
      }
      if (testCodeCoverageLinesTotal) {
        this.testModuleSpan.setTag(TEST_CODE_COVERAGE_LINES_PCT, testCodeCoverageLinesTotal)
        this.testSessionSpan.setTag(TEST_CODE_COVERAGE_LINES_PCT, testCodeCoverageLinesTotal)
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
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
      finishAllTraceSpans(this.testSessionSpan)
      this.telemetry.count(TELEMETRY_TEST_SESSION, { provider: this.ciProviderName })
      this.tracer._exporter.flush(onFinish)
    })
  }
}

module.exports = VitestPlugin
