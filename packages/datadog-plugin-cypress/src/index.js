'use strict'

const { channel } = require('dc-polyfill')

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { appClosing: appClosingTelemetry } = require('../../dd-trace/src/telemetry')
const { getValueFromEnvSources } = require('../../dd-trace/src/config/helper')
const log = require('../../dd-trace/src/log')
const { ORIGIN_KEY, COMPONENT } = require('../../dd-trace/src/constants')

const {
  TEST_STATUS,
  TEST_IS_RUM_ACTIVE,
  TEST_CODE_OWNERS,
  CI_APP_ORIGIN,
  getTestParentSpan,
  getTestCommonTags,
  getTestSuiteCommonTags,
  TEST_SUITE,
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
  TEST_EARLY_FLAKE_ENABLED,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_HAS_DYNAMIC_NAME,
  DYNAMIC_NAME_RE,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_IS_MODIFIED,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  logDynamicNamesWarning,
  getSessionRequestErrorTags,
} = require('../../dd-trace/src/plugins/util/test')

const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED,
  TELEMETRY_ITR_FORCED_TO_RUN,
  TELEMETRY_CODE_COVERAGE_EMPTY,
  TELEMETRY_ITR_UNSKIPPABLE,
  TELEMETRY_CODE_COVERAGE_NUM_FILES,
  TELEMETRY_ITR_SKIPPED,
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_TEST_SESSION,
} = require('../../dd-trace/src/ci-visibility/telemetry')

const { isMarkedAsUnskippable } = require('../../datadog-plugin-jest/src/util')

const {
  resolveOriginalSourcePosition,
  resolveSourceLineForTest,
  shouldTrustInvocationDetailsLine,
} = require('./source-map-utils')

const TEST_FRAMEWORK_NAME = 'cypress'

const knownTestsCh = channel(`ci:${TEST_FRAMEWORK_NAME}:known-tests`)
const skippableSuitesCh = channel(`ci:${TEST_FRAMEWORK_NAME}:test-suite:skippable`)
const testManagementTestsCh = channel(`ci:${TEST_FRAMEWORK_NAME}:test-management-tests`)
const modifiedFilesCh = channel(`ci:${TEST_FRAMEWORK_NAME}:modified-files`)
const sessionStartCh = channel(`ci:${TEST_FRAMEWORK_NAME}:session:start`)

const CYPRESS_STATUS_TO_TEST_STATUS = {
  passed: 'pass',
  failed: 'fail',
  pending: 'skip',
  skipped: 'skip',
}

/**
 * @param {object|undefined} suiteStats
 * @returns {'pass'|'fail'|'skip'}
 */
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

/**
 * @param {object} summary
 * @returns {'pass'|'fail'|'skip'}
 */
function getSessionStatus (summary) {
  if (summary.totalFailed !== undefined && summary.totalFailed > 0) {
    return 'fail'
  }
  if (summary.totalSkipped !== undefined && summary.totalSkipped === summary.totalTests) {
    return 'skip'
  }
  return 'pass'
}

/**
 * @param {object|undefined} details - Cypress before:run details
 * @returns {string}
 */
function getCypressVersion (details) {
  if (details?.cypressVersion) {
    return details.cypressVersion
  }
  if (details?.config?.version) {
    return details.config.version
  }
  return ''
}

/**
 * @param {object|undefined} details - Cypress before:run details
 * @returns {string}
 */
function getRootDir (details) {
  if (details?.config) {
    return details.config.projectRoot || details.config.repoRoot || process.cwd()
  }
  return process.cwd()
}

/**
 * @param {object|undefined} details - Cypress before:run details
 * @returns {string}
 */
function getCypressCommand (details) {
  if (!details) {
    return TEST_FRAMEWORK_NAME
  }
  return `${TEST_FRAMEWORK_NAME} ${details.specPattern || ''}`
}

class CypressCiPlugin extends CiPlugin {
  static id = TEST_FRAMEWORK_NAME

  testsToSkip = []
  skippedTests = []
  isTestsSkipped = false
  unskippableSuites = []
  knownTestsByTestSuite = undefined
  testManagementTests = undefined
  modifiedFiles = []
  isTestIsolationEnabled = true
  rumFlushWaitMillis = undefined

  constructor (...args) {
    super(...args)

    this._resetRunState()

    this.addSub(`ci:${TEST_FRAMEWORK_NAME}:configure`, ({ cypressConfig }) => {
      // Reset all test-run state for a new run
      this.testsToSkip = []
      this.skippedTests = []
      this.isTestsSkipped = false
      this.unskippableSuites = []
      this.knownTestsByTestSuite = undefined
      this.testManagementTests = undefined
      this.modifiedFiles = []

      const isTestIsolationEnabled = cypressConfig?.testIsolation === undefined
        ? true
        : !!cypressConfig.testIsolation
      this.isTestIsolationEnabled = isTestIsolationEnabled

      if (!isTestIsolationEnabled) {
        log.warn('Test isolation is disabled, retries will not be enabled')
      }

      const envFlushWait = Number(getValueFromEnvSources('DD_CIVISIBILITY_RUM_FLUSH_WAIT_MILLIS'))
      this.rumFlushWaitMillis = Number.isFinite(envFlushWait) ? envFlushWait : undefined

      if (this.libraryConfig?.isFlakyTestRetriesEnabled && isTestIsolationEnabled) {
        const flakyTestRetriesCount = this.libraryConfig.flakyTestRetriesCount ?? 0
        if (cypressConfig.retries) {
          cypressConfig.retries.runMode = flakyTestRetriesCount
        }
      }
    })

    this.addSub(`ci:${TEST_FRAMEWORK_NAME}:before-run`, ({ details, onDone }) => {
      const self = this

      function done () {
        if (details.specs) {
          for (const { absolute, relative } of details.specs) {
            if (isMarkedAsUnskippable({ path: absolute })) {
              self.unskippableSuites.push(relative)
            }
          }
        }

        sessionStartCh.publish({
          command: getCypressCommand(details),
          frameworkVersion: getCypressVersion(details),
          rootDir: getRootDir(details),
          isEarlyFlakeDetectionEnabled: self.libraryConfig?.isEarlyFlakeDetectionEnabled || false,
        })

        onDone()
      }

      function afterModifiedFiles () {
        if (!self.libraryConfig?.isTestManagementEnabled) {
          return done()
        }
        if (!testManagementTestsCh.hasSubscribers) {
          return done()
        }
        testManagementTestsCh.publish({
          onDone: function (response) {
            if (!response.err) {
              self.testManagementTests = response.testManagementTests
            }
            done()
          },
        })
      }

      function afterSkippableSuites () {
        if (!self.libraryConfig?.isImpactedTestsEnabled) {
          return afterModifiedFiles()
        }
        if (!modifiedFilesCh.hasSubscribers) {
          if (self.libraryConfig) self.libraryConfig.isImpactedTestsEnabled = false
          return afterModifiedFiles()
        }
        modifiedFilesCh.publish({
          onDone: function (response) {
            if (response.err) {
              if (self.libraryConfig) self.libraryConfig.isImpactedTestsEnabled = false
            } else {
              self.modifiedFiles = response.modifiedFiles
            }
            afterModifiedFiles()
          },
        })
      }

      function afterKnownTests () {
        if (!self.libraryConfig?.isSuitesSkippingEnabled) {
          return afterSkippableSuites()
        }
        if (!skippableSuitesCh.hasSubscribers) {
          return afterSkippableSuites()
        }
        skippableSuitesCh.publish({
          onDone: function (response) {
            if (!response.err) {
              self.testsToSkip = response.skippableSuites || []
              incrementCountMetric(TELEMETRY_ITR_SKIPPED, { testLevel: 'test' }, self.testsToSkip.length)
            }
            afterSkippableSuites()
          },
        })
      }

      if (!self.libraryConfig?.isKnownTestsEnabled) {
        return afterKnownTests()
      }
      if (!knownTestsCh.hasSubscribers) {
        return afterKnownTests()
      }
      knownTestsCh.publish({
        onDone: function (response) {
          if (!response.err) {
            if (response.knownTests?.[TEST_FRAMEWORK_NAME]) {
              self.knownTestsByTestSuite = response.knownTests[TEST_FRAMEWORK_NAME]
            } else if (self.libraryConfig) {
              self.libraryConfig.isEarlyFlakeDetectionEnabled = false
              self.libraryConfig.isKnownTestsEnabled = false
            }
          }
          afterKnownTests()
        },
      })
    })

    // Additional session:start subscriber for cypress-specific tags.
    // CiPlugin's own subscriber (registered in super) runs first and creates the spans;
    // this subscriber adds cypress-specific tags afterwards.
    this.addSub(`ci:${TEST_FRAMEWORK_NAME}:session:start`, ({ isEarlyFlakeDetectionEnabled }) => {
      this._resetRunState()
      if (isEarlyFlakeDetectionEnabled && this.testSessionSpan) {
        this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ENABLED, 'true')
      }
    })

    this.addSub(`ci:${TEST_FRAMEWORK_NAME}:test-suite:start`, (ctx) => {
      const { payload } = ctx
      const { testSuite, testSuiteAbsolutePath } = payload

      if (!this.testSuiteSpan) {
        this.testSuiteSpan = this._createTestSuiteSpan(testSuite, testSuiteAbsolutePath)
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      }

      ctx.suitePayload = {
        isEarlyFlakeDetectionEnabled: this.libraryConfig?.isEarlyFlakeDetectionEnabled || false,
        knownTestsForSuite: this.knownTestsByTestSuite?.[testSuite] || [],
        earlyFlakeDetectionNumRetries: this.libraryConfig?.earlyFlakeDetectionNumRetries || 0,
        isKnownTestsEnabled: this.libraryConfig?.isKnownTestsEnabled || false,
        isTestManagementEnabled: this.libraryConfig?.isTestManagementEnabled || false,
        testManagementAttemptToFixRetries: this.libraryConfig?.testManagementAttemptToFixRetries || 0,
        testManagementTests: this._getTestSuiteProperties(testSuite),
        isImpactedTestsEnabled: this.libraryConfig?.isImpactedTestsEnabled || false,
        isModifiedTest: this._getIsTestModified(testSuiteAbsolutePath),
        repositoryRoot: this.repositoryRoot,
        isTestIsolationEnabled: this.isTestIsolationEnabled,
        rumFlushWaitMillis: this.rumFlushWaitMillis,
      }
    })

    this.addSub(`ci:${TEST_FRAMEWORK_NAME}:test:start`, (ctx) => {
      const { test } = ctx
      const { testName, testSuite, testSuiteAbsolutePath } = test

      const shouldSkip = this.testsToSkip.some(t => testName === t.name && testSuite === t.suite)
      const isUnskippable = this.unskippableSuites.includes(testSuite)
      const isForcedToRun = shouldSkip && isUnskippable
      const { isAttemptToFix, isDisabled, isQuarantined } = this._getTestProperties(testSuite, testName)

      if (shouldSkip && !isUnskippable) {
        this.skippedTests.push(test)
        this.isTestsSkipped = true
        ctx.result = { shouldSkip: true }
        return
      }

      // For disabled tests (not attemptToFix), skip them
      if (!isAttemptToFix && isDisabled) {
        ctx.result = { shouldSkip: true }
        return
      }

      if (this.activeTestSpan) {
        ctx.result = { traceId: this.activeTestSpan.context().toTraceId() }
        return
      }

      const testSuiteTags = {
        [TEST_COMMAND]: this.command,
        [TEST_MODULE]: TEST_FRAMEWORK_NAME,
      }
      if (this.testSuiteSpan) {
        testSuiteTags[TEST_SUITE_ID] = this.testSuiteSpan.context().toSpanId()
      }
      if (this.testSessionSpan && this.testModuleSpan) {
        testSuiteTags[TEST_SESSION_ID] = this.testSessionSpan.context().toTraceId()
        testSuiteTags[TEST_MODULE_ID] = this.testModuleSpan.context().toSpanId()
        Object.assign(testSuiteTags, getSessionRequestErrorTags(this.testSessionSpan))
        if (!this.testSuiteSpan) {
          testSuiteTags[TEST_SUITE_ID] = this.testModuleSpan.context().toSpanId()
        }
      }

      const childOf = getTestParentSpan(this.tracer)
      const { resource, ...testSpanMetadata } = getTestCommonTags(
        testName, testSuite, this.frameworkVersion, TEST_FRAMEWORK_NAME
      )

      const testSourceFile = testSuiteAbsolutePath && this.repositoryRoot
        ? getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
        : testSuite

      if (testSourceFile) {
        testSpanMetadata[TEST_SOURCE_FILE] = testSourceFile
      }

      const codeOwners = this.getCodeOwners({
        [TEST_SOURCE_FILE]: testSourceFile,
        [TEST_SUITE]: testSuite,
      })
      if (codeOwners) {
        testSpanMetadata[TEST_CODE_OWNERS] = codeOwners
      }

      if (isUnskippable) {
        this._hasUnskippableSuites = true
        incrementCountMetric(TELEMETRY_ITR_UNSKIPPABLE, { testLevel: 'suite' })
        testSpanMetadata[TEST_ITR_UNSKIPPABLE] = 'true'
      }

      if (isForcedToRun) {
        this._hasForcedToRunSuites = true
        incrementCountMetric(TELEMETRY_ITR_FORCED_TO_RUN, { testLevel: 'suite' })
        testSpanMetadata[TEST_ITR_FORCED_RUN] = 'true'
      }

      if (isDisabled) {
        testSpanMetadata[TEST_MANAGEMENT_IS_DISABLED] = 'true'
      }

      if (isQuarantined) {
        testSpanMetadata[TEST_MANAGEMENT_IS_QUARANTINED] = 'true'
      }

      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'test', { hasCodeOwners: !!codeOwners })

      this.activeTestSpan = this.tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test`, {
        childOf,
        tags: {
          [COMPONENT]: TEST_FRAMEWORK_NAME,
          [ORIGIN_KEY]: CI_APP_ORIGIN,
          ...testSpanMetadata,
          ...this.testEnvironmentMetadata,
          ...testSuiteTags,
        },
        integrationName: TEST_FRAMEWORK_NAME,
      })

      ctx.result = { traceId: this.activeTestSpan.context().toTraceId() }
    })

    this.addSub(`ci:${TEST_FRAMEWORK_NAME}:coverage`, ({ test, coverage }) => {
      const { testSuiteAbsolutePath } = test
      if (!this.tracer._exporter?.exportCoverage) {
        return
      }
      const coverageFiles = getCoveredFilenamesFromCoverage(coverage)
      const relativeCoverageFiles = [...coverageFiles, testSuiteAbsolutePath].map(
        file => getTestSuitePath(file, this.repositoryRoot || this.rootDir)
      )
      if (!relativeCoverageFiles.length) {
        incrementCountMetric(TELEMETRY_CODE_COVERAGE_EMPTY)
      }
      distributionMetric(TELEMETRY_CODE_COVERAGE_NUM_FILES, {}, relativeCoverageFiles.length)
      if (!this.testSuiteSpan || !this.activeTestSpan) {
        return
      }
      const { _traceId, _spanId } = this.testSuiteSpan.context()
      const formattedCoverage = {
        sessionId: _traceId,
        suiteId: _spanId,
        testId: this.activeTestSpan.context()._spanId,
        files: relativeCoverageFiles,
      }
      this.tracer._exporter.exportCoverage(formattedCoverage)
    })

    this.addSub(`ci:${TEST_FRAMEWORK_NAME}:test:finish`, ({ test }) => {
      if (!this.activeTestSpan) {
        log.warn('There is no active test span in ci:cypress:test:finish handler')
        return
      }

      const {
        state,
        error,
        isRUMActive,
        testSourceLine,
        testSourceStack,
        testSuite,
        testSuiteAbsolutePath,
        testName,
        testItTitle,
        isNew,
        isEfdRetry,
        isAttemptToFix,
        isModified,
        isQuarantined: isQuarantinedFromSupport,
      } = test

      const earlyFlakeDetectionNumRetries = this.libraryConfig?.earlyFlakeDetectionNumRetries || 0
      const isFlakyTestRetriesEnabled =
        this.libraryConfig?.isFlakyTestRetriesEnabled && this.isTestIsolationEnabled
      const flakyTestRetriesCount = isFlakyTestRetriesEnabled
        ? (this.libraryConfig.flakyTestRetriesCount ?? 0)
        : 0
      const testManagementAttemptToFixRetries =
        this.libraryConfig?.testManagementAttemptToFixRetries || 0

      const testStatus = CYPRESS_STATUS_TO_TEST_STATUS[state]
      this.activeTestSpan.setTag(TEST_STATUS, testStatus)

      if (this._testStatuses[testName]) {
        this._testStatuses[testName].push(testStatus)
      } else {
        this._testStatuses[testName] = [testStatus]
      }
      const testStatuses = this._testStatuses[testName]

      if (error) {
        this.activeTestSpan.setTag('error', error)
      }
      if (isRUMActive) {
        this.activeTestSpan.setTag(TEST_IS_RUM_ACTIVE, 'true')
      }

      // Source-line resolution strategy:
      // 1. If plain JS and no source map, trust invocationDetails.line directly.
      // 2. Otherwise, try invocationDetails.stack line mapped through source map.
      // 3. If that fails, scan generated file for it/test/specify declaration by test name.
      // 4. If declaration found:
      //    - .ts file: use declaration line directly.
      //    - .js file: map declaration line through source map.
      // 5. If all fail, keep original invocationDetails.line.
      if (testSourceLine) {
        let resolvedLine = testSourceLine
        if (testSuiteAbsolutePath && testItTitle) {
          const shouldTrustInvocationDetails = shouldTrustInvocationDetailsLine(
            testSuiteAbsolutePath, testSourceLine
          )
          if (!shouldTrustInvocationDetails) {
            resolvedLine = resolveSourceLineForTest(
              testSuiteAbsolutePath,
              testItTitle,
              testSourceStack
            ) ?? testSourceLine
          }
        }
        this.activeTestSpan.setTag(TEST_SOURCE_START, resolvedLine)
      }

      if (isNew) {
        this.activeTestSpan.setTag(TEST_IS_NEW, 'true')
        if (isEfdRetry) {
          this.activeTestSpan.setTag(TEST_IS_RETRY, 'true')
          this.activeTestSpan.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.efd)
        }
        if (DYNAMIC_NAME_RE.test(testName)) {
          this.activeTestSpan.setTag(TEST_HAS_DYNAMIC_NAME, 'true')
          if (testStatuses.length === 1) {
            this._newTestsWithDynamicNames.add(`${testSuite} › ${testName}`)
          }
        }
      }
      if (isModified) {
        this.activeTestSpan.setTag(TEST_IS_MODIFIED, 'true')
        if (isEfdRetry) {
          this.activeTestSpan.setTag(TEST_IS_RETRY, 'true')
          this.activeTestSpan.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.efd)
        }
      }

      if ((isNew || isModified) && earlyFlakeDetectionNumRetries > 0) {
        const isLastEfdAttempt = testStatuses.length === earlyFlakeDetectionNumRetries + 1
        if (isLastEfdAttempt && testStatuses.every(status => status === 'fail')) {
          this.activeTestSpan.setTag(TEST_HAS_FAILED_ALL_RETRIES, 'true')
        }
      }

      if (isAttemptToFix) {
        this.activeTestSpan.setTag(TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX, 'true')
        if (testStatuses.length > 1) {
          this.activeTestSpan.setTag(TEST_IS_RETRY, 'true')
          this.activeTestSpan.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atf)
        }
        const isLastAttempt = testStatuses.length === testManagementAttemptToFixRetries + 1
        if (isLastAttempt) {
          if (testStatuses.includes('fail')) {
            this.activeTestSpan.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
          }
          if (testStatuses.every(status => status === 'fail')) {
            this.activeTestSpan.setTag(TEST_HAS_FAILED_ALL_RETRIES, 'true')
          } else if (testStatuses.every(status => status === 'pass')) {
            this.activeTestSpan.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'true')
          }
        }
      }

      if (isFlakyTestRetriesEnabled && !isAttemptToFix && !isEfdRetry &&
        flakyTestRetriesCount > 0 && testStatuses.length === flakyTestRetriesCount + 1 &&
        testStatuses.every(status => status === 'fail')) {
        this.activeTestSpan.setTag(TEST_HAS_FAILED_ALL_RETRIES, 'true')
      }

      if (isQuarantinedFromSupport) {
        this.activeTestSpan.setTag(TEST_MANAGEMENT_IS_QUARANTINED, 'true')
      }

      const activeSpanTags = this.activeTestSpan.context()._tags
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', {
        hasCodeOwners: !!activeSpanTags[TEST_CODE_OWNERS],
        isNew,
        isRum: isRUMActive,
        browserDriver: TEST_FRAMEWORK_NAME,
        isQuarantined: isQuarantinedFromSupport,
        isModified,
        isDisabled: activeSpanTags[TEST_MANAGEMENT_IS_DISABLED] === 'true',
      })

      const finishedTest = {
        testName,
        testStatus,
        finishTime: this.activeTestSpan._getTime(),
        testSpan: this.activeTestSpan,
        isEfdRetry,
        isAttemptToFix,
        isFlakyTestRetriesEnabled,
      }

      if (this._finishedTestsByFile[testSuite]) {
        this._finishedTestsByFile[testSuite].push(finishedTest)
      } else {
        this._finishedTestsByFile[testSuite] = [finishedTest]
      }

      this.activeTestSpan = null
    })

    this.addSub(`ci:${TEST_FRAMEWORK_NAME}:after-spec`, ({ spec, results }) => {
      const itrCorrelationId = this.itrCorrelationId
      const testsToSkip = this.testsToSkip
      const testManagementTests = this.testManagementTests

      const { tests, stats } = results || {}
      const cypressTests = tests || []
      const finishedTests = this._finishedTestsByFile[spec.relative] || []

      if (!this.testSuiteSpan) {
        log.warn('There was an error creating the test suite event.')
        this.testSuiteSpan = this._createTestSuiteSpan(spec.relative, spec.absolute)
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      }

      // Create skipped spans for tests that didn't go through dd:afterEach
      for (const { title } of cypressTests) {
        const cypressTestName = title.join(' ')
        const isTestFinished = finishedTests.find(({ testName }) => cypressTestName === testName)

        if (isTestFinished) {
          continue
        }

        const isSkippedByItr = testsToSkip?.find(
          test => cypressTestName === test.name && spec.relative === test.suite
        )
        const testSourceFile = spec.absolute && this.repositoryRoot
          ? getTestSuitePath(spec.absolute, this.repositoryRoot)
          : spec.relative

        const suiteTestManagement = testManagementTests?.cypress?.suites?.[spec.relative]?.tests || {}
        const {
          attempt_to_fix: isAttemptToFix,
          disabled: isDisabled,
          quarantined: isQuarantined,
        } = suiteTestManagement[cypressTestName]?.properties || {}

        const skippedTestSpan = this._createSkippedTestSpan({
          testName: cypressTestName,
          testSuite: spec.relative,
          testSourceFile,
        })

        skippedTestSpan.setTag(TEST_STATUS, 'skip')
        if (isSkippedByItr) {
          skippedTestSpan.setTag(TEST_SKIPPED_BY_ITR, 'true')
        }
        if (itrCorrelationId) {
          skippedTestSpan.setTag(ITR_CORRELATION_ID, itrCorrelationId)
        }

        if (!isAttemptToFix && isDisabled) {
          skippedTestSpan.setTag(TEST_MANAGEMENT_IS_DISABLED, 'true')
        } else if (isQuarantined) {
          skippedTestSpan.setTag(TEST_MANAGEMENT_IS_QUARANTINED, 'true')
        }

        skippedTestSpan.finish()
      }

      let latestError

      const finishedTestsByTestName = finishedTests.reduce((acc, finishedTest) => {
        if (!acc[finishedTest.testName]) {
          acc[finishedTest.testName] = []
        }
        acc[finishedTest.testName].push(finishedTest)
        return acc
      }, {})

      for (const [testName, finishedTestAttempts] of Object.entries(finishedTestsByTestName)) {
        for (const [attemptIndex, finishedTest] of finishedTestAttempts.entries()) {
          const cypressTest = cypressTests.find(test => test.title.join(' ') === testName)
          if (!cypressTest) {
            continue
          }
          let cypressTestStatus = CYPRESS_STATUS_TO_TEST_STATUS[cypressTest.state]
          if (cypressTest.attempts && cypressTest.attempts[attemptIndex]) {
            cypressTestStatus = CYPRESS_STATUS_TO_TEST_STATUS[cypressTest.attempts[attemptIndex].state]
            const isAtrRetry = attemptIndex > 0 &&
              finishedTest.isFlakyTestRetriesEnabled &&
              !finishedTest.isAttemptToFix &&
              !finishedTest.isEfdRetry
            if (attemptIndex > 0) {
              finishedTest.testSpan.setTag(TEST_IS_RETRY, 'true')
              if (finishedTest.isEfdRetry) {
                finishedTest.testSpan.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.efd)
              } else if (isAtrRetry) {
                finishedTest.testSpan.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atr)
              } else {
                finishedTest.testSpan.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.ext)
              }
            }
          }
          if (cypressTest.displayError) {
            latestError = new Error(cypressTest.displayError)
          }
          const isQuarantinedTest =
            finishedTest.testSpan?.context()?._tags?.[TEST_MANAGEMENT_IS_QUARANTINED] === 'true'
          if (cypressTestStatus !== finishedTest.testStatus && !isQuarantinedTest) {
            finishedTest.testSpan.setTag(TEST_STATUS, cypressTestStatus)
            finishedTest.testSpan.setTag('error', latestError)
          }
          if (itrCorrelationId) {
            finishedTest.testSpan.setTag(ITR_CORRELATION_ID, itrCorrelationId)
          }
          const resolvedSpecPosition = spec.absolute
            ? resolveOriginalSourcePosition(spec.absolute, 1)
            : null
          const resolvedSpecAbsolutePath = resolvedSpecPosition
            ? resolvedSpecPosition.sourceFile
            : spec.absolute
          const testSourceFile = resolvedSpecAbsolutePath && this.repositoryRoot
            ? getTestSuitePath(resolvedSpecAbsolutePath, this.repositoryRoot)
            : spec.relative
          if (testSourceFile) {
            finishedTest.testSpan.setTag(TEST_SOURCE_FILE, testSourceFile)
          }
          const codeOwners = this.getCodeOwners({
            [TEST_SOURCE_FILE]: testSourceFile,
            [TEST_SUITE]: spec.relative,
          })
          if (codeOwners) {
            finishedTest.testSpan.setTag(TEST_CODE_OWNERS, codeOwners)
          }

          finishedTest.testSpan.finish(finishedTest.finishTime)
        }
      }

      if (this.testSuiteSpan) {
        const status = getSuiteStatus(stats)
        this.testSuiteSpan.setTag(TEST_STATUS, status)
        if (latestError) {
          this.testSuiteSpan.setTag('error', latestError)
        }
        this.testSuiteSpan.finish()
        this.testSuiteSpan = null
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
      }
    })

    this.addSub(`ci:${TEST_FRAMEWORK_NAME}:test:add-tags`, (tags) => {
      if (this.activeTestSpan) {
        this.activeTestSpan.addTags(tags)
      }
    })

    this.addSub(`ci:${TEST_FRAMEWORK_NAME}:session:finish`, ({ suiteStats, onDone }) => {
      const isSuitesSkipped = this.isTestsSkipped
      const isSuitesSkippingEnabled = this.libraryConfig?.isSuitesSkippingEnabled || false
      const isCodeCoverageEnabled = this.libraryConfig?.isCodeCoverageEnabled || false
      const skippedTestsCount = this.skippedTests.length
      const isTestManagementTestsEnabled = this.libraryConfig?.isTestManagementEnabled || false

      if (this.testSessionSpan && this.testModuleSpan) {
        const testStatus = getSessionStatus(suiteStats)
        this.testModuleSpan.setTag(TEST_STATUS, testStatus)
        this.testSessionSpan.setTag(TEST_STATUS, testStatus)

        addIntelligentTestRunnerSpanTags(
          this.testSessionSpan,
          this.testModuleSpan,
          {
            isSuitesSkipped,
            isSuitesSkippingEnabled,
            isCodeCoverageEnabled,
            skippingType: 'test',
            skippingCount: skippedTestsCount,
            hasForcedToRunSuites: this._hasForcedToRunSuites,
            hasUnskippableSuites: this._hasUnskippableSuites,
          }
        )

        if (isTestManagementTestsEnabled) {
          this.testSessionSpan.setTag(TEST_MANAGEMENT_ENABLED, 'true')
        }

        logDynamicNamesWarning(this._newTestsWithDynamicNames)

        this.testModuleSpan.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
        this.testSessionSpan.finish()
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
        incrementCountMetric(TELEMETRY_TEST_SESSION, {
          provider: this.ciProviderName,
          autoInjected: !!getValueFromEnvSources('DD_CIVISIBILITY_AUTO_INSTRUMENTATION_PROVIDER'),
        })
        finishAllTraceSpans(this.testSessionSpan)
      }

      const finishAfterRun = () => {
        appClosingTelemetry()
        onDone()
      }

      const exporter = this.tracer._exporter
      if (!exporter) {
        finishAfterRun()
        return
      }
      if (exporter.flush) {
        exporter.flush(() => {
          finishAfterRun()
        })
      } else if (exporter._writer) {
        exporter._writer.flush(() => {
          finishAfterRun()
        })
      } else {
        finishAfterRun()
      }
    })
  }

  /**
   * @param {import('../../../dd-trace/src/config/config-base')} config
   */
  configure (config) {
    super.configure(config)
    if (this.testConfiguration) {
      this.testConfiguration.testLevel = 'test'
    }
    if (config.isServiceUserProvided !== undefined && this.testEnvironmentMetadata) {
      this.testEnvironmentMetadata[DD_TEST_IS_USER_PROVIDED_SERVICE] =
        config.isServiceUserProvided ? 'true' : 'false'
    }
  }

  /**
   * @param {string} testSuite - relative suite path
   * @param {string} [testSuiteAbsolutePath]
   * @returns {object} span
   */
  _createTestSuiteSpan (testSuite, testSuiteAbsolutePath) {
    const testSuiteSpanMetadata =
      getTestSuiteCommonTags(this.command, this.frameworkVersion, testSuite, TEST_FRAMEWORK_NAME)

    if (testSuiteAbsolutePath) {
      const resolvedSuitePosition = resolveOriginalSourcePosition(testSuiteAbsolutePath, 1)
      const resolvedSuiteAbsolutePath =
        resolvedSuitePosition ? resolvedSuitePosition.sourceFile : testSuiteAbsolutePath
      const testSourceFile = getTestSuitePath(resolvedSuiteAbsolutePath, this.repositoryRoot)
      testSuiteSpanMetadata[TEST_SOURCE_FILE] = testSourceFile
      testSuiteSpanMetadata[TEST_SOURCE_START] = 1
      const codeOwners = this.getCodeOwners({
        [TEST_SOURCE_FILE]: testSourceFile,
        [TEST_SUITE]: testSuite,
      })
      if (codeOwners) {
        testSuiteSpanMetadata[TEST_CODE_OWNERS] = codeOwners
      }
    }

    return this.tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_suite`, {
      childOf: this.testModuleSpan,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        ...this.testEnvironmentMetadata,
        ...testSuiteSpanMetadata,
      },
      integrationName: TEST_FRAMEWORK_NAME,
    })
  }

  /**
   * Creates a test span for a test that did not go through dd:afterEach (e.g. ITR-skipped).
   * @param {object} params
   * @param {string} params.testName
   * @param {string} params.testSuite
   * @param {string} [params.testSourceFile]
   * @returns {object} span
   */
  _createSkippedTestSpan ({ testName, testSuite, testSourceFile }) {
    const testSuiteTags = {
      [TEST_COMMAND]: this.command,
      [TEST_MODULE]: TEST_FRAMEWORK_NAME,
    }
    if (this.testSuiteSpan) {
      testSuiteTags[TEST_SUITE_ID] = this.testSuiteSpan.context().toSpanId()
    }
    if (this.testSessionSpan && this.testModuleSpan) {
      testSuiteTags[TEST_SESSION_ID] = this.testSessionSpan.context().toTraceId()
      testSuiteTags[TEST_MODULE_ID] = this.testModuleSpan.context().toSpanId()
      Object.assign(testSuiteTags, getSessionRequestErrorTags(this.testSessionSpan))
      if (!this.testSuiteSpan) {
        testSuiteTags[TEST_SUITE_ID] = this.testModuleSpan.context().toSpanId()
      }
    }

    const childOf = getTestParentSpan(this.tracer)
    const { resource, ...testSpanMetadata } = getTestCommonTags(
      testName, testSuite, this.frameworkVersion, TEST_FRAMEWORK_NAME
    )

    if (testSourceFile) {
      testSpanMetadata[TEST_SOURCE_FILE] = testSourceFile
    }

    return this.tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test`, {
      childOf,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        [ORIGIN_KEY]: CI_APP_ORIGIN,
        ...testSpanMetadata,
        ...this.testEnvironmentMetadata,
        ...testSuiteTags,
      },
      integrationName: TEST_FRAMEWORK_NAME,
    })
  }

  /**
   * @param {string|undefined} testSuiteAbsolutePath
   * @returns {boolean}
   */
  _getIsTestModified (testSuiteAbsolutePath) {
    if (!testSuiteAbsolutePath || !this.modifiedFiles) {
      return false
    }
    const relativeTestSuitePath = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
    const lines = this.modifiedFiles[relativeTestSuitePath]
    return !!lines && lines.length > 0
  }

  /**
   * @param {string} testSuite
   * @returns {object}
   */
  _getTestSuiteProperties (testSuite) {
    return this.testManagementTests?.cypress?.suites?.[testSuite]?.tests || {}
  }

  /**
   * @param {string} testSuite
   * @param {string} testName
   * @returns {{ isAttemptToFix: boolean|undefined, isDisabled: boolean|undefined, isQuarantined: boolean|undefined }}
   */
  _getTestProperties (testSuite, testName) {
    const { attempt_to_fix: isAttemptToFix, disabled: isDisabled, quarantined: isQuarantined } =
      this._getTestSuiteProperties(testSuite)?.[testName]?.properties || {}
    return { isAttemptToFix, isDisabled, isQuarantined }
  }

  _resetRunState () {
    this.testSuiteSpan = null
    this.activeTestSpan = null
    this._finishedTestsByFile = {}
    this._testStatuses = {}
    this._newTestsWithDynamicNames = new Set()
    this._hasForcedToRunSuites = false
    this._hasUnskippableSuites = false
  }
}

module.exports = CypressCiPlugin
