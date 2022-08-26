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
  TEST_PARAMETERS,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
  TEST_CODE_OWNERS
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
    const { childOf, ...testSpanMetadata } = getTestSpanMetadata(this.tracer, test)

    const codeOwners = getCodeOwnersForFilename(test.suite, this.codeOwnersEntries)

    if (codeOwners) {
      testSpanMetadata[TEST_CODE_OWNERS] = codeOwners
    }

    const testSpan = this.tracer
      .startSpan('jest.test', {
        childOf,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSpanMetadata
        }
      })

    testSpan.context()._trace.origin = CI_APP_ORIGIN

    return testSpan
  }
}

module.exports = JestPlugin
