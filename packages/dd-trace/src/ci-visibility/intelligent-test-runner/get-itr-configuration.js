const request = require('../../exporters/common/request')
const id = require('../../id')

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
  custom
}, done) {
  const options = {
    path: '/api/v2/libraries/tests/services/setting',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    url
  }

  if (isEvpProxy) {
    options.path = '/evp_proxy/v2/api/v2/libraries/tests/services/setting'
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
    options.headers['X-Datadog-NeedsAppKey'] = 'true'
  } else {
    const apiKey = process.env.DATADOG_API_KEY || process.env.DD_API_KEY
    const appKey = process.env.DATADOG_APP_KEY ||
      process.env.DD_APP_KEY ||
      process.env.DATADOG_APPLICATION_KEY ||
      process.env.DD_APPLICATION_KEY

    if (!apiKey || !appKey) {
      return done(new Error('App key or API key undefined'))
    }
    options.headers['dd-api-key'] = apiKey
    options.headers['dd-application-key'] = appKey
  }

  const data = JSON.stringify({
    data: {
      id: id().toString(10),
      type: 'ci_app_test_service_libraries_settings',
      attributes: {
        test_level: 'suite',
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

  request(data, options, (err, res) => {
    if (err) {
      done(err)
    } else {
      try {
        const {
          data: {
            attributes: {
              code_coverage: isCodeCoverageEnabled,
              tests_skipping: isSuitesSkippingEnabled
            }
          }
        } = JSON.parse(res)

        done(null, { isCodeCoverageEnabled, isSuitesSkippingEnabled })
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getItrConfiguration }
