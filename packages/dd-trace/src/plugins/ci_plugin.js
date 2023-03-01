const {
  getTestEnvironmentMetadata,
  getCodeOwnersFileEntries,
  getTestParentSpan,
  getTestCommonTags,
  getCodeOwnersForFilename,
  TEST_CODE_OWNERS,
  CI_APP_ORIGIN,
  getTestSessionCommonTags,
  getTestModuleCommonTags,
  TEST_SUITE_ID,
  TEST_MODULE_ID,
  TEST_SESSION_ID,
  TEST_COMMAND,
  TEST_BUNDLE
} = require('./util/test')
const Plugin = require('./plugin')
const { COMPONENT } = require('../constants')
const log = require('../log')

module.exports = class CiPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.addSub(`ci:${this.constructor.name}:itr-configuration`, ({ onDone }) => {
      if (!this.tracer._exporter || !this.tracer._exporter.getItrConfiguration) {
        return onDone({ err: new Error('CI Visibility was not initialized correctly') })
      }
      this.tracer._exporter.getItrConfiguration(this.testConfiguration, (err, itrConfig) => {
        if (err) {
          log.error(`Error fetching intelligent test runner configuration: ${err.message}`)
        } else {
          this.itrConfig = itrConfig
        }
        onDone({ err, itrConfig })
      })
    })

    this.addSub(`ci:${this.constructor.name}:test-suite:skippable`, ({ onDone }) => {
      if (!this.tracer._exporter || !this.tracer._exporter.getSkippableSuites) {
        return onDone({ err: new Error('CI Visibility was not initialized correctly') })
      }
      this.tracer._exporter.getSkippableSuites(this.testConfiguration, (err, skippableSuites) => {
        if (err) {
          log.error(`Error fetching skippable suites: ${err.message}`)
        }
        onDone({ err, skippableSuites })
      })
    })

    this.addSub(`ci:${this.constructor.name}:session:start`, ({ command, frameworkVersion, rootDir }) => {
      const childOf = getTestParentSpan(this.tracer)
      const testSessionSpanMetadata = getTestSessionCommonTags(command, frameworkVersion)
      const testModuleSpanMetadata = getTestModuleCommonTags(command, frameworkVersion)

      this.command = command
      this.frameworkVersion = frameworkVersion
      // only for playwright
      this.rootDir = rootDir

      this.testSessionSpan = this.tracer.startSpan(`${this.constructor.name}.test_session`, {
        childOf,
        tags: {
          [COMPONENT]: this.constructor.name,
          ...this.testEnvironmentMetadata,
          ...testSessionSpanMetadata
        }
      })
      this.testModuleSpan = this.tracer.startSpan(`${this.constructor.name}.test_module`, {
        childOf: this.testSessionSpan,
        tags: {
          [COMPONENT]: this.constructor.name,
          ...this.testEnvironmentMetadata,
          ...testModuleSpanMetadata
        }
      })
    })
  }

  configure (config) {
    super.configure(config)
    this.testEnvironmentMetadata = getTestEnvironmentMetadata(this.constructor.name, this.config)
    this.codeOwnersEntries = getCodeOwnersFileEntries()

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

    this.testConfiguration = {
      repositoryUrl,
      sha,
      osVersion,
      osPlatform,
      osArchitecture,
      runtimeName,
      runtimeVersion,
      branch
    }
  }

  startTestSpan (testName, testSuite, testSuiteSpan, extraTags = {}) {
    const childOf = getTestParentSpan(this.tracer)

    let testTags = {
      ...getTestCommonTags(testName, testSuite, this.frameworkVersion),
      [COMPONENT]: this.constructor.name,
      ...extraTags
    }

    const codeOwners = getCodeOwnersForFilename(testSuite, this.codeOwnersEntries)
    if (codeOwners) {
      testTags[TEST_CODE_OWNERS] = codeOwners
    }

    if (testSuiteSpan) {
      // This is a hack to get good time resolution on test events, while keeping
      // the test event as the root span of its trace.
      childOf._trace.startTime = testSuiteSpan.context()._trace.startTime
      childOf._trace.ticks = testSuiteSpan.context()._trace.ticks

      const suiteTags = {
        [TEST_SUITE_ID]: testSuiteSpan.context().toSpanId(),
        [TEST_SESSION_ID]: testSuiteSpan.context().toTraceId(),
        [TEST_COMMAND]: testSuiteSpan.context()._tags[TEST_COMMAND],
        [TEST_BUNDLE]: testSuiteSpan.context()._tags[TEST_COMMAND]
      }
      if (testSuiteSpan.context()._parentId) {
        suiteTags[TEST_MODULE_ID] = testSuiteSpan.context()._parentId.toString(10)
      }

      testTags = {
        ...testTags,
        ...suiteTags
      }
    }

    const testSpan = this.tracer
      .startSpan(`${this.constructor.name}.test`, {
        childOf,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testTags
        }
      })

    testSpan.context()._trace.origin = CI_APP_ORIGIN

    return testSpan
  }
}
