'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const { channel } = require('diagnostics_channel')

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
const { COMPONENT } = require('../../dd-trace/src/constants')

const { getSkippableSuites } = require('../../dd-trace/src/ci-visibility/intelligent-test-runner/get-skippable-suites')
const {
  getItrConfiguration
} = require('../../dd-trace/src/ci-visibility/intelligent-test-runner/get-itr-configuration')

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

    const gitMetadataUploadFinishCh = channel('ci:git-metadata-upload:finish')
    // `gitMetadataPromise` is used to wait until git metadata is uploaded to
    // proceed with calculating the suites to skip
    // TODO: add timeout after which the promise is resolved
    const gitMetadataPromise = new Promise(resolve => {
      gitMetadataUploadFinishCh.subscribe(err => {
        resolve(err)
      })
    })

    this._testSuites = new Map()
    this._testNameToParams = {}
    this.testEnvironmentMetadata = getTestEnvironmentMetadata('mocha', this.config)
    this.sourceRoot = process.cwd()
    this.codeOwnersEntries = getCodeOwnersFileEntries(this.sourceRoot)

    const {
      'git.repository_url': repositoryUrl,
      'git.commit.sha': sha,
      'os.version': osVersion,
      'os.platform': osPlatform,
      'os.architecture': osArchitecture,
      'runtime.name': runtimeName,
      'runtime.version': runtimeVersion,
      'git.branch': branch
    } = this.testEnvironmentMetadata

    const testConfiguration = {
      repositoryUrl,
      sha,
      osVersion,
      osPlatform,
      osArchitecture,
      runtimeName,
      runtimeVersion,
      branch
    }

    this.addSub('ci:mocha:test-suite:skippable', ({ onDone }) => {
      if (!this.config.isAgentlessEnabled || !this.config.isIntelligentTestRunnerEnabled) {
        onDone(null, [])
        return
      }
      // we only request after git upload has happened, if it didn't fail
      gitMetadataPromise.then((gitUploadError) => {
        if (gitUploadError) {
          return onDone(gitUploadError)
        }
        if (!this.itrConfig || !this.itrConfig.isSuitesSkippingEnabled) {
          return onDone(null, [])
        }
        getSkippableSuites({
          ...testConfiguration,
          url: this.config.url,
          site: this.config.site,
          env: this.tracer._env,
          service: this.config.service || this.tracer._service
        }, onDone)
      })
    })

    this.addSub('ci:mocha:configuration', ({ onDone }) => {
      if (!this.config.isAgentlessEnabled || !this.config.isIntelligentTestRunnerEnabled) {
        onDone(null, {})
        return
      }
      getItrConfiguration({
        ...testConfiguration,
        url: this.config.url,
        site: this.config.site,
        env: this.tracer._env,
        service: this.config.service || this.tracer._service
      }, (err, itrConfig) => {
        if (err) {
          onDone(err)
        } else {
          this.itrConfig = itrConfig
          onDone(null)
        }
      })
    })

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
          [COMPONENT]: this.constructor.name,
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
