const request = require('../../exporters/common/request')

function getSkippableSuites ({
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
  custom
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

  if (isEvpProxy) {
    options.path = '/evp_proxy/v2/api/v2/ci/tests/skippable'
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
      type: 'test_params',
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
        sha
      }
    }
  })

  request(data, options, (err, res) => {
    if (err) {
      done(err)
    } else {
      let skippableSuites = []
      try {
        skippableSuites = JSON.parse(res)
          .data
          .filter(({ type }) => type === 'suite')
          .map(({ attributes: { suite } }) => suite)
        done(null, skippableSuites)
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getSkippableSuites }
