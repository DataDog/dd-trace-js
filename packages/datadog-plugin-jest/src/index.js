const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')

const {
  CI_APP_ORIGIN,
  TEST_STATUS,
  JEST_TEST_RUNNER,
  finishAllTraceSpans,
  getTestEnvironmentMetadata,
  getTestParentSpan,
  getTestCommonTags,
  getTestSessionCommonTags,
  getTestSuiteCommonTags,
  TEST_PARAMETERS,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
  TEST_CODE_OWNERS,
  TEST_SESSION_ID,
  TEST_SUITE_ID,
  TEST_COMMAND
} = require('../../dd-trace/src/plugins/util/test')

// https://github.com/facebook/jest/blob/d6ad15b0f88a05816c2fe034dd6900d28315d570/packages/jest-worker/src/types.ts#L38
const CHILD_MESSAGE_END = 2

function getTestSpanMetadata (tracer, test) {
  const childOf = getTestParentSpan(tracer)

  const { suite, name, runner, testParameters } = test

  const commonTags = getTestCommonTags(name, suite, tracer._version)

  return {
    childOf,
    ...commonTags,
    [JEST_TEST_RUNNER]: runner,
    [TEST_PARAMETERS]: testParameters
  }
}

class JestPlugin extends Plugin {
  static get name () {
    return 'jest'
  }

  constructor (...args) {
    super(...args)

    // Used to handle the end of a jest worker to be able to flush
    const handler = ([message]) => {
      if (message === CHILD_MESSAGE_END) {
        this.tracer._exporter._writer.flush(() => {
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

    this.addSub('ci:jest:session:start', (command) => {
      if (!this.config.isAgentlessEnabled) {
        return
      }
      const store = storage.getStore()
      const childOf = getTestParentSpan(this.tracer)
      const testSessionSpanMetadata = getTestSessionCommonTags(command, this.tracer._version)

      const testSessionSpan = this.tracer.startSpan('jest.test_session', {
        childOf,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSessionSpanMetadata
        }
      })
      this.enter(testSessionSpan, store)
    })

    this.addSub('ci:jest:session:finish', (status) => {
      if (!this.config.isAgentlessEnabled) {
        return
      }
      const testSessionSpan = storage.getStore().span
      testSessionSpan.setTag(TEST_STATUS, status)
      testSessionSpan.finish()
      finishAllTraceSpans(testSessionSpan)
      this.tracer._exporter._writer.flush()
    })

    // Test suites can be run in a different process from jest's main one.
    // This subscriber changes the configuration objects from jest to inject the trace id
    // of the test session to the processes that run the test suites.
    this.addSub('ci:jest:session:configuration', configs => {
      if (!this.config.isAgentlessEnabled) {
        return
      }
      const testSessionSpan = storage.getStore().span
      configs.forEach(config => {
        config._ddTestSessionId = testSessionSpan.context()._traceId.toString(10)
        config._ddTestCommand = testSessionSpan.context()._tags[TEST_COMMAND]
      })
    })

    this.addSub('ci:jest:test-suite:start', ({ testSuite, testEnvironmentOptions }) => {
      if (!this.config.isAgentlessEnabled) {
        return
      }

      const { _ddTestSessionId: testSessionId, _ddTestCommand: testCommand } = testEnvironmentOptions

      const store = storage.getStore()

      const testSessionSpanContext = this.tracer.extract('text_map', {
        'x-datadog-trace-id': testSessionId,
        'x-datadog-parent-id': '0000000000000000'
      })

      const testSuiteMetadata = getTestSuiteCommonTags(testCommand, this.tracer._version, testSuite)

      const testSuiteSpan = this.tracer.startSpan('jest.test_suite', {
        childOf: testSessionSpanContext,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
      this.enter(testSuiteSpan, store)
    })

    this.addSub('ci:jest:test-suite:finish', ({ status, errorMessage }) => {
      if (!this.config.isAgentlessEnabled) {
        return
      }
      const testSuiteSpan = storage.getStore().span
      testSuiteSpan.setTag(TEST_STATUS, status)
      if (errorMessage) {
        testSuiteSpan.setTag('error', new Error(errorMessage))
      }
      testSuiteSpan.finish()
    })

    this.addSub('ci:jest:test:code-coverage', (coverageFiles) => {
      if (!this.config.isAgentlessEnabled || !this.config.isIntelligentTestRunnerEnabled) {
        return
      }
      const testSpan = storage.getStore().span
      this.tracer._exporter.exportCoverage({ testSpan, coverageFiles })
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
    const suiteTags = {}
    const store = storage.getStore()
    const testSuiteSpan = store ? store.span : undefined
    if (testSuiteSpan) {
      const testSuiteId = testSuiteSpan.context()._spanId.toString(10)
      suiteTags[TEST_SUITE_ID] = testSuiteId
      suiteTags[TEST_SESSION_ID] = testSuiteSpan.context()._traceId.toString(10)
      suiteTags[TEST_COMMAND] = testSuiteSpan.context()._tags[TEST_COMMAND]
    }

    const {
      childOf,
      ...testSpanMetadata
    } = getTestSpanMetadata(this.tracer, test)

    const codeOwners = getCodeOwnersForFilename(test.suite, this.codeOwnersEntries)

    if (codeOwners) {
      testSpanMetadata[TEST_CODE_OWNERS] = codeOwners
    }

    const testSpan = this.tracer
      .startSpan('jest.test', {
        childOf,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSpanMetadata,
          ...suiteTags
        }
      })

    testSpan.context()._trace.origin = CI_APP_ORIGIN

    return testSpan
  }
}

module.exports = JestPlugin
