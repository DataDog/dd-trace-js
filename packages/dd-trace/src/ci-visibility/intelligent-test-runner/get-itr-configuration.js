const request = require('../../exporters/common/request')
const id = require('../../id')
const log = require('../../log')

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
            attributes
          }
        } = JSON.parse(res)

        let isCodeCoverageEnabled = attributes.code_coverage
        let isSuitesSkippingEnabled = attributes.tests_skipping

        log.debug(() => `Remote settings: ${{ isCodeCoverageEnabled, isSuitesSkippingEnabled }}`)

        if (process.env.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE) {
          isCodeCoverageEnabled = true
          log.debug(() => 'Dangerously set code coverage to true')
        }
        if (process.env.DD_CIVISIBILITY_DANGEROUSLY_FORCE_TEST_SKIPPING) {
          isSuitesSkippingEnabled = true
          log.debug(() => 'Dangerously set test skipping to true')
        }

        done(null, { isCodeCoverageEnabled, isSuitesSkippingEnabled })
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getItrConfiguration }
