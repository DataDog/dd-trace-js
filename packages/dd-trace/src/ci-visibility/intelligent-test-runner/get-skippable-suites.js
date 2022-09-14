const request = require('../../exporters/common/request')

function getSkippableSuites ({
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
  const url = new URL(`https://api.${site}`)

  const options = {
    path: '/api/v2/ci/tests/skippable',
    method: 'POST',
    headers: {
      'dd-api-key': process.env.DATADOG_API_KEY || process.env.DD_API_KEY,
      'dd-application-key': process.env.DATADOG_APP_KEY ||
        process.env.DD_APP_KEY ||
        process.env.DATADOG_APPLICATION_KEY ||
        process.env.DD_APPLICATION_KEY,
      'Content-Type': 'application/json'
    },
    timeout: 15000,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port
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
