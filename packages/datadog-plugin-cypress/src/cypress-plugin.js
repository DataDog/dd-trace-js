const { getSessionStatus } = require('./utils')

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
  TEST_SOURCE_FILE
} = require('../../dd-trace/src/plugins/util/test')
const { isMarkedAsUnskippable } = require('../../datadog-plugin-jest/src/util')

const {
  TELEMETRY_EVENT_FINISHED
} = require('../../dd-trace/src/ci-visibility/telemetry')
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

const TEST_FRAMEWORK_NAME = 'cypress'

function getCypressVersion (details) {
  if (details && details.cypressVersion) {
    return details.cypressVersion
  }
  if (details && details.config && details.config.version) {
    return details.config.version
  }
  return ''
}

function getRootDir (details) {
  if (details && details.config) {
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

function getSkippableTests (isSuitesSkippingEnabled, tracer, testConfiguration) {
  if (!isSuitesSkippingEnabled) {
    return Promise.resolve({ skippableTests: [] })
  }
  return new Promise(resolve => {
    if (!tracer._tracer._exporter?.getLibraryConfiguration) {
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

class CypressPlugin {
  constructor () {
    this._isInit = false
  }
  init (attributes) {
    this._isInit = true
    this.isTestsSkipped = attributes.isTestsSkipped
    this.isSuitesSkippingEnabled = attributes.isSuitesSkippingEnabled
    this.isCodeCoverageEnabled = attributes.isCodeCoverageEnabled
    this.skippedTests = attributes.skippedTests
    this.hasForcedToRunSuites = attributes.hasForcedToRunSuites
    this.hasUnskippableSuites = attributes.hasUnskippableSuites
    this.ciVisEvent = attributes.ciVisEvent
    this.tracer = attributes.tracer


  }

  beforeRun (details) {
    return getLibraryConfiguration(this.tracer, this.testConfiguration).then(({ err, libraryConfig }) => {
      if (err) {
        log.error(err)
      } else {
        this.isSuitesSkippingEnabled = libraryConfig.isSuitesSkippingEnabled
        this.isCodeCoverageEnabled = libraryConfig.isCodeCoverageEnabled
      }

      return getSkippableTests(this.isSuitesSkippingEnabled, this.tracer, this.testConfiguration)
        .then(({ err, skippableTests, correlationId }) => {
          if (err) {
            log.error(err)
          } else {
            this.testsToSkip = skippableTests || []
            this.itrCorrelationId = correlationId
          }

          // `details.specs` are test files
          details.specs.forEach(({ absolute, relative }) => {
            const isUnskippableSuite = isMarkedAsUnskippable({ path: absolute })
            if (isUnskippableSuite) {
              this.unskippableSuites.push(relative)
            }
          })

          const childOf = getTestParentSpan(this.tracer)
          this.rootDir = getRootDir(details)

          this.command = getCypressCommand(details)
          this.frameworkVersion = getCypressVersion(details)

          const testSessionSpanMetadata = getTestSessionCommonTags(this.command, this.frameworkVersion, TEST_FRAMEWORK_NAME)
          const testModuleSpanMetadata = getTestModuleCommonTags(this.command, this.frameworkVersion, TEST_FRAMEWORK_NAME)

          this.testSessionSpan = this.tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_session`, {
            childOf,
            tags: {
              [COMPONENT]: TEST_FRAMEWORK_NAME,
              ...testEnvironmentMetadata,
              ...testSessionSpanMetadata
            }
          })
          this.ciVisEvent(TELEMETRY_EVENT_CREATED, 'session')

          this.testModuleSpan = tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_module`, {
            childOf: testSessionSpan,
            tags: {
              [COMPONENT]: TEST_FRAMEWORK_NAME,
              ...testEnvironmentMetadata,
              ...testModuleSpanMetadata
            }
          })
          this.ciVisEvent(TELEMETRY_EVENT_CREATED, 'module')

          cypressPlugin.init({
            testSessionSpan,
            testModuleSpan,
            isTestsSkipped,
            isSuitesSkippingEnabled,
            isCodeCoverageEnabled,
            skippedTests,
            hasForcedToRunSuites,
            hasUnskippableSuites,
            ciVisEvent,
            tracer
          })

          return details
        })
    })
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
}

module.exports = {
  cypressPlugin: new CypressPlugin()
}
