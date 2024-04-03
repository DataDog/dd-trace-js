const request = require('../../exporters/common/request')
const log = require('../../log')
const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_ITR_SKIPPABLE_TESTS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_MS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_ERRORS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_SUITES,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_TESTS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_BYTES,
  getErrorTypeFromStatusCode
} = require('../../ci-visibility/telemetry')

function getSkippableSuites ({
  url,
  isEvpProxy,
  evpProxyPrefix,
  isGzipCompatible,
  env,
  service,
  repositoryUrl,
  sha,
  osVersion,
  osPlatform,
  osArchitecture,
  runtimeName,
  runtimeVersion,
  custom,
  testLevel = 'suite'
}, done) {
  const options = {
    path: '/api/v2/ci/tests/skippable',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    timeout: 20000,
    url
  }

  if (isGzipCompatible) {
    options.headers['accept-encoding'] = 'gzip'
  }

  if (isEvpProxy) {
    options.path = `${evpProxyPrefix}/api/v2/ci/tests/skippable`
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
  } else {
    const apiKey = process.env.DATADOG_API_KEY || process.env.DD_API_KEY
    if (!apiKey) {
      return done(new Error('Skippable suites were not fetched because Datadog API key is not defined.'))
    }

    options.headers['dd-api-key'] = apiKey
  }

  const data = JSON.stringify({
    data: {
      type: 'test_params',
      attributes: {
        test_level: testLevel,
        configurations: {
          'os.platform': osPlatform,
          'os.version': osVersion,
          'os.architecture': osArchitecture,
          'runtime.name': runtimeName,
          'runtime.version': runtimeVersion,
          custom
        },
        service,
        env,
        repository_url: repositoryUrl,
        sha
      }
    }
  })

  incrementCountMetric(TELEMETRY_ITR_SKIPPABLE_TESTS)

  const startTime = Date.now()

  request(data, options, (err, res, statusCode) => {
    distributionMetric(TELEMETRY_ITR_SKIPPABLE_TESTS_MS, {}, Date.now() - startTime)
    if (err) {
      const errorType = getErrorTypeFromStatusCode(statusCode)
      incrementCountMetric(TELEMETRY_ITR_SKIPPABLE_TESTS_ERRORS, { errorType })
      done(err)
    } else {
      let skippableSuites = []
      try {
        const parsedResponse = JSON.parse(res)
        skippableSuites = parsedResponse
          .data
          .filter(({ type }) => type === testLevel)
          .map(({ attributes: { suite, name } }) => {
            if (testLevel === 'suite') {
              return suite
            }
            return { suite, name }
          })
        const { meta: { correlation_id: correlationId } } = parsedResponse
        incrementCountMetric(
          testLevel === 'test'
            ? TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_TESTS
            : TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_SUITES,
          {},
          skippableSuites.length
        )
        distributionMetric(TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_BYTES, {}, res.length)
        log.debug(() => `Number of received skippable ${testLevel}s: ${skippableSuites.length}`)
        done(null, skippableSuites, correlationId)
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getSkippableSuites }
