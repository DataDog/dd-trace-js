const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

const {
  TEST_STATUS,
  finishAllTraceSpans,
  getTestSuitePath,
  getTestSuiteCommonTags
} = require('../../dd-trace/src/plugins/util/test')
const { COMPONENT } = require('../../dd-trace/src/constants')

class VitestPlugin extends CiPlugin {
  static get id () {
    return 'vitest'
  }

  constructor (...args) {
    super(...args)
    this.addSub('ci:vitest:test:start', ({ testName, testSuiteAbsolutePath }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const store = storage.getStore()
      const span = this.startTestSpan(testName, testSuite, this.testSuiteSpan)

      this.enter(span, store)
    })

    this.addSub('ci:vitest:test:finish', (status) => {
      const store = storage.getStore()
      const span = store?.span

      if (span) {
        span.setTag(TEST_STATUS, status)

        span.finish()
        finishAllTraceSpans(span)
      }
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
      if (store && store.span) {
        const span = store.span
        span.setTag(TEST_STATUS, status)
        span.finish()
        finishAllTraceSpans(span)
      }
      this.tracer._exporter.flush(onFinish)
    })

    // TODO: do we need to flush? - probably not because it's just two spans in the main process
    this.addSub('ci:vitest:session:finish', (status) => {
      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.finish()
      this.testSessionSpan.finish()
      finishAllTraceSpans(this.testSessionSpan)
    })

    // this.addSub('ci:vitest:run-files', onFinish => {
    //   console.log('flushing in run files')
    //   this.tracer._exporter.flush(onFinish)
    // })
  }
}

module.exports = VitestPlugin
