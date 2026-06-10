'use strict'

const getConfig = require('../../config')
const request = require('../requests/request')
const log = require('../../log')
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

function parseJsonResponse (rawJson) {
  return typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson
}

function parseSkippableSuitesResponse (
  rawJson,
  { testLevel = 'suite', isCoverageReportUploadEnabled = false } = {}
) {
  const parsedResponse = parseJsonResponse(rawJson)
  const coverage = parsedResponse.meta?.coverage || {}

  const skippableItems = parsedResponse
    .data
    .filter(({ type }) => type === testLevel)
  const skippableSuites = []
  for (const {
    attributes: {
      suite,
      name,
      _is_missing_line_code_coverage: isMissingLineCodeCoverage,
    },
  } of skippableItems) {
    // Only reject candidates without backend line coverage when we need that coverage to backfill reports.
    if (isCoverageReportUploadEnabled && isMissingLineCodeCoverage) continue

    skippableSuites.push(testLevel === 'suite' ? suite : { suite, name })
  }
  const correlationId = parsedResponse.meta?.correlation_id

  return { skippableSuites, correlationId, coverage }
}

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
  isCoverageReportUploadEnabled = false,
}, done) {
  const cacheKey = buildCacheKey('skippable', [
    sha, service, env, repositoryUrl, osPlatform, osVersion, osArchitecture,
    runtimeName, runtimeVersion, testLevel, custom, isCoverageReportUploadEnabled,
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
      isCoverageReportUploadEnabled,
      cacheKey: activeCacheKey,
    }, cb)
  }, (err, data) => {
    if (err) return done(err)
    done(null, data.skippableSuites, data.correlationId, data.coverage)
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
 * @param {boolean} [params.isCoverageReportUploadEnabled]
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
  isCoverageReportUploadEnabled,
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
    const { apiKey } = getConfig()
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
        const parsedResponse = parseJsonResponse(res)
        const result = parseSkippableSuitesResponse(parsedResponse, {
          testLevel,
          isCoverageReportUploadEnabled,
        })
        const skippableItems = parsedResponse.data.filter(({ type }) => type === testLevel)
        incrementCountMetric(
          testLevel === 'test'
            ? TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_TESTS
            : TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_SUITES,
          {},
          skippableItems.length
        )
        distributionMetric(TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_BYTES, {}, res.length)
        log.debug('Number of received skippable %ss:', testLevel, result.skippableSuites.length)

        writeToCache(cacheKey, result)

        done(null, result)
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getSkippableSuites, parseSkippableSuitesResponse }
