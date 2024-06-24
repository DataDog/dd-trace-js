const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

const {
  TEST_STATUS,
  finishAllTraceSpans,
  getTestSuitePath,
  getTestSuiteCommonTags,
  TEST_SOURCE_FILE
} = require('../../dd-trace/src/plugins/util/test')
const { COMPONENT } = require('../../dd-trace/src/constants')

// Milliseconds that we subtract from the error test duration
// so that they do not overlap with the following test
// This is because there's some loss of resolution.
const MILLISECONDS_TO_SUBTRACT_FROM_FAILED_TEST_DURATION = 5

class VitestPlugin extends CiPlugin {
  static get id () {
    return 'vitest'
  }

  constructor (...args) {
    super(...args)

    this.taskToFinishTime = new WeakMap()

    this.addSub('ci:vitest:test:start', ({ testName, testSuiteAbsolutePath }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const store = storage.getStore()
      const span = this.startTestSpan(
        testName,
        testSuite,
        this.testSuiteSpan,
        {
          [TEST_SOURCE_FILE]: testSuite
        }
      )

      this.enter(span, store)
    })

    // If there's a hook error, this is called AND THEN test:error - which will not work
    this.addSub('ci:vitest:test:finish-time', ({ status, task }) => {
      const store = storage.getStore()
      const span = store?.span

      // we store the finish time
      if (span) {
        span.setTag(TEST_STATUS, status)
        this.taskToFinishTime.set(task, span._getTime())
      }
    })

    this.addSub('ci:vitest:test:pass', ({ task }) => {
      const store = storage.getStore()
      const span = store?.span

      if (span) {
        span.setTag(TEST_STATUS, 'pass')
        span.finish(this.taskToFinishTime.get(task))
        finishAllTraceSpans(span)
      }
    })

    this.addSub('ci:vitest:test:error', ({ duration, error }) => {
      const store = storage.getStore()
      const span = store?.span

      if (span) {
        span.setTag(TEST_STATUS, 'fail')

        if (error) {
          span.setTag('error', error)
        }
        span.finish(span._startTime + duration - MILLISECONDS_TO_SUBTRACT_FROM_FAILED_TEST_DURATION) // milliseconds
        finishAllTraceSpans(span)
      }
    })

    this.addSub('ci:vitest:test:skip', ({ testName, testSuiteAbsolutePath }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      this.startTestSpan(
        testName,
        testSuite,
        this.testSuiteSpan,
        {
          [TEST_SOURCE_FILE]: testSuite,
          [TEST_STATUS]: 'skip'
        }
      ).finish()
    })

    this.addSub('ci:vitest:test-suite:start', (testSuiteAbsolutePath) => {
      const testSessionSpanContext = this.tracer.extract('text_map', {
        'x-datadog-trace-id': process.env.DD_CIVISIBILITY_TEST_SESSION_ID,
        'x-datadog-parent-id': process.env.DD_CIVISIBILITY_TEST_MODULE_ID
      })

      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const testSuiteMetadata = getTestSuiteCommonTags(
        this.command,
        this.frameworkVersion,
        testSuite,
        'vitest'
      )
      const testSuiteSpan = this.tracer.startSpan('vitest.test_suite', {
        childOf: testSessionSpanContext,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
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

    this.addSub('ci:vitest:session:finish', ({ status, onFinish, error }) => {
      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.setTag(TEST_STATUS, status)
      if (error) {
        this.testModuleSpan.setTag('error', error)
        this.testSessionSpan.setTag('error', error)
      }
      this.testModuleSpan.finish()
      this.testSessionSpan.finish()
      finishAllTraceSpans(this.testSessionSpan)
      this.tracer._exporter.flush(onFinish)
    })
  }
}

module.exports = VitestPlugin
