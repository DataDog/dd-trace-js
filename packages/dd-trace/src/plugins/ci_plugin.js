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
  TEST_MODULE,
  getTestSuiteCommonTags,
  TEST_STATUS,
  TEST_SKIPPED_BY_ITR,
  ITR_CORRELATION_ID
} = require('./util/test')
const Plugin = require('./plugin')
const { COMPONENT } = require('../constants')
const log = require('../log')
const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_ITR_SKIPPED
} = require('../ci-visibility/telemetry')
const { CI_PROVIDER_NAME, GIT_REPOSITORY_URL, GIT_COMMIT_SHA, GIT_BRANCH, CI_WORKSPACE_PATH } = require('./util/tags')
const { OS_VERSION, OS_PLATFORM, OS_ARCHITECTURE, RUNTIME_NAME, RUNTIME_VERSION } = require('./util/env')

module.exports = class CiPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.rootDir = process.cwd() // fallback in case :session:start events are not emitted

    this.addSub(`ci:${this.constructor.id}:library-configuration`, ({ onDone }) => {
      if (!this.tracer._exporter || !this.tracer._exporter.getLibraryConfiguration) {
        return onDone({ err: new Error('CI Visibility was not initialized correctly') })
      }
      this.tracer._exporter.getLibraryConfiguration(this.testConfiguration, (err, libraryConfig) => {
        if (err) {
          log.error(`Library configuration could not be fetched. ${err.message}`)
        } else {
          this.libraryConfig = libraryConfig
        }
        onDone({ err, libraryConfig })
      })
    })

    this.addSub(`ci:${this.constructor.id}:test-suite:skippable`, ({ onDone }) => {
      if (!this.tracer._exporter?.getSkippableSuites) {
        return onDone({ err: new Error('CI Visibility was not initialized correctly') })
      }
      this.tracer._exporter.getSkippableSuites(this.testConfiguration, (err, skippableSuites, itrCorrelationId) => {
        if (err) {
          log.error(`Skippable suites could not be fetched. ${err.message}`)
        } else {
          this.itrCorrelationId = itrCorrelationId
        }
        onDone({ err, skippableSuites, itrCorrelationId })
      })
    })

    this.addSub(`ci:${this.constructor.id}:session:start`, ({ command, frameworkVersion, rootDir }) => {
      const childOf = getTestParentSpan(this.tracer)
      const testSessionSpanMetadata = getTestSessionCommonTags(command, frameworkVersion, this.constructor.id)
      const testModuleSpanMetadata = getTestModuleCommonTags(command, frameworkVersion, this.constructor.id)

      this.command = command
      this.frameworkVersion = frameworkVersion
      // only for playwright
      this.rootDir = rootDir

      this.testSessionSpan = this.tracer.startSpan(`${this.constructor.id}.test_session`, {
        childOf,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSessionSpanMetadata
        }
      })
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'session')
      this.testModuleSpan = this.tracer.startSpan(`${this.constructor.id}.test_module`, {
        childOf: this.testSessionSpan,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testModuleSpanMetadata
        }
      })
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'module')
    })

    this.addSub(`ci:${this.constructor.id}:itr:skipped-suites`, ({ skippedSuites, frameworkVersion }) => {
      const testCommand = this.testSessionSpan.context()._tags[TEST_COMMAND]
      skippedSuites.forEach((testSuite) => {
        const testSuiteMetadata = getTestSuiteCommonTags(testCommand, frameworkVersion, testSuite, this.constructor.id)
        if (this.itrCorrelationId) {
          testSuiteMetadata[ITR_CORRELATION_ID] = this.itrCorrelationId
        }

        this.tracer.startSpan(`${this.constructor.id}.test_suite`, {
          childOf: this.testModuleSpan,
          tags: {
            [COMPONENT]: this.constructor.id,
            ...this.testEnvironmentMetadata,
            ...testSuiteMetadata,
            [TEST_STATUS]: 'skip',
            [TEST_SKIPPED_BY_ITR]: 'true'
          }
        }).finish()
      })
      this.telemetry.count(TELEMETRY_ITR_SKIPPED, { testLevel: 'suite' }, skippedSuites.length)
    })

    this.addSub(`ci:${this.constructor.id}:known-tests`, ({ onDone }) => {
      if (!this.tracer._exporter?.getKnownTests) {
        return onDone({ err: new Error('CI Visibility was not initialized correctly') })
      }
      this.tracer._exporter.getKnownTests(this.testConfiguration, (err, knownTests) => {
        if (err) {
          log.error(`Known tests could not be fetched. ${err.message}`)
          this.libraryConfig.isEarlyFlakeDetectionEnabled = false
        }
        onDone({ err, knownTests })
      })
    })
  }

  get telemetry () {
    const testFramework = this.constructor.id
    return {
      ciVisEvent: function (name, testLevel, tags = {}) {
        incrementCountMetric(name, {
          testLevel,
          testFramework,
          isUnsupportedCIProvider: this.isUnsupportedCIProvider,
          ...tags
        })
      },
      count: function (name, tags, value = 1) {
        incrementCountMetric(name, tags, value)
      },
      distribution: function (name, tags, measure) {
        distributionMetric(name, tags, measure)
      }
    }
  }

  configure (config) {
    super.configure(config)
    this.testEnvironmentMetadata = getTestEnvironmentMetadata(this.constructor.id, this.config)

    const {
      [GIT_REPOSITORY_URL]: repositoryUrl,
      [GIT_COMMIT_SHA]: sha,
      [OS_VERSION]: osVersion,
      [OS_PLATFORM]: osPlatform,
      [OS_ARCHITECTURE]: osArchitecture,
      [RUNTIME_NAME]: runtimeName,
      [RUNTIME_VERSION]: runtimeVersion,
      [GIT_BRANCH]: branch,
      [CI_PROVIDER_NAME]: ciProviderName,
      [CI_WORKSPACE_PATH]: repositoryRoot
    } = this.testEnvironmentMetadata

    this.repositoryRoot = repositoryRoot || process.cwd()

    this.codeOwnersEntries = getCodeOwnersFileEntries(repositoryRoot)

    this.isUnsupportedCIProvider = !ciProviderName

    this.testConfiguration = {
      repositoryUrl,
      sha,
      osVersion,
      osPlatform,
      osArchitecture,
      runtimeName,
      runtimeVersion,
      branch,
      testLevel: 'suite'
    }
  }

  startTestSpan (testName, testSuite, testSuiteSpan, extraTags = {}) {
    const childOf = getTestParentSpan(this.tracer)

    let testTags = {
      ...getTestCommonTags(
        testName,
        testSuite,
        this.frameworkVersion,
        this.constructor.id
      ),
      [COMPONENT]: this.constructor.id,
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
        [TEST_MODULE]: this.constructor.id
      }
      if (testSuiteSpan.context()._parentId) {
        suiteTags[TEST_MODULE_ID] = testSuiteSpan.context()._parentId.toString(10)
      }

      testTags = {
        ...testTags,
        ...suiteTags
      }
    }

    this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'test', { hasCodeOwners: !!codeOwners })

    const testSpan = this.tracer
      .startSpan(`${this.constructor.id}.test`, {
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
