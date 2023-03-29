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
  finishAllTraceSpans
} = require('../../dd-trace/src/plugins/util/test')

const TEST_FRAMEWORK_NAME = 'cypress'

const { ORIGIN_KEY, COMPONENT } = require('../../dd-trace/src/constants')

const CYPRESS_STATUS_TO_TEST_STATUS = {
  passed: 'pass',
  failed: 'fail',
  pending: 'skip',
  skipped: 'skip'
}

function getTestSpanMetadata (tracer, testName, testSuite, cypressConfig) {
  const childOf = getTestParentSpan(tracer)

  const commonTags = getTestCommonTags(testName, testSuite, cypressConfig.version)

  return {
    childOf,
    ...commonTags
  }
}

function getCypressVersion (details) {
  if (details && details.cypressVersion) {
    return details.cypressVersion
  }
  if (details && details.config && details.config.version) {
    return details.config.version
  }
  return ''
}

function getCypressCommand (details) {
  if (!details) {
    return TEST_FRAMEWORK_NAME
  }
  return `${TEST_FRAMEWORK_NAME} ${details.specPattern || ''}`
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

function getSuiteStatus (suiteStats) {
  if (suiteStats.failures !== undefined && suiteStats.failures > 0) {
    return 'fail'
  }
  if (suiteStats.tests !== undefined && suiteStats.tests === suiteStats.pending) {
    return 'skip'
  }
  return 'pass'
}

module.exports = (on, config) => {
  const tracer = require('../../dd-trace')
  const testEnvironmentMetadata = getTestEnvironmentMetadata(TEST_FRAMEWORK_NAME)

  const codeOwnersEntries = getCodeOwnersFileEntries()

  let activeSpan = null
  let testSessionSpan = null
  let testModuleSpan = null
  let testSuiteSpan = null
  let command = null
  let frameworkVersion

  on('before:run', (details) => {
    const childOf = getTestParentSpan(tracer)

    command = getCypressCommand(details)
    frameworkVersion = getCypressVersion(details)

    const testSessionSpanMetadata = getTestSessionCommonTags(command, frameworkVersion, TEST_FRAMEWORK_NAME)
    const testModuleSpanMetadata = getTestModuleCommonTags(command, frameworkVersion, TEST_FRAMEWORK_NAME)

    testSessionSpan = tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_session`, {
      childOf,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        ...testEnvironmentMetadata,
        ...testSessionSpanMetadata
      }
    })
    testModuleSpan = tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_module`, {
      childOf: testSessionSpan,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        ...testEnvironmentMetadata,
        ...testModuleSpanMetadata
      }
    })
  })

  on('after:run', (suiteStats) => {
    if (testSessionSpan && testModuleSpan) {
      const testStatus = getSessionStatus(suiteStats)
      testModuleSpan.setTag(TEST_STATUS, testStatus)
      testSessionSpan.setTag(TEST_STATUS, testStatus)

      testModuleSpan.finish()
      testSessionSpan.finish()

      finishAllTraceSpans(testSessionSpan)
    }

    return new Promise(resolve => {
      tracer._tracer._exporter._writer.flush(() => {
        resolve(null)
      })
    })
  })
  on('task', {
    'dd:testSuiteStart': (suite) => {
      if (testSuiteSpan) {
        return null
      }
      const testSuiteSpanMetadata = getTestSuiteCommonTags(command, frameworkVersion, suite, TEST_FRAMEWORK_NAME)
      testSuiteSpan = tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_suite`, {
        childOf: testModuleSpan,
        tags: {
          [COMPONENT]: TEST_FRAMEWORK_NAME,
          ...testEnvironmentMetadata,
          ...testSuiteSpanMetadata
        }
      })
      return null
    },
    'dd:testSuiteFinish': (suiteStats) => {
      if (testSuiteSpan) {
        const status = getSuiteStatus(suiteStats)
        testSuiteSpan.setTag(TEST_STATUS, status)
        testSuiteSpan.finish()
        testSuiteSpan = null
      }
      return null
    },
    'dd:beforeEach': (test) => {
      const { testName, testSuite } = test

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

      if (!activeSpan) {
        activeSpan = tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test`, {
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
      return activeSpan ? activeSpan.context().toTraceId() : null
    },
    'dd:afterEach': (test) => {
      const { state, error, isRUMActive } = test
      if (activeSpan) {
        activeSpan.setTag(TEST_STATUS, CYPRESS_STATUS_TO_TEST_STATUS[state])
        if (error) {
          activeSpan.setTag('error', error)
        }
        if (isRUMActive) {
          activeSpan.setTag(TEST_IS_RUM_ACTIVE, 'true')
        }
        activeSpan.finish()
      }
      activeSpan = null
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
