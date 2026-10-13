'use strict'

const getConfig = require('../../config')
const { EVP_SUBDOMAIN_HEADER_NAME } = require('../../evp_proxy/constants')
const { joinEVPProxyPath } = require('../../evp_proxy/path')
const id = require('../../id')
const { distributionMetric, incrementCountMetric } = require('../telemetry')
const { buildCacheKey, withCache, writeToCache } = require('./fs-cache')
const request = require('./request')

/**
 * @param {object} configuration
 * @param {(error: Error | null, tests?: Record<string, Record<string, string[]>>) => void} done
 */
function getFlakyTests (configuration, done) {
  const {
    url, isEvpProxy, evpProxyPrefix, isGzipCompatible, service, env, repositoryUrl, sha, branch, tag,
    osPlatform, osVersion, osArchitecture, runtimeName, runtimeVersion, custom,
  } = configuration
  const effectiveBranch = branch || tag
  const cacheKey = buildCacheKey('flaky-tests', [
    sha, effectiveBranch, service, env, repositoryUrl, osPlatform, osVersion, osArchitecture,
    runtimeName, runtimeVersion, custom,
  ])

  withCache(cacheKey, (activeCacheKey, callback) => {
    const options = {
      url,
      path: '/api/v2/ci/libraries/tests/flaky',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 20_000,
    }
    if (isGzipCompatible) options.headers['accept-encoding'] = 'gzip'
    if (isEvpProxy) {
      options.path = joinEVPProxyPath(evpProxyPrefix, options.path)
      options.headers[EVP_SUBDOMAIN_HEADER_NAME] = 'api'
    } else {
      const { DD_API_KEY } = getConfig()
      if (!DD_API_KEY) return callback(new Error('Flaky tests require a Datadog API key.'))
      options.headers['dd-api-key'] = DD_API_KEY
    }

    const data = JSON.stringify({
      data: {
        id: id().toString(10),
        type: 'flaky_test_from_libraries_params',
        attributes: {
          service,
          env,
          repository_url: repositoryUrl,
          sha,
          branch: effectiveBranch,
          test_level: 'test',
          configurations: {
            'os.platform': osPlatform,
            'os.version': osVersion,
            'os.architecture': osArchitecture,
            'runtime.name': runtimeName,
            'runtime.version': runtimeVersion,
            custom,
          },
        },
      },
    })
    incrementCountMetric('flaky_tests.request')
    const startTime = Date.now()
    request(data, options, (err, response, statusCode) => {
      distributionMetric('flaky_tests.request_ms', {}, Date.now() - startTime)
      if (err) {
        incrementCountMetric('flaky_tests.request_errors', { statusCode })
        return callback(err)
      }
      let tests
      try {
        const { data } = JSON.parse(response)
        if (!Array.isArray(data)) throw new Error('Invalid flaky tests response')
        tests = Object.create(null)
        for (const test of data) {
          const { suite, name, configurations } = test?.attributes || {}
          const testModule = configurations?.['test.bundle']
          if (typeof testModule !== 'string' || typeof suite !== 'string' || typeof name !== 'string') {
            throw new TypeError('Invalid flaky test identity')
          }
          const suites = tests[testModule] ??= Object.create(null)
          const names = suites[suite] ??= []
          names.push(name)
        }
        distributionMetric('flaky_tests.response_tests', {}, data.length)
        distributionMetric('flaky_tests.response_bytes', {}, Buffer.byteLength(response))
      } catch (error) {
        incrementCountMetric('flaky_tests.request_errors', { errorType: 'invalid_response' })
        return callback(error)
      }
      writeToCache(activeCacheKey, tests)
      callback(null, tests)
    })
  }, (err, tests) => {
    if (err) return done(err)
    // Cache hits bypass HTTP parsing, so validate the map once before sharing it with runners.
    if (!isRecord(tests) || Object.values(tests).some(suites =>
      !isRecord(suites) || Object.values(suites).some(names =>
        !Array.isArray(names) || names.some(name => typeof name !== 'string')))) {
      return done(new Error('Invalid cached flaky tests'))
    }
    done(null, tests)
  })
}

/** @param {unknown} value */
function isRecord (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

module.exports = getFlakyTests
