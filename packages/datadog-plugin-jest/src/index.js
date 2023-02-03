const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

const {
  TEST_STATUS,
  JEST_TEST_RUNNER,
  finishAllTraceSpans,
  getTestEnvironmentMetadata,
  getTestParentSpan,
  getTestSessionCommonTags,
  getTestModuleCommonTags,
  getTestSuiteCommonTags,
  addIntelligentTestRunnerSpanTags,
  TEST_PARAMETERS,
  getCodeOwnersFileEntries,
  TEST_SESSION_ID,
  TEST_MODULE_ID,
  TEST_SUITE_ID,
  TEST_COMMAND,
  TEST_BUNDLE
} = require('../../dd-trace/src/plugins/util/test')
const { COMPONENT } = require('../../dd-trace/src/constants')

// https://github.com/facebook/jest/blob/d6ad15b0f88a05816c2fe034dd6900d28315d570/packages/jest-worker/src/types.ts#L38
const CHILD_MESSAGE_END = 2

class JestPlugin extends CiPlugin {
  static get name () {
    return 'jest'
  }

  constructor (...args) {
    super(...args)

    // Used to handle the end of a jest worker to be able to flush
    const handler = ([message]) => {
      if (message === CHILD_MESSAGE_END) {
        this.tracer._exporter.flush(() => {
          // eslint-disable-next-line
          // https://github.com/facebook/jest/blob/24ed3b5ecb419c023ee6fdbc838f07cc028fc007/packages/jest-worker/src/workers/processChild.ts#L118-L133
          // Only after the flush is done we clean up open handles
          // so the worker process can hopefully exit gracefully
          process.removeListener('message', handler)
        })
      }
    }
    process.on('message', handler)

    this.testEnvironmentMetadata = getTestEnvironmentMetadata('jest', this.config)
    this.codeOwnersEntries = getCodeOwnersFileEntries()

    this.addSub('ci:jest:session:start', ({ command, testFrameworkVersion }) => {
      const childOf = getTestParentSpan(this.tracer)
      const testSessionSpanMetadata = getTestSessionCommonTags(command, testFrameworkVersion)
      const testModuleSpanMetadata = getTestModuleCommonTags(command, testFrameworkVersion)

      this.testSessionSpan = this.tracer.startSpan('jest.test_session', {
        childOf,
        tags: {
          [COMPONENT]: this.constructor.name,
          ...this.testEnvironmentMetadata,
          ...testSessionSpanMetadata
        }
      })
      this.testModuleSpan = this.tracer.startSpan('jest.test_module', {
        childOf: this.testSessionSpan,
        tags: {
          [COMPONENT]: this.constructor.name,
          ...this.testEnvironmentMetadata,
          ...testModuleSpanMetadata
        }
      })
    })

    this.addSub('ci:jest:session:finish', ({
      status,
      isSuitesSkipped,
      isSuitesSkippingEnabled,
      isCodeCoverageEnabled,
      testCodeCoverageLinesTotal
    }) => {
      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.setTag(TEST_STATUS, status)

      addIntelligentTestRunnerSpanTags(
        this.testSessionSpan,
        this.testModuleSpan,
        { isSuitesSkipped, isSuitesSkippingEnabled, isCodeCoverageEnabled, testCodeCoverageLinesTotal }
      )

      this.testModuleSpan.finish()
      this.testSessionSpan.finish()
      finishAllTraceSpans(this.testSessionSpan)
      this.tracer._exporter.flush()
    })

    // Test suites can be run in a different process from jest's main one.
    // This subscriber changes the configuration objects from jest to inject the trace id
    // of the test session to the processes that run the test suites.
    this.addSub('ci:jest:session:configuration', configs => {
      configs.forEach(config => {
        config._ddTestSessionId = this.testSessionSpan.context().toTraceId()
        config._ddTestModuleId = this.testModuleSpan.context().toSpanId()
        config._ddTestCommand = this.testSessionSpan.context()._tags[TEST_COMMAND]
      })
    })

    this.addSub('ci:jest:test-suite:start', ({ testSuite, testEnvironmentOptions }) => {
      const {
        _ddTestSessionId: testSessionId,
        _ddTestCommand: testCommand,
        _ddTestModuleId: testModuleId
      } = testEnvironmentOptions

      const store = storage.getStore()

      const testSessionSpanContext = this.tracer.extract('text_map', {
        'x-datadog-trace-id': testSessionId,
        'x-datadog-parent-id': testModuleId
      })

      const testSuiteMetadata = getTestSuiteCommonTags(testCommand, this.tracer._version, testSuite)

      const testSuiteSpan = this.tracer.startSpan('jest.test_suite', {
        childOf: testSessionSpanContext,
        tags: {
          [COMPONENT]: this.constructor.name,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
      this.enter(testSuiteSpan, store)
    })

    this.addSub('ci:jest:test-suite:finish', ({ status, errorMessage }) => {
      const testSuiteSpan = storage.getStore().span
      testSuiteSpan.setTag(TEST_STATUS, status)
      if (errorMessage) {
        testSuiteSpan.setTag('error', new Error(errorMessage))
      }
      testSuiteSpan.finish()
      // Suites potentially run in a different process than the session,
      // so calling finishAllTraceSpans on the session span is not enough
      finishAllTraceSpans(testSuiteSpan)
    })

    /**
     * This can't use `this.itrConfig` like `ci:mocha:test-suite:code-coverage`
     * because this subscription happens in a different process from the one
     * fetching the ITR config.
     */
    this.addSub('ci:jest:test-suite:code-coverage', (coverageFiles) => {
      const testSuiteSpan = storage.getStore().span
      this.tracer._exporter.exportCoverage({ span: testSuiteSpan, coverageFiles })
    })

    this.addSub('ci:jest:test:start', (test) => {
      const store = storage.getStore()
      const span = this.startTestSpan(test)

      this.enter(span, store)
    })

    this.addSub('ci:jest:test:finish', (status) => {
      const span = storage.getStore().span
      span.setTag(TEST_STATUS, status)
      span.finish()
      finishAllTraceSpans(span)
    })

    this.addSub('ci:jest:test:err', (error) => {
      if (error) {
        const span = storage.getStore().span
        span.setTag(TEST_STATUS, 'fail')
        span.setTag('error', error)
      }
    })

    this.addSub('ci:jest:test:skip', (test) => {
      const span = this.startTestSpan(test)
      span.setTag(TEST_STATUS, 'skip')
      span.finish()
    })
  }

  startTestSpan (test) {
    let childOf
    const suiteTags = {}
    const store = storage.getStore()
    const testSuiteSpan = store ? store.span : undefined
    if (testSuiteSpan) {
      const testSuiteId = testSuiteSpan.context().toSpanId()
      suiteTags[TEST_SUITE_ID] = testSuiteId
      suiteTags[TEST_SESSION_ID] = testSuiteSpan.context().toTraceId()
      suiteTags[TEST_MODULE_ID] = testSuiteSpan.context()._parentId.toString(10)
      suiteTags[TEST_COMMAND] = testSuiteSpan.context()._tags[TEST_COMMAND]
      suiteTags[TEST_BUNDLE] = testSuiteSpan.context()._tags[TEST_COMMAND]
      // This is a hack to get good time resolution on test events, while keeping
      // the test event as the root span of its trace.
      childOf = getTestParentSpan(this.tracer)
      childOf._trace.startTime = testSuiteSpan.context()._trace.startTime
      childOf._trace.ticks = testSuiteSpan.context()._trace.ticks
    }

    const { suite, name, runner, testParameters } = test

    const extraTags = {
      [JEST_TEST_RUNNER]: runner,
      [TEST_PARAMETERS]: testParameters,
      ...suiteTags
    }

    return super.startTestSpan(name, suite, extraTags, childOf)
  }
}

module.exports = JestPlugin
