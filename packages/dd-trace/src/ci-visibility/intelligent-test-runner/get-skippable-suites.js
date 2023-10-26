const request = require('../../exporters/common/request')
const log = require('../../log')

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

  if (isEvpProxy) {
    options.path = '/evp_proxy/v2/api/v2/ci/tests/skippable'
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

  request(data, options, (err, res) => {
    if (err) {
      done(err)
    } else {
      let skippableSuites = []
      try {
        skippableSuites = JSON.parse(res)
          .data
          .filter(({ type }) => type === testLevel)
          .map(({ attributes: { suite, name } }) => {
            if (testLevel === 'suite') {
              return suite
            }
            return { suite, name }
          })
        log.debug(() => `Number of received skippable ${testLevel}s: ${skippableSuites.length}`)
        done(null, skippableSuites)
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getSkippableSuites }
