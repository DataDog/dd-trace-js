'use strict'

const request = require('../../exporters/common/request')
const id = require('../../id')
const { getEnvironmentVariable } = require('../../config-helper')
const log = require('../../log')

function getTestManagementTests ({
  url,
  isEvpProxy,
  evpProxyPrefix,
  isGzipCompatible,
  repositoryUrl,
  commitMessage,
  sha,
  commitHeadSha,
  commitHeadMessage
}, done) {
  const options = {
    path: '/api/v2/test/libraries/test-management/tests',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    timeout: 20_000,
    url
  }

  if (isGzipCompatible) {
    options.headers['accept-encoding'] = 'gzip'
  }

  if (isEvpProxy) {
    options.path = `${evpProxyPrefix}/api/v2/test/libraries/test-management/tests`
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
  } else {
    const apiKey = getEnvironmentVariable('DD_API_KEY')
    if (!apiKey) {
      return done(new Error('Test management tests were not fetched because Datadog API key is not defined.'))
    }

    options.headers['dd-api-key'] = apiKey
  }

  const data = JSON.stringify({
    data: {
      id: id().toString(10),
      type: 'ci_app_libraries_tests_request',
      attributes: {
        repository_url: repositoryUrl,
        commit_message: commitHeadMessage || commitMessage,
        sha: commitHeadSha || sha
      }
    }
  })

  log.debug('Requesting test management tests: %s', data)

  request(data, options, (err, res) => {
    if (err) {
      done(err)
    } else {
      try {
        const { data: { attributes: { modules: testManagementTests } } } = JSON.parse(res)

        log.debug('Test management tests received: %j', testManagementTests)

        done(null, testManagementTests)
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getTestManagementTests }
