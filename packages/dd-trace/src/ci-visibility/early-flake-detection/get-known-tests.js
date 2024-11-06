const request = require('../../exporters/common/request')
const id = require('../../id')
const log = require('../../log')

const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_KNOWN_TESTS,
  TELEMETRY_KNOWN_TESTS_MS,
  TELEMETRY_KNOWN_TESTS_ERRORS,
  TELEMETRY_KNOWN_TESTS_RESPONSE_TESTS,
  TELEMETRY_KNOWN_TESTS_RESPONSE_BYTES
} = require('../../ci-visibility/telemetry')

const { getNumFromKnownTests } = require('../../plugins/util/test')

function getKnownTests ({
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
  custom
}, done) {
  const options = {
    path: '/api/v2/ci/libraries/tests',
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
    options.path = `${evpProxyPrefix}/api/v2/ci/libraries/tests`
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
  } else {
    const apiKey = process.env.DATADOG_API_KEY || process.env.DD_API_KEY
    if (!apiKey) {
      return done(new Error('Known tests were not fetched because Datadog API key is not defined.'))
    }

    options.headers['dd-api-key'] = apiKey
  }

  const data = JSON.stringify({
    data: {
      id: id().toString(10),
      type: 'ci_app_libraries_tests_request',
      attributes: {
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

  incrementCountMetric(TELEMETRY_KNOWN_TESTS)

  const startTime = Date.now()

  request(data, options, (err, res, statusCode) => {
    distributionMetric(TELEMETRY_KNOWN_TESTS_MS, {}, Date.now() - startTime)
    if (err) {
      incrementCountMetric(TELEMETRY_KNOWN_TESTS_ERRORS, { statusCode })
      done(err)
    } else {
      try {
        const { data: { attributes: { tests: knownTests } } } = JSON.parse(res)

        const numTests = getNumFromKnownTests(knownTests)

        incrementCountMetric(TELEMETRY_KNOWN_TESTS_RESPONSE_TESTS, {}, numTests)
        distributionMetric(TELEMETRY_KNOWN_TESTS_RESPONSE_BYTES, {}, res.length)

        log.debug(() => `Number of received known tests: ${numTests}`)

        done(null, knownTests)
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getKnownTests }
