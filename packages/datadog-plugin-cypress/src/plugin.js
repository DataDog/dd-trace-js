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
const { ORIGIN_KEY, COMPONENT } = require('../../dd-trace/src/constants')
const log = require('../../dd-trace/src/log')
const NoopTracer = require('../../dd-trace/src/noop/tracer')
const { isMarkedAsUnskippable } = require('../../datadog-plugin-jest/src/util')
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
const { appClosing: appClosingTelemetry } = require('../../dd-trace/src/telemetry')
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

const { getSessionStatus, getCiVisEvent } = require('./utils')
const { cypressPlugin } = require('./cypress-plugin')

const TEST_FRAMEWORK_NAME = 'cypress'

const CYPRESS_STATUS_TO_TEST_STATUS = {
  passed: 'pass',
  failed: 'fail',
  pending: 'skip',
  skipped: 'skip'
}

function getTestSpanMetadata (tracer, testName, testSuite, cypressConfig) {
  const childOf = getTestParentSpan(tracer)

  const commonTags = getTestCommonTags(testName, testSuite, cypressConfig.version, TEST_FRAMEWORK_NAME)

  return {
    childOf,
    ...commonTags
  }
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

const noopTask = {
  'dd:testSuiteStart': () => {
    return null
  },
  'dd:beforeEach': () => {
    return {}
  },
  'dd:afterEach': () => {
    return null
  },
  'dd:addTags': () => {
    return null
  }
}

module.exports = (on, config) => {
  let isTestsSkipped = false
  const skippedTests = []
  const tracer = require('../../dd-trace')

  // The tracer was not init correctly for whatever reason (such as invalid DD_SITE)
  if (tracer._tracer instanceof NoopTracer) {
    // We still need to register these tasks or the support file will fail
    return on('task', noopTask)
  }

  const testEnvironmentMetadata = getTestEnvironmentMetadata(TEST_FRAMEWORK_NAME)

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
  } = testEnvironmentMetadata

  const isUnsupportedCIProvider = !ciProviderName

  const finishedTestsByFile = {}

  const testConfiguration = {
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

  const codeOwnersEntries = getCodeOwnersFileEntries(repositoryRoot)

  let activeSpan = null
  let testSessionSpan = null
  let testModuleSpan = null
  let testSuiteSpan = null
  let command = null
  let frameworkVersion
  let rootDir
  let isSuitesSkippingEnabled = false
  let isCodeCoverageEnabled = false
  let testsToSkip = []
  let itrCorrelationId = ''
  const unskippableSuites = []
  let hasForcedToRunSuites = false
  let hasUnskippableSuites = false

  const ciVisEvent = getCiVisEvent(isUnsupportedCIProvider)

  function getTestSpan (testName, testSuite, isUnskippable, isForcedToRun) {
    const testSuiteTags = {
      [TEST_COMMAND]: command,
      [TEST_COMMAND]: command,
      [TEST_MODULE]: TEST_FRAMEWORK_NAME
    }
    if (testSuiteSpan) {
      testSuiteTags[TEST_SUITE_ID] = testSuiteSpan.context().toSpanId()
    }
    if (testSessionSpan && testModuleSpan) {
      testSuiteTags[TEST_SESSION_ID] = testSessionSpan.context().toTraceId()
      testSuiteTags[TEST_MODULE_ID] = testModuleSpan.context().toSpanId()
      // If testSuiteSpan couldn't be created, we'll use the testModuleSpan as the parent
      if (!testSuiteSpan) {
        testSuiteTags[TEST_SUITE_ID] = testModuleSpan.context().toSpanId()
      }
    }

    const {
      childOf,
      resource,
      ...testSpanMetadata
    } = getTestSpanMetadata(tracer, testName, testSuite, config)

    const codeOwners = getCodeOwnersForFilename(testSuite, codeOwnersEntries)

    if (codeOwners) {
      testSpanMetadata[TEST_CODE_OWNERS] = codeOwners
    }

    if (isUnskippable) {
      hasUnskippableSuites = true
      incrementCountMetric(TELEMETRY_ITR_UNSKIPPABLE, { testLevel: 'suite' })
      testSpanMetadata[TEST_ITR_UNSKIPPABLE] = 'true'
    }

    if (isForcedToRun) {
      hasForcedToRunSuites = true
      incrementCountMetric(TELEMETRY_ITR_FORCED_TO_RUN, { testLevel: 'suite' })
      testSpanMetadata[TEST_ITR_FORCED_RUN] = 'true'
    }

    ciVisEvent(TELEMETRY_EVENT_CREATED, 'test', { hasCodeOwners: !!codeOwners })

    return tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test`, {
      childOf,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        [ORIGIN_KEY]: CI_APP_ORIGIN,
        ...testSpanMetadata,
        ...testEnvironmentMetadata,
        ...testSuiteTags
      }
    })
  }

  function getTestSuiteSpan (suite) {
    const testSuiteSpanMetadata = getTestSuiteCommonTags(command, frameworkVersion, suite, TEST_FRAMEWORK_NAME)
    ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
    return tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_suite`, {
      childOf: testModuleSpan,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        ...testEnvironmentMetadata,
        ...testSuiteSpanMetadata
      }
    })
  }

  on('before:run', cypressPlugin.beforeRun.bind(cypressPlugin))

  on('after:spec', (spec, { tests, stats }) => {
    const cypressTests = tests || []
    const finishedTests = finishedTestsByFile[spec.relative] || []

    if (!testSuiteSpan) {
      // dd:testSuiteStart hasn't been triggered for whatever reason
      // We will create the test suite span on the spot if that's the case
      log.warn('There was an error creating the test suite event.')
      testSuiteSpan = getTestSuiteSpan(spec.relative)
    }

    // Get tests that didn't go through `dd:afterEach`
    // and create a skipped test span for each of them
    cypressTests.filter(({ title }) => {
      const cypressTestName = title.join(' ')
      const isTestFinished = finishedTests.find(({ testName }) => cypressTestName === testName)

      return !isTestFinished
    }).forEach(({ title }) => {
      const cypressTestName = title.join(' ')
      const isSkippedByItr = testsToSkip.find(test =>
        cypressTestName === test.name && spec.relative === test.suite
      )
      const skippedTestSpan = getTestSpan(cypressTestName, spec.relative)
      if (spec.absolute && repositoryRoot) {
        skippedTestSpan.setTag(TEST_SOURCE_FILE, getTestSuitePath(spec.absolute, repositoryRoot))
      } else {
        skippedTestSpan.setTag(TEST_SOURCE_FILE, spec.relative)
      }
      skippedTestSpan.setTag(TEST_STATUS, 'skip')
      if (isSkippedByItr) {
        skippedTestSpan.setTag(TEST_SKIPPED_BY_ITR, 'true')
      }
      if (itrCorrelationId) {
        skippedTestSpan.setTag(ITR_CORRELATION_ID, itrCorrelationId)
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
      if (itrCorrelationId) {
        finishedTest.testSpan.setTag(ITR_CORRELATION_ID, itrCorrelationId)
      }
      if (spec.absolute && repositoryRoot) {
        finishedTest.testSpan.setTag(TEST_SOURCE_FILE, getTestSuitePath(spec.absolute, repositoryRoot))
      } else {
        finishedTest.testSpan.setTag(TEST_SOURCE_FILE, spec.relative)
      }
      finishedTest.testSpan.finish(finishedTest.finishTime)
    })

    if (testSuiteSpan) {
      const status = getSuiteStatus(stats)
      testSuiteSpan.setTag(TEST_STATUS, status)

      if (latestError) {
        testSuiteSpan.setTag('error', latestError)
      }
      testSuiteSpan.finish()
      testSuiteSpan = null
      ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
    }
  })

  on('after:run', cypressPlugin.afterRun.bind(cypressPlugin))

  on('task', {
    'dd:testSuiteStart': (suite) => {
      if (testSuiteSpan) {
        return null
      }
      testSuiteSpan = getTestSuiteSpan(suite)
      return null
    },
    'dd:beforeEach': (test) => {
      const { testName, testSuite } = test
      const shouldSkip = !!testsToSkip.find(test => {
        return testName === test.name && testSuite === test.suite
      })
      const isUnskippable = unskippableSuites.includes(testSuite)
      const isForcedToRun = shouldSkip && isUnskippable

      // skip test
      if (shouldSkip && !isUnskippable) {
        skippedTests.push(test)
        isTestsSkipped = true
        return { shouldSkip: true }
      }

      if (!activeSpan) {
        activeSpan = getTestSpan(testName, testSuite, isUnskippable, isForcedToRun)
      }

      return activeSpan ? { traceId: activeSpan.context().toTraceId() } : {}
    },
    'dd:afterEach': ({ test, coverage }) => {
      const { state, error, isRUMActive, testSourceLine, testSuite, testName } = test
      if (activeSpan) {
        if (coverage && isCodeCoverageEnabled && tracer._tracer._exporter && tracer._tracer._exporter.exportCoverage) {
          const coverageFiles = getCoveredFilenamesFromCoverage(coverage)
          const relativeCoverageFiles = coverageFiles.map(file => getTestSuitePath(file, rootDir))
          if (!relativeCoverageFiles.length) {
            incrementCountMetric(TELEMETRY_CODE_COVERAGE_EMPTY)
          }
          distributionMetric(TELEMETRY_CODE_COVERAGE_NUM_FILES, {}, relativeCoverageFiles.length)
          const { _traceId, _spanId } = testSuiteSpan.context()
          const formattedCoverage = {
            sessionId: _traceId,
            suiteId: _spanId,
            testId: activeSpan.context()._spanId,
            files: relativeCoverageFiles
          }
          tracer._tracer._exporter.exportCoverage(formattedCoverage)
        }
        const testStatus = CYPRESS_STATUS_TO_TEST_STATUS[state]
        activeSpan.setTag(TEST_STATUS, testStatus)

        if (error) {
          activeSpan.setTag('error', error)
        }
        if (isRUMActive) {
          activeSpan.setTag(TEST_IS_RUM_ACTIVE, 'true')
        }
        if (testSourceLine) {
          activeSpan.setTag(TEST_SOURCE_START, testSourceLine)
        }
        const finishedTest = {
          testName,
          testStatus,
          finishTime: activeSpan._getTime(), // we store the finish time here
          testSpan: activeSpan
        }
        if (finishedTestsByFile[testSuite]) {
          finishedTestsByFile[testSuite].push(finishedTest)
        } else {
          finishedTestsByFile[testSuite] = [finishedTest]
        }
        // test spans are finished at after:spec
      }
      activeSpan = null
      ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test')
      return null
    },
    'dd:addTags': (tags) => {
      if (activeSpan) {
        activeSpan.addTags(tags)
      }
      return null
    }
  })
}
