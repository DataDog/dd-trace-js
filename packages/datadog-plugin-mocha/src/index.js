'use strict'

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

const {
  TEST_STATUS,
  TEST_PARAMETERS,
  finishAllTraceSpans,
  getTestSuitePath,
  getTestParentSpan,
  getTestParametersString,
  getTestSessionCommonTags,
  getTestSuiteCommonTags,
  TEST_SUITE_ID,
  TEST_SESSION_ID,
  TEST_COMMAND
} = require('../../dd-trace/src/plugins/util/test')
const { COMPONENT } = require('../../dd-trace/src/constants')

class MochaPlugin extends CiPlugin {
  static get name () {
    return 'mocha'
  }

  constructor (...args) {
    super(...args)

    this._testSuites = new Map()
    this._testNameToParams = {}
    this.sourceRoot = process.cwd()

    this.addSub('ci:mocha:test-suite:code-coverage', ({ coverageFiles, suiteFile }) => {
      if (!this.config.isAgentlessEnabled || !this.config.isIntelligentTestRunnerEnabled) {
        return
      }
      if (!this.itrConfig || !this.itrConfig.isCodeCoverageEnabled) {
        return
      }
      const testSuiteSpan = this._testSuites.get(suiteFile)

      const relativeCoverageFiles = [...coverageFiles, suiteFile]
        .map(filename => getTestSuitePath(filename, this.sourceRoot))

      this.tracer._exporter.exportCoverage({
        span: testSuiteSpan,
        coverageFiles: relativeCoverageFiles
      })
    })

    this.addSub('ci:mocha:session:start', (command) => {
      if (!this.config.isAgentlessEnabled) {
        return
      }
      const childOf = getTestParentSpan(this.tracer)
      const testSessionSpanMetadata = getTestSessionCommonTags(command, this.tracer._version)

      this.command = command
      this.testSessionSpan = this.tracer.startSpan('mocha.test_session', {
        childOf,
        tags: {
          [COMPONENT]: this.constructor.name,
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
          [COMPONENT]: this.constructor.name,
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
      // the test status of the suite may have been set in ci:mocha:test-suite:error already
      if (!span.context()._tags[TEST_STATUS]) {
        span.setTag(TEST_STATUS, status)
      }
      span.finish()
    })

    this.addSub('ci:mocha:test-suite:error', (err) => {
      if (!this.config.isAgentlessEnabled) {
        return
      }
      const span = storage.getStore().span
      span.setTag('error', err)
      span.setTag(TEST_STATUS, 'fail')
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

    this.addSub('ci:mocha:session:finish', (status) => {
      if (this.testSessionSpan) {
        this.testSessionSpan.setTag(TEST_STATUS, status)
        this.testSessionSpan.finish()
        finishAllTraceSpans(this.testSessionSpan)
      }
      this.tracer._exporter._writer.flush()
      this.itrConfig = null
    })
  }

  startTestSpan (test) {
    const testSuiteTags = {}
    const testSuiteSpan = this._testSuites.get(test.parent.file)
    if (testSuiteSpan) {
      const testSuiteId = testSuiteSpan.context()._spanId.toString(10)
      testSuiteTags[TEST_SUITE_ID] = testSuiteId
    }

    if (this.testSessionSpan) {
      const testSessionId = this.testSessionSpan.context()._traceId.toString(10)
      testSuiteTags[TEST_SESSION_ID] = testSessionId
      testSuiteTags[TEST_COMMAND] = this.command
    }

    const { file: testSuiteAbsolutePath } = test
    const fullTestName = test.fullTitle()
    const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.sourceRoot)

    const extraTags = {
      ...testSuiteTags
    }

    const testParametersString = getTestParametersString(this._testNameToParams, test.title)
    if (testParametersString) {
      extraTags[TEST_PARAMETERS] = testParametersString
    }

    return super.startTestSpan(fullTestName, testSuite, extraTags)
  }
}

module.exports = MochaPlugin
