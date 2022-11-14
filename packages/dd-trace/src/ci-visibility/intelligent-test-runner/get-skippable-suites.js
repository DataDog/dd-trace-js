const request = require('../../exporters/common/request')

function getSkippableSuites ({
  url,
  site,
  env,
  service,
  repositoryUrl,
  sha,
  osVersion,
  osPlatform,
  osArchitecture,
  runtimeName,
  runtimeVersion
}, done) {
  const intakeUrl = url || new URL(`https://api.${site}`)

  const apiKey = process.env.DATADOG_API_KEY || process.env.DD_API_KEY
  const appKey = process.env.DATADOG_APP_KEY ||
    process.env.DD_APP_KEY ||
    process.env.DATADOG_APPLICATION_KEY ||
    process.env.DD_APPLICATION_KEY

  if (!apiKey || !appKey) {
    return done(new Error('API key or Application key are undefined.'))
  }

  const options = {
    path: '/api/v2/ci/tests/skippable',
    method: 'POST',
    headers: {
      'dd-api-key': apiKey,
      'dd-application-key': appKey,
      'Content-Type': 'application/json'
    },
    timeout: 15000,
    protocol: intakeUrl.protocol,
    hostname: intakeUrl.hostname,
    port: intakeUrl.port
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
          'runtime.version': runtimeVersion
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
      } catch (e) {
        done(e)
      }
    }
  })
}

module.exports = { getSkippableSuites }
