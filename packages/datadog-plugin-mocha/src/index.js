'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')

const {
  CI_APP_ORIGIN,
  TEST_CODE_OWNERS,
  TEST_SUITE,
  TEST_STATUS,
  TEST_PARAMETERS,
  finishAllTraceSpans,
  getTestEnvironmentMetadata,
  getTestSuitePath,
  getTestParentSpan,
  getTestParametersString,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
  getTestCommonTags,
  getTestSessionCommonTags,
  getTestSuiteCommonTags,
  TEST_SUITE_ID,
  TEST_SESSION_ID,
  TEST_COMMAND
} = require('../../dd-trace/src/plugins/util/test')

function getTestSpanMetadata (tracer, test, sourceRoot) {
  const childOf = getTestParentSpan(tracer)

  const { file: testSuiteAbsolutePath } = test
  const fullTestName = test.fullTitle()
  const testSuite = getTestSuitePath(testSuiteAbsolutePath, sourceRoot)

  const commonTags = getTestCommonTags(fullTestName, testSuite, tracer._version)

  return {
    childOf,
    ...commonTags
  }
}

class MochaPlugin extends Plugin {
  static get name () {
    return 'mocha'
  }

  constructor (...args) {
    super(...args)

    this._testSuites = new Map()
    this._testNameToParams = {}
    this.testEnvironmentMetadata = getTestEnvironmentMetadata('mocha', this.config)
    this.sourceRoot = process.cwd()
    this.codeOwnersEntries = getCodeOwnersFileEntries(this.sourceRoot)

    this.addSub('ci:mocha:run:start', (command) => {
      if (!this.config.isAgentlessEnabled) {
        return
      }
      const childOf = getTestParentSpan(this.tracer)
      const testSessionSpanMetadata = getTestSessionCommonTags(command, this.tracer._version)

      this.command = command
      this.testSessionSpan = this.tracer.startSpan('mocha.test_session', {
        childOf,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSessionSpanMetadata
        }
      })
    })

    this.addSub('ci:mocha:test-suite:start', (suite) => {
      if (!this.config.isAgentlessEnabled) {
        return
      }
      const store = storage.getStore()
      const testSuiteMetadata = getTestSuiteCommonTags(
        this.command,
        this.tracer._version,
        getTestSuitePath(suite.file, this.sourceRoot)
      )
      const testSuiteSpan = this.tracer.startSpan('mocha.test_suite', {
        childOf: this.testSessionSpan,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
      this.enter(testSuiteSpan, store)
      this._testSuites.set(suite.file, testSuiteSpan)
    })

    this.addSub('ci:mocha:test-suite:finish', (status) => {
      if (!this.config.isAgentlessEnabled) {
        return
      }
      const span = storage.getStore().span
      span.setTag(TEST_STATUS, status)
      span.finish()
    })

    this.addSub('ci:mocha:test-suite:error', (err) => {
      if (!this.config.isAgentlessEnabled) {
        return
      }
      const span = storage.getStore().span
      span.setTag('error', err)
    })

    this.addSub('ci:mocha:test:start', (test) => {
      const store = storage.getStore()
      const span = this.startTestSpan(test)

      this.enter(span, store)
    })

    this.addSub('ci:mocha:test:finish', (status) => {
      const span = storage.getStore().span

      span.setTag(TEST_STATUS, status)

      span.finish()
      finishAllTraceSpans(span)
    })

    this.addSub('ci:mocha:test:skip', (test) => {
      const store = storage.getStore()
      // skipped through it.skip, so the span is not created yet
      // for this test
      if (!store) {
        const testSpan = this.startTestSpan(test)
        this.enter(testSpan, store)
      }
    })

    this.addSub('ci:mocha:test:error', (err) => {
      if (err) {
        const span = storage.getStore().span
        if (err.constructor.name === 'Pending' && !this.forbidPending) {
          span.setTag(TEST_STATUS, 'skip')
        } else {
          span.setTag(TEST_STATUS, 'fail')
          span.setTag('error', err)
        }
      }
    })

    this.addSub('ci:mocha:test:parameterize', ({ name, params }) => {
      this._testNameToParams[name] = params
    })

    this.addSub('ci:mocha:run:finish', (status) => {
      if (this.testSessionSpan) {
        this.testSessionSpan.setTag(TEST_STATUS, status)
        this.testSessionSpan.finish()
        finishAllTraceSpans(this.testSessionSpan)
      }
      this.tracer._exporter._writer.flush()
    })
  }

  startTestSpan (test) {
    const testSuiteTags = {}
    const testSuiteSpan = this._testSuites.get(test.parent.file)

    if (testSuiteSpan) {
      const testSuiteId = testSuiteSpan.context()._spanId.toString(16)
      testSuiteTags[TEST_SUITE_ID] = testSuiteId
    }

    if (this.testSessionSpan) {
      const testSessionId = this.testSessionSpan.context()._traceId.toString(16)
      testSuiteTags[TEST_SESSION_ID] = testSessionId
      testSuiteTags[TEST_COMMAND] = this.command
    }

    const { childOf, ...testSpanMetadata } = getTestSpanMetadata(this.tracer, test, this.sourceRoot)

    const testParametersString = getTestParametersString(this._testNameToParams, test.title)
    if (testParametersString) {
      testSpanMetadata[TEST_PARAMETERS] = testParametersString
    }
    const codeOwners = getCodeOwnersForFilename(testSpanMetadata[TEST_SUITE], this.codeOwnersEntries)

    if (codeOwners) {
      testSpanMetadata[TEST_CODE_OWNERS] = codeOwners
    }

    const testSpan = this.tracer
      .startSpan('mocha.test', {
        childOf,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSpanMetadata,
          ...testSuiteTags
        }
      })
    testSpan.context()._trace.origin = CI_APP_ORIGIN

    return testSpan
  }
}

module.exports = MochaPlugin
