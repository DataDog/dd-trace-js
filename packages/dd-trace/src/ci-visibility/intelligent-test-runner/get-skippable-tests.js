const request = require('../../exporters/common/request')

function getSkippableTests ({
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
  // TODO: get from config (at least site)
  const url = new URL('https://api.datad0g.com')

  const options = {
    path: `/api/v2/ci/environment/${env}/service/${service}/tests/skippable`,
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
        configurations: {
          'os.platform': osPlatform,
          'os.version': osVersion,
          'os.architecture': osArchitecture,
          'runtime.name': runtimeName,
          'runtime.version': runtimeVersion
        },
        repository_url: repositoryUrl,
        sha
      }
    }
  })

  request(data, options, false, (err, res) => {
    if (err) {
      done(err)
    } else {
      let skippableTests = []
      try {
        skippableTests = JSON.parse(res).data
        done(null, skippableTests)
      } catch (e) {
        // ignore errors
        done(e)
      }
    }
  })
}

module.exports = { getSkippableTests }
