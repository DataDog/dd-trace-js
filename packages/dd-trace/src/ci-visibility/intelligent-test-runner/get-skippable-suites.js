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

function mergeCoverageBitmap (targetBitmap, bitmap) {
  if (!targetBitmap) return bitmap

  const targetBuffer = Buffer.from(targetBitmap, 'base64')
  const bitmapBuffer = Buffer.from(bitmap, 'base64')
  const mergedBuffer = Buffer.alloc(Math.max(targetBuffer.length, bitmapBuffer.length))

  targetBuffer.copy(mergedBuffer)
  for (let i = 0; i < bitmapBuffer.length; i++) {
    mergedBuffer[i] |= bitmapBuffer[i]
  }

  return mergedBuffer.toString('base64')
}

function mergeCoverage (targetCoverage, coverage) {
  if (!coverage || typeof coverage !== 'object') return

  for (const [filename, bitmap] of Object.entries(coverage)) {
    if (typeof bitmap !== 'string') continue
    targetCoverage[filename] = mergeCoverageBitmap(targetCoverage[filename], bitmap)
  }
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
  isCodeCoverageEnabled = false,
}, done) {
  const cacheKey = buildCacheKey('skippable', [
    sha, service, env, repositoryUrl, osPlatform, osVersion, osArchitecture,
    runtimeName, runtimeVersion, testLevel, custom, isCodeCoverageEnabled,
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
      isCodeCoverageEnabled,
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
 * @param {boolean} [params.isCodeCoverageEnabled]
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
  isCodeCoverageEnabled,
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
        const parsedResponse = JSON.parse(res)
        const coverage = {}
        mergeCoverage(coverage, parsedResponse.meta?.coverage)

        const skippableItems = parsedResponse
          .data
          .filter(({ type }) => type === testLevel)
        const skippableSuites = []
        const hasCoverage = Object.keys(coverage).length > 0
        for (const {
          attributes: {
            suite,
            name,
            coverage: suiteCoverage,
            _is_missing_line_code_coverage: isMissingLineCodeCoverage,
          },
        } of skippableItems) {
          const hasSuiteCoverage = !!suiteCoverage && Object.keys(suiteCoverage).length > 0
          mergeCoverage(coverage, suiteCoverage)

          if (isCodeCoverageEnabled && !hasCoverage && !hasSuiteCoverage) continue
          if (isCodeCoverageEnabled && isMissingLineCodeCoverage) continue

          skippableSuites.push(testLevel === 'suite' ? suite : { suite, name })
        }
        const correlationId = parsedResponse.meta?.correlation_id
        incrementCountMetric(
          testLevel === 'test'
            ? TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_TESTS
            : TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_SUITES,
          {},
          skippableItems.length
        )
        distributionMetric(TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_BYTES, {}, res.length)
        log.debug('Number of received skippable %ss:', testLevel, skippableSuites.length)

        const result = { skippableSuites, correlationId, coverage }
        writeToCache(cacheKey, result)

        done(null, result)
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getSkippableSuites }
