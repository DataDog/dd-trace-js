const {
  TEST_STATUS,
  TEST_IS_RUM_ACTIVE,
  TEST_CODE_OWNERS,
  getTestEnvironmentMetadata,
  CI_APP_ORIGIN,
  getTestParentSpan,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
  getTestCommonTags,
  getTestSessionCommonTags,
  getTestModuleCommonTags,
  getTestSuiteCommonTags,
  TEST_SUITE_ID,
  TEST_MODULE_ID,
  TEST_SESSION_ID,
  TEST_COMMAND,
  TEST_MODULE,
  TEST_SOURCE_START,
  finishAllTraceSpans,
  getCoveredFilenamesFromCoverage,
  getTestSuitePath,
  addIntelligentTestRunnerSpanTags,
  TEST_SKIPPED_BY_ITR,
  TEST_ITR_UNSKIPPABLE,
  TEST_ITR_FORCED_RUN,
  ITR_CORRELATION_ID,
  TEST_SOURCE_FILE,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED
} = require('../../dd-trace/src/plugins/util/test')
const { isMarkedAsUnskippable } = require('../../datadog-plugin-jest/src/util')
const { ORIGIN_KEY, COMPONENT } = require('../../dd-trace/src/constants')
const { appClosing: appClosingTelemetry } = require('../../dd-trace/src/telemetry')
const log = require('../../dd-trace/src/log')

const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED,
  TELEMETRY_ITR_FORCED_TO_RUN,
  TELEMETRY_CODE_COVERAGE_EMPTY,
  TELEMETRY_ITR_UNSKIPPABLE,
  TELEMETRY_CODE_COVERAGE_NUM_FILES,
  incrementCountMetric,
  distributionMetric
} = require('../../dd-trace/src/ci-visibility/telemetry')

const {
  GIT_REPOSITORY_URL,
  GIT_COMMIT_SHA,
  GIT_BRANCH,
  CI_PROVIDER_NAME,
  CI_WORKSPACE_PATH
} = require('../../dd-trace/src/plugins/util/tags')
const {
  OS_VERSION,
  OS_PLATFORM,
  OS_ARCHITECTURE,
  RUNTIME_NAME,
  RUNTIME_VERSION
} = require('../../dd-trace/src/plugins/util/env')

const TEST_FRAMEWORK_NAME = 'cypress'

const CYPRESS_STATUS_TO_TEST_STATUS = {
  passed: 'pass',
  failed: 'fail',
  pending: 'skip',
  skipped: 'skip'
}

function getSessionStatus (summary) {
  if (summary.totalFailed !== undefined && summary.totalFailed > 0) {
    return 'fail'
  }
  if (summary.totalSkipped !== undefined && summary.totalSkipped === summary.totalTests) {
    return 'skip'
  }
  return 'pass'
}

function getCypressVersion (details) {
  if (details?.cypressVersion) {
    return details.cypressVersion
  }
  if (details?.config?.version) {
    return details.config.version
  }
  return ''
}

function getRootDir (details) {
  if (details?.config) {
    return details.config.projectRoot || details.config.repoRoot || process.cwd()
  }
  return process.cwd()
}

function getCypressCommand (details) {
  if (!details) {
    return TEST_FRAMEWORK_NAME
  }
  return `${TEST_FRAMEWORK_NAME} ${details.specPattern || ''}`
}

function getLibraryConfiguration (tracer, testConfiguration) {
  return new Promise(resolve => {
    if (!tracer._tracer._exporter?.getLibraryConfiguration) {
      return resolve({ err: new Error('CI Visibility was not initialized correctly') })
    }

    tracer._tracer._exporter.getLibraryConfiguration(testConfiguration, (err, libraryConfig) => {
      resolve({ err, libraryConfig })
    })
  })
}

function getSkippableTests (tracer, testConfiguration) {
  return new Promise(resolve => {
    if (!tracer._tracer._exporter?.getSkippableSuites) {
      return resolve({ err: new Error('CI Visibility was not initialized correctly') })
    }
    tracer._tracer._exporter.getSkippableSuites(testConfiguration, (err, skippableTests, correlationId) => {
      resolve({
        err,
        skippableTests,
        correlationId
      })
    })
  })
}

function getKnownTests (tracer, testConfiguration) {
  return new Promise(resolve => {
    if (!tracer._tracer._exporter?.getKnownTests) {
      return resolve({ err: new Error('CI Visibility was not initialized correctly') })
    }
    tracer._tracer._exporter.getKnownTests(testConfiguration, (err, knownTests) => {
      resolve({
        err,
        knownTests
      })
    })
  })
}

function getSuiteStatus (suiteStats) {
  if (!suiteStats) {
    return 'skip'
  }
  if (suiteStats.failures !== undefined && suiteStats.failures > 0) {
    return 'fail'
  }
  if (suiteStats.tests !== undefined &&
    (suiteStats.tests === suiteStats.pending || suiteStats.tests === suiteStats.skipped)) {
    return 'skip'
  }
  return 'pass'
}

class CypressPlugin {
  constructor () {
    this._isInit = false
    this.testEnvironmentMetadata = getTestEnvironmentMetadata(TEST_FRAMEWORK_NAME)

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

    this.repositoryRoot = repositoryRoot
    this.isUnsupportedCIProvider = !ciProviderName
    this.codeOwnersEntries = getCodeOwnersFileEntries(repositoryRoot)

    this.testConfiguration = {
      repositoryUrl,
      sha,
      osVersion,
      osPlatform,
      osArchitecture,
      runtimeName,
      runtimeVersion,
      branch,
      testLevel: 'test'
    }
    this.finishedTestsByFile = {}

    this.isTestsSkipped = false
    this.isSuitesSkippingEnabled = false
    this.isCodeCoverageEnabled = false
    this.isEarlyFlakeDetectionEnabled = false
    this.earlyFlakeDetectionNumRetries = 0
    this.testsToSkip = []
    this.skippedTests = []
    this.hasForcedToRunSuites = false
    this.hasUnskippableSuites = false
    this.unskippableSuites = []
    this.knownTests = []
  }

  init (tracer, cypressConfig) {
    this._isInit = true
    this.tracer = tracer
    this.cypressConfig = cypressConfig
  }

  getTestSuiteSpan (suite) {
    const testSuiteSpanMetadata =
      getTestSuiteCommonTags(this.command, this.frameworkVersion, suite, TEST_FRAMEWORK_NAME)
    this.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
    return this.tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_suite`, {
      childOf: this.testModuleSpan,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        ...this.testEnvironmentMetadata,
        ...testSuiteSpanMetadata
      }
    })
  }

  getTestSpan (testName, testSuite, isUnskippable, isForcedToRun) {
    const testSuiteTags = {
      [TEST_COMMAND]: this.command,
      [TEST_COMMAND]: this.command,
      [TEST_MODULE]: TEST_FRAMEWORK_NAME
    }
    if (this.testSuiteSpan) {
      testSuiteTags[TEST_SUITE_ID] = this.testSuiteSpan.context().toSpanId()
    }
    if (this.testSessionSpan && this.testModuleSpan) {
      testSuiteTags[TEST_SESSION_ID] = this.testSessionSpan.context().toTraceId()
      testSuiteTags[TEST_MODULE_ID] = this.testModuleSpan.context().toSpanId()
      // If testSuiteSpan couldn't be created, we'll use the testModuleSpan as the parent
      if (!this.testSuiteSpan) {
        testSuiteTags[TEST_SUITE_ID] = this.testModuleSpan.context().toSpanId()
      }
    }

    const childOf = getTestParentSpan(this.tracer)
    const {
      resource,
      ...testSpanMetadata
    } = getTestCommonTags(testName, testSuite, this.cypressConfig.version, TEST_FRAMEWORK_NAME)

    const codeOwners = getCodeOwnersForFilename(testSuite, this.codeOwnersEntries)

    if (codeOwners) {
      testSpanMetadata[TEST_CODE_OWNERS] = codeOwners
    }

    if (isUnskippable) {
      this.hasUnskippableSuites = true
      incrementCountMetric(TELEMETRY_ITR_UNSKIPPABLE, { testLevel: 'suite' })
      testSpanMetadata[TEST_ITR_UNSKIPPABLE] = 'true'
    }

    if (isForcedToRun) {
      this.hasForcedToRunSuites = true
      incrementCountMetric(TELEMETRY_ITR_FORCED_TO_RUN, { testLevel: 'suite' })
      testSpanMetadata[TEST_ITR_FORCED_RUN] = 'true'
    }

    this.ciVisEvent(TELEMETRY_EVENT_CREATED, 'test', { hasCodeOwners: !!codeOwners })

    return this.tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test`, {
      childOf,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        [ORIGIN_KEY]: CI_APP_ORIGIN,
        ...testSpanMetadata,
        ...this.testEnvironmentMetadata,
        ...testSuiteTags
      }
    })
  }

  ciVisEvent (name, testLevel, tags = {}) {
    incrementCountMetric(name, {
      testLevel,
      testFramework: 'cypress',
      isUnsupportedCIProvider: this.isUnsupportedCIProvider,
      ...tags
    })
  }

  isNewTest (testName, testSuite) {
    return !this.knownTestsByTestSuite?.[testSuite]?.includes(testName)
  }

  async beforeRun (details) {
    this.command = getCypressCommand(details)
    this.frameworkVersion = getCypressVersion(details)
    this.rootDir = getRootDir(details)

    const libraryConfigurationResponse = await getLibraryConfiguration(this.tracer, this.testConfiguration)

    if (libraryConfigurationResponse.err) {
      log.error(libraryConfigurationResponse.err)
    } else {
      const {
        libraryConfig: {
          isSuitesSkippingEnabled,
          isCodeCoverageEnabled,
          isEarlyFlakeDetectionEnabled,
          earlyFlakeDetectionNumRetries
        }
      } = libraryConfigurationResponse
      this.isSuitesSkippingEnabled = isSuitesSkippingEnabled
      this.isCodeCoverageEnabled = isCodeCoverageEnabled
      this.isEarlyFlakeDetectionEnabled = isEarlyFlakeDetectionEnabled
      this.earlyFlakeDetectionNumRetries = earlyFlakeDetectionNumRetries
    }

    if (this.isEarlyFlakeDetectionEnabled) {
      const knownTestsResponse = await getKnownTests(
        this.tracer,
        this.testConfiguration
      )
      if (knownTestsResponse.err) {
        log.error(knownTestsResponse.err)
        this.isEarlyFlakeDetectionEnabled = false
      } else {
        // We use TEST_FRAMEWORK_NAME for the name of the module
        this.knownTestsByTestSuite = knownTestsResponse.knownTests[TEST_FRAMEWORK_NAME]
      }
    }

    if (this.isSuitesSkippingEnabled) {
      const skippableTestsResponse = await getSkippableTests(
        this.tracer,
        this.testConfiguration
      )
      if (skippableTestsResponse.err) {
        log.error(skippableTestsResponse.err)
      } else {
        const { skippableTests, correlationId } = skippableTestsResponse
        this.testsToSkip = skippableTests || []
        this.itrCorrelationId = correlationId
      }
    }

    // `details.specs` are test files
    details.specs?.forEach(({ absolute, relative }) => {
      const isUnskippableSuite = isMarkedAsUnskippable({ path: absolute })
      if (isUnskippableSuite) {
        this.unskippableSuites.push(relative)
      }
    })

    const childOf = getTestParentSpan(this.tracer)

    const testSessionSpanMetadata =
      getTestSessionCommonTags(this.command, this.frameworkVersion, TEST_FRAMEWORK_NAME)
    const testModuleSpanMetadata =
      getTestModuleCommonTags(this.command, this.frameworkVersion, TEST_FRAMEWORK_NAME)

    if (this.isEarlyFlakeDetectionEnabled) {
      testSessionSpanMetadata[TEST_EARLY_FLAKE_ENABLED] = 'true'
    }

    this.testSessionSpan = this.tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_session`, {
      childOf,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        ...this.testEnvironmentMetadata,
        ...testSessionSpanMetadata
      }
    })
    this.ciVisEvent(TELEMETRY_EVENT_CREATED, 'session')

    this.testModuleSpan = this.tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_module`, {
      childOf: this.testSessionSpan,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        ...this.testEnvironmentMetadata,
        ...testModuleSpanMetadata
      }
    })
    this.ciVisEvent(TELEMETRY_EVENT_CREATED, 'module')

    return details
  }

  afterRun (suiteStats) {
    if (!this._isInit) {
      log.warn('Attemping to call afterRun without initializating the plugin first')
      return
    }
    if (this.testSessionSpan && this.testModuleSpan) {
      const testStatus = getSessionStatus(suiteStats)
      this.testModuleSpan.setTag(TEST_STATUS, testStatus)
      this.testSessionSpan.setTag(TEST_STATUS, testStatus)

      addIntelligentTestRunnerSpanTags(
        this.testSessionSpan,
        this.testModuleSpan,
        {
          isSuitesSkipped: this.isTestsSkipped,
          isSuitesSkippingEnabled: this.isSuitesSkippingEnabled,
          isCodeCoverageEnabled: this.isCodeCoverageEnabled,
          skippingType: 'test',
          skippingCount: this.skippedTests.length,
          hasForcedToRunSuites: this.hasForcedToRunSuites,
          hasUnskippableSuites: this.hasUnskippableSuites
        }
      )

      this.testModuleSpan.finish()
      this.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
      this.testSessionSpan.finish()
      this.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')

      finishAllTraceSpans(this.testSessionSpan)
    }

    return new Promise(resolve => {
      const exporter = this.tracer._tracer._exporter
      if (!exporter) {
        return resolve(null)
      }
      if (exporter.flush) {
        exporter.flush(() => {
          appClosingTelemetry()
          resolve(null)
        })
      } else if (exporter._writer) {
        exporter._writer.flush(() => {
          appClosingTelemetry()
          resolve(null)
        })
      }
    })
  }

  afterSpec (spec, results) {
    const { tests, stats } = results || {}
    const cypressTests = tests || []
    const finishedTests = this.finishedTestsByFile[spec.relative] || []

    if (!this.testSuiteSpan) {
      // dd:testSuiteStart hasn't been triggered for whatever reason
      // We will create the test suite span on the spot if that's the case
      log.warn('There was an error creating the test suite event.')
      this.testSuiteSpan = this.getTestSuiteSpan(spec.relative)
    }

    // Get tests that didn't go through `dd:afterEach`
    // and create a skipped test span for each of them
    cypressTests.filter(({ title }) => {
      const cypressTestName = title.join(' ')
      const isTestFinished = finishedTests.find(({ testName }) => cypressTestName === testName)

      return !isTestFinished
    }).forEach(({ title }) => {
      const cypressTestName = title.join(' ')
      const isSkippedByItr = this.testsToSkip.find(test =>
        cypressTestName === test.name && spec.relative === test.suite
      )
      const skippedTestSpan = this.getTestSpan(cypressTestName, spec.relative)
      if (spec.absolute && this.repositoryRoot) {
        skippedTestSpan.setTag(TEST_SOURCE_FILE, getTestSuitePath(spec.absolute, this.repositoryRoot))
      } else {
        skippedTestSpan.setTag(TEST_SOURCE_FILE, spec.relative)
      }
      skippedTestSpan.setTag(TEST_STATUS, 'skip')
      if (isSkippedByItr) {
        skippedTestSpan.setTag(TEST_SKIPPED_BY_ITR, 'true')
      }
      if (this.itrCorrelationId) {
        skippedTestSpan.setTag(ITR_CORRELATION_ID, this.itrCorrelationId)
      }
      skippedTestSpan.finish()
    })

    // Make sure that reported test statuses are the same as Cypress reports.
    // This is not always the case, such as when an `after` hook fails:
    // Cypress will report the last run test as failed, but we don't know that yet at `dd:afterEach`
    let latestError
    finishedTests.forEach((finishedTest) => {
      const cypressTest = cypressTests.find(test => test.title.join(' ') === finishedTest.testName)
      if (!cypressTest) {
        return
      }
      if (cypressTest.displayError) {
        latestError = new Error(cypressTest.displayError)
      }
      const cypressTestStatus = CYPRESS_STATUS_TO_TEST_STATUS[cypressTest.state]
      // update test status
      if (cypressTestStatus !== finishedTest.testStatus) {
        finishedTest.testSpan.setTag(TEST_STATUS, cypressTestStatus)
        finishedTest.testSpan.setTag('error', latestError)
      }
      if (this.itrCorrelationId) {
        finishedTest.testSpan.setTag(ITR_CORRELATION_ID, this.itrCorrelationId)
      }
      if (spec.absolute && this.repositoryRoot) {
        finishedTest.testSpan.setTag(TEST_SOURCE_FILE, getTestSuitePath(spec.absolute, this.repositoryRoot))
      } else {
        finishedTest.testSpan.setTag(TEST_SOURCE_FILE, spec.relative)
      }
      finishedTest.testSpan.finish(finishedTest.finishTime)
    })

    if (this.testSuiteSpan) {
      const status = getSuiteStatus(stats)
      this.testSuiteSpan.setTag(TEST_STATUS, status)

      if (latestError) {
        this.testSuiteSpan.setTag('error', latestError)
      }
      this.testSuiteSpan.finish()
      this.testSuiteSpan = null
      this.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
    }
  }

  getTasks () {
    return {
      'dd:testSuiteStart': (testSuite) => {
        const suitePayload = {
          isEarlyFlakeDetectionEnabled: this.isEarlyFlakeDetectionEnabled,
          knownTestsForSuite: this.knownTestsByTestSuite?.[testSuite] || [],
          earlyFlakeDetectionNumRetries: this.earlyFlakeDetectionNumRetries
        }

        if (this.testSuiteSpan) {
          return suitePayload
        }
        this.testSuiteSpan = this.getTestSuiteSpan(testSuite)
        return suitePayload
      },
      'dd:beforeEach': (test) => {
        const { testName, testSuite } = test
        const shouldSkip = !!this.testsToSkip.find(test => {
          return testName === test.name && testSuite === test.suite
        })
        const isUnskippable = this.unskippableSuites.includes(testSuite)
        const isForcedToRun = shouldSkip && isUnskippable

        // skip test
        if (shouldSkip && !isUnskippable) {
          this.skippedTests.push(test)
          this.isTestsSkipped = true
          return { shouldSkip: true }
        }

        if (!this.activeTestSpan) {
          this.activeTestSpan = this.getTestSpan(testName, testSuite, isUnskippable, isForcedToRun)
        }

        return this.activeTestSpan ? { traceId: this.activeTestSpan.context().toTraceId() } : {}
      },
      'dd:afterEach': ({ test, coverage }) => {
        const { state, error, isRUMActive, testSourceLine, testSuite, testName, isNew, isEfdRetry } = test
        if (this.activeTestSpan) {
          if (coverage && this.isCodeCoverageEnabled && this.tracer._tracer._exporter?.exportCoverage) {
            const coverageFiles = getCoveredFilenamesFromCoverage(coverage)
            const relativeCoverageFiles = coverageFiles.map(file => getTestSuitePath(file, this.rootDir))
            if (!relativeCoverageFiles.length) {
              incrementCountMetric(TELEMETRY_CODE_COVERAGE_EMPTY)
            }
            distributionMetric(TELEMETRY_CODE_COVERAGE_NUM_FILES, {}, relativeCoverageFiles.length)
            const { _traceId, _spanId } = this.testSuiteSpan.context()
            const formattedCoverage = {
              sessionId: _traceId,
              suiteId: _spanId,
              testId: this.activeTestSpan.context()._spanId,
              files: relativeCoverageFiles
            }
            this.tracer._tracer._exporter.exportCoverage(formattedCoverage)
          }
          const testStatus = CYPRESS_STATUS_TO_TEST_STATUS[state]
          this.activeTestSpan.setTag(TEST_STATUS, testStatus)

          if (error) {
            this.activeTestSpan.setTag('error', error)
          }
          if (isRUMActive) {
            this.activeTestSpan.setTag(TEST_IS_RUM_ACTIVE, 'true')
          }
          if (testSourceLine) {
            this.activeTestSpan.setTag(TEST_SOURCE_START, testSourceLine)
          }
          if (isNew) {
            this.activeTestSpan.setTag(TEST_IS_NEW, 'true')
            if (isEfdRetry) {
              this.activeTestSpan.setTag(TEST_IS_RETRY, 'true')
            }
          }
          const finishedTest = {
            testName,
            testStatus,
            finishTime: this.activeTestSpan._getTime(), // we store the finish time here
            testSpan: this.activeTestSpan
          }
          if (this.finishedTestsByFile[testSuite]) {
            this.finishedTestsByFile[testSuite].push(finishedTest)
          } else {
            this.finishedTestsByFile[testSuite] = [finishedTest]
          }
          // test spans are finished at after:spec
        }
        this.activeTestSpan = null
        this.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test')
        return null
      },
      'dd:addTags': (tags) => {
        if (this.activeTestSpan) {
          this.activeTestSpan.addTags(tags)
        }
        return null
      }
    }
  }
}

module.exports = new CypressPlugin()
