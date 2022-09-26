const request = require('../../exporters/common/request')
const id = require('../../id')

function getItrConfiguration ({
  site,
  env,
  service,
  repositoryUrl,
  sha,
  osVersion,
  osPlatform,
  osArchitecture,
  runtimeName,
  runtimeVersion,
  branch
}, done) {
  const url = new URL(`https://api.${site}`)

  const apiKey = process.env.DATADOG_API_KEY || process.env.DD_API_KEY
  const appKey = process.env.DATADOG_APP_KEY ||
    process.env.DD_APP_KEY ||
    process.env.DATADOG_APPLICATION_KEY ||
    process.env.DD_APPLICATION_KEY

  if (!apiKey || !appKey) {
    done(new Error('App key or API key undefined'))
    return
  }

  const options = {
    path: '/api/v2/libraries/tests/services/setting',
    method: 'POST',
    headers: {
      'dd-api-key': apiKey,
      'dd-application-key': appKey,
      'Content-Type': 'application/json'
    },
    timeout: 15000,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port
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
          'runtime.version': runtimeVersion
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
      } catch (e) {
        done(e)
      }
    }
  })
}

module.exports = { getItrConfiguration }
