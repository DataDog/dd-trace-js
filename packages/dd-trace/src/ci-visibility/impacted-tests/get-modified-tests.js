const request = require('../../exporters/common/request')
const id = require('../../id')

function getModifiedTests ({
  url,
  isEvpProxy,
  evpProxyPrefix,
  isGzipCompatible,
  repositoryUrl,
  branch,
  commitSha,
  env,
  service
}, done) {
  const options = {
    path: '/api/v2/ci/tests/diffs',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    timeout: 20000,
    url
  }

  if (isGzipCompatible) {
    options.headers['accept-encoding'] = 'gzip'
  }

  if (isEvpProxy) {
    options.path = `${evpProxyPrefix}/api/v2/ci/tests/diffs`
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
  } else {
    const apiKey = process.env.DATADOG_API_KEY || process.env.DD_API_KEY
    if (!apiKey) {
      return done(new Error('Modified tests were not fetched because Datadog API key is not defined.'))
    }

    options.headers['dd-api-key'] = apiKey
  }

  const data = JSON.stringify({
    data: {
      id: id().toString(10),
      type: 'ci_app_tests_diffs_request',
      attributes: {
        repository_url: repositoryUrl,
        branch,
        sha: commitSha,
        env,
        service
      }
    }
  })

  request(data, options, (err, res) => {
    if (err) {
      done(err)
    } else {
      try {
        const { data: { attributes: { base_sha: baseSha, files: modifiedTests } } } = JSON.parse(res)

        done(null, { baseSha, modifiedTests })
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getModifiedTests }
