const request = require('../../exporters/common/request')
const id = require('../../id')
const log = require('../../log')
const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_GIT_REQUESTS_SETTINGS,
  TELEMETRY_GIT_REQUESTS_SETTINGS_MS,
  TELEMETRY_GIT_REQUESTS_SETTINGS_ERRORS,
  TELEMETRY_GIT_REQUESTS_SETTINGS_RESPONSE,
  getErrorTypeFromStatusCode
} = require('../../ci-visibility/telemetry')

function getItrConfiguration ({
  url,
  isEvpProxy,
  env,
  service,
  repositoryUrl,
  sha,
  osVersion,
  osPlatform,
  osArchitecture,
  runtimeName,
  runtimeVersion,
  branch,
  testLevel = 'suite',
  custom
}, done) {
  const options = {
    path: '/api/v2/libraries/tests/services/setting',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    url,
    timeout: 20000
  }

  if (isEvpProxy) {
    options.path = '/evp_proxy/v2/api/v2/libraries/tests/services/setting'
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
  } else {
    const apiKey = process.env.DATADOG_API_KEY || process.env.DD_API_KEY
    if (!apiKey) {
      return done(new Error('Request to settings endpoint was not done because Datadog API key is not defined.'))
    }
    options.headers['dd-api-key'] = apiKey
  }

  const data = JSON.stringify({
    data: {
      id: id().toString(10),
      type: 'ci_app_test_service_libraries_settings',
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
        sha,
        branch
      }
    }
  })

  incrementCountMetric(TELEMETRY_GIT_REQUESTS_SETTINGS)

  const startTime = Date.now()
  request(data, options, (err, res, statusCode) => {
    distributionMetric(TELEMETRY_GIT_REQUESTS_SETTINGS_MS, {}, Date.now() - startTime)
    if (err) {
      const errorType = getErrorTypeFromStatusCode(statusCode)
      incrementCountMetric(TELEMETRY_GIT_REQUESTS_SETTINGS_ERRORS, { errorType })
      done(err)
    } else {
      try {
        const {
          data: {
            attributes: {
              code_coverage: isCodeCoverageEnabled,
              tests_skipping: isSuitesSkippingEnabled,
              itr_enabled: isItrEnabled,
              require_git: requireGit
            }
          }
        } = JSON.parse(res)

        const settings = { isCodeCoverageEnabled, isSuitesSkippingEnabled, isItrEnabled, requireGit }

        log.debug(() => `Remote settings: ${JSON.stringify(settings)}`)

        if (process.env.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE) {
          settings.isCodeCoverageEnabled = true
          log.debug(() => 'Dangerously set code coverage to true')
        }
        if (process.env.DD_CIVISIBILITY_DANGEROUSLY_FORCE_TEST_SKIPPING) {
          settings.isSuitesSkippingEnabled = true
          log.debug(() => 'Dangerously set test skipping to true')
        }

        incrementCountMetric(TELEMETRY_GIT_REQUESTS_SETTINGS_RESPONSE, settings)

        done(null, settings)
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getItrConfiguration }
