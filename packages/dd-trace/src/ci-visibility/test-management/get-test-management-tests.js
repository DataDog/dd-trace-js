'use strict'

const request = require('../request')
const id = require('../../id')
const { getValueFromEnvSources } = require('../../config/helper')
const log = require('../../log')

const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_TEST_MANAGEMENT_TESTS,
  TELEMETRY_TEST_MANAGEMENT_TESTS_MS,
  TELEMETRY_TEST_MANAGEMENT_TESTS_ERRORS,
  TELEMETRY_TEST_MANAGEMENT_TESTS_RESPONSE_TESTS,
  TELEMETRY_TEST_MANAGEMENT_TESTS_RESPONSE_BYTES,
} = require('../telemetry')

// Calculate the number of tests from the test management tests response, which has a shape like:
// { module: { suites: { suite: { tests: { testName: { properties: {...} } } } } } }
function getNumFromTestManagementTests (testManagementTests) {
  if (!testManagementTests) {
    return 0
  }

  let totalNumTests = 0

  for (const testModule of Object.values(testManagementTests)) {
    const { suites } = testModule
    if (!suites) continue
    for (const testSuite of Object.values(suites)) {
      const { tests } = testSuite
      if (!tests) continue
      totalNumTests += Object.keys(tests).length
    }
  }

  return totalNumTests
}

function getTestManagementTests ({
  url,
  isEvpProxy,
  evpProxyPrefix,
  isGzipCompatible,
  repositoryUrl,
  commitMessage,
  sha,
  commitHeadSha,
  commitHeadMessage,
  branch,
}, done) {
  const options = {
    path: '/api/v2/test/libraries/test-management/tests',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: 20_000,
    url,
    requestType: 'test-management-tests',
  }

  if (isGzipCompatible) {
    options.headers['accept-encoding'] = 'gzip'
  }

  if (isEvpProxy) {
    options.path = `${evpProxyPrefix}/api/v2/test/libraries/test-management/tests`
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
  } else {
    const apiKey = getValueFromEnvSources('DD_API_KEY')
    if (!apiKey) {
      const error = new Error('Test management tests were not fetched because Datadog API key is not defined.')
      log.error(error.message)
      return done(error)
    }

    options.headers['dd-api-key'] = apiKey
  }

  const requestPayload = {
    data: {
      id: id().toString(10),
      type: 'ci_app_libraries_tests_request',
      attributes: {
        repository_url: repositoryUrl,
        commit_message: commitHeadMessage || commitMessage,
        sha: commitHeadSha || sha,
        branch,
      },
    },
  }

  const data = JSON.stringify(requestPayload)

  incrementCountMetric(TELEMETRY_TEST_MANAGEMENT_TESTS)

  const startTime = Date.now()

  request(data, options, (err, res, statusCode) => {
    const duration = Date.now() - startTime
    distributionMetric(TELEMETRY_TEST_MANAGEMENT_TESTS_MS, {}, duration)

    if (err) {
      log.error('Test management tests request failed: %s (status code: %s)', err.message, statusCode)
      incrementCountMetric(TELEMETRY_TEST_MANAGEMENT_TESTS_ERRORS, { statusCode })
      return done(err)
    }

    if (res) {
      try {
        const parsedResponse = JSON.parse(res)
        const { data: { attributes: { modules: testManagementTests } } } = parsedResponse

        const numTests = getNumFromTestManagementTests(testManagementTests)

        distributionMetric(TELEMETRY_TEST_MANAGEMENT_TESTS_RESPONSE_TESTS, {}, numTests)
        distributionMetric(TELEMETRY_TEST_MANAGEMENT_TESTS_RESPONSE_BYTES, {}, res.length)

        // Temporary debug: log only quarantined tests as list of test names.
        const quarantinedTests = []
        for (const testModule of Object.values(testManagementTests || {})) {
          const { suites } = testModule || {}
          if (!suites) continue
          for (const testSuite of Object.values(suites)) {
            const { tests } = testSuite || {}
            if (!tests) continue
            for (const [testName, testConfig] of Object.entries(tests)) {
              if (testConfig?.properties?.quarantined) {
                quarantinedTests.push(testName)
              }
            }
          }
        }
        if (quarantinedTests.length) {
          log.warn('Test management quarantined tests: %j', quarantinedTests)
        }

        return done(null, testManagementTests)
      } catch (parseErr) {
        log.error('Failed to parse test management tests response: %s', parseErr.message)
        incrementCountMetric(TELEMETRY_TEST_MANAGEMENT_TESTS_ERRORS, { statusCode })
        return done(parseErr)
      }
    }

    const error = new Error('Test management tests request returned empty response')
    log.error(error.message)
    incrementCountMetric(TELEMETRY_TEST_MANAGEMENT_TESTS_ERRORS, { statusCode })
    done(error)
  })
}

module.exports = { getTestManagementTests }
