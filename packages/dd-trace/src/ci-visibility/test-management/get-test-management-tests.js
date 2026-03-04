'use strict'

const request = require('../requests/request')
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
      return done(new Error('Test management tests were not fetched because Datadog API key is not defined.'))
    }

    options.headers['dd-api-key'] = apiKey
  }

  const data = JSON.stringify({
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
  })

  log.debug('Requesting test management tests: %s', data)

  incrementCountMetric(TELEMETRY_TEST_MANAGEMENT_TESTS)

  const startTime = Date.now()

  request(data, options, (err, res, statusCode) => {
    distributionMetric(TELEMETRY_TEST_MANAGEMENT_TESTS_MS, {}, Date.now() - startTime)
    if (err) {
      incrementCountMetric(TELEMETRY_TEST_MANAGEMENT_TESTS_ERRORS, { statusCode })
      done(err)
    } else {
      try {
        const { data: { attributes: { modules: testManagementTests } } } = JSON.parse(res)

        const numTests = getNumFromTestManagementTests(testManagementTests)

        distributionMetric(TELEMETRY_TEST_MANAGEMENT_TESTS_RESPONSE_TESTS, {}, numTests)
        distributionMetric(TELEMETRY_TEST_MANAGEMENT_TESTS_RESPONSE_BYTES, {}, res.length)

        log.debug('Test management tests received: %j', testManagementTests)

        done(null, testManagementTests)
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getTestManagementTests }
