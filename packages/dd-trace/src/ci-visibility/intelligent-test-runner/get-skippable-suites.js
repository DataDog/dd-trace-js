'use strict'

const request = require('../requests/request')
const log = require('../../log')
const { getValueFromEnvSources } = require('../../config/helper')
const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_ITR_SKIPPABLE_TESTS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_MS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_ERRORS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_SUITES,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_TESTS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_BYTES,
} = require('../../ci-visibility/telemetry')
const { buildCacheKey, writeToCache, withCache } = require('../requests/fs-cache')

function getSkippableSuites ({
  url,
  isEvpProxy,
  evpProxyPrefix,
  isGzipCompatible,
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
  testLevel = 'suite',
}, done) {
  const cacheKey = buildCacheKey('skippable', [
    sha, service, env, repositoryUrl, osPlatform, osVersion, osArchitecture,
    runtimeName, runtimeVersion, testLevel, custom,
  ])

  withCache(cacheKey, (activeCacheKey, cb) => {
    fetchFromApi({
      url,
      isEvpProxy,
      evpProxyPrefix,
      isGzipCompatible,
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
      testLevel,
      cacheKey: activeCacheKey,
    }, cb)
  }, (err, data) => {
    if (err) return done(err)
    done(null, data.skippableSuites, data.correlationId)
  })
}

/**
 * Fetches skippable suites from the API and writes the result to cache on success.
 *
 * @param {object} params
 * @param {string} params.url
 * @param {boolean} params.isEvpProxy
 * @param {string} params.evpProxyPrefix
 * @param {boolean} params.isGzipCompatible
 * @param {string} params.env
 * @param {string} params.service
 * @param {string} params.repositoryUrl
 * @param {string} params.sha
 * @param {string} params.osVersion
 * @param {string} params.osPlatform
 * @param {string} params.osArchitecture
 * @param {string} params.runtimeName
 * @param {string} params.runtimeVersion
 * @param {object} [params.custom]
 * @param {string} [params.testLevel]
 * @param {string | null} params.cacheKey
 * @param {Function} done
 */
function fetchFromApi ({
  url,
  isEvpProxy,
  evpProxyPrefix,
  isGzipCompatible,
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
  testLevel,
  cacheKey,
}, done) {
  const options = {
    path: '/api/v2/ci/tests/skippable',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: 20_000,
    url,
  }

  if (isGzipCompatible) {
    options.headers['accept-encoding'] = 'gzip'
  }

  if (isEvpProxy) {
    options.path = `${evpProxyPrefix}/api/v2/ci/tests/skippable`
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
  } else {
    const apiKey = getValueFromEnvSources('DD_API_KEY')
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
          custom,
        },
        service,
        env,
        repository_url: repositoryUrl,
        sha,
      },
    },
  })

  incrementCountMetric(TELEMETRY_ITR_SKIPPABLE_TESTS)

  const startTime = Date.now()

  request(data, options, (err, res, statusCode) => {
    distributionMetric(TELEMETRY_ITR_SKIPPABLE_TESTS_MS, {}, Date.now() - startTime)
    if (err) {
      incrementCountMetric(TELEMETRY_ITR_SKIPPABLE_TESTS_ERRORS, { statusCode })
      done(err)
    } else {
      try {
        const parsedResponse = JSON.parse(res)
        const skippableSuites = parsedResponse
          .data
          .filter(({ type }) => type === testLevel)
          .map(({ attributes: { suite, name } }) => {
            if (testLevel === 'suite') {
              return suite
            }
            return { suite, name }
          })
        const { meta: { correlation_id: correlationId } } = parsedResponse
        incrementCountMetric(
          testLevel === 'test'
            ? TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_TESTS
            : TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_SUITES,
          {},
          skippableSuites.length
        )
        distributionMetric(TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_BYTES, {}, res.length)
        log.debug('Number of received skippable %ss:', testLevel, skippableSuites.length)

        const result = { skippableSuites, correlationId }
        writeToCache(cacheKey, result)

        done(null, result)
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getSkippableSuites }
