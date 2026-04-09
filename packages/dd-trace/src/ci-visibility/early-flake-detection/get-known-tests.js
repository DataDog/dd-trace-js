'use strict'

const request = require('../requests/request')
const id = require('../../id')
const log = require('../../log')
const { getValueFromEnvSources } = require('../../config/helper')

const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_KNOWN_TESTS,
  TELEMETRY_KNOWN_TESTS_MS,
  TELEMETRY_KNOWN_TESTS_ERRORS,
  TELEMETRY_KNOWN_TESTS_RESPONSE_TESTS,
  TELEMETRY_KNOWN_TESTS_RESPONSE_BYTES,
} = require('../../ci-visibility/telemetry')

const { getNumFromKnownTests } = require('../../plugins/util/test')
const { buildCacheKey, writeToCache, withCache } = require('../requests/fs-cache')

const MAX_KNOWN_TESTS_PAGES = 10_000

/**
 * Deep-merges page tests into aggregate.
 * Structure: { module: { suite: [testName, ...] } }
 *
 * @param {object | null} aggregate
 * @param {object | null} page
 * @returns {object | null}
 */
function mergeKnownTests (aggregate, page) {
  if (!page) return aggregate
  if (!aggregate) return page

  for (const [moduleName, suites] of Object.entries(page)) {
    if (!suites) continue

    if (!aggregate[moduleName]) {
      aggregate[moduleName] = suites
      continue
    }

    for (const [suiteName, tests] of Object.entries(suites)) {
      if (!tests || tests.length === 0) continue

      aggregate[moduleName][suiteName] = aggregate[moduleName][suiteName]
        ? [...aggregate[moduleName][suiteName], ...tests]
        : tests
    }
  }

  return aggregate
}

function getKnownTests ({
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
}, done) {
  const cacheKey = buildCacheKey('known-tests', [
    sha, service, env, repositoryUrl, osPlatform, osVersion, osArchitecture,
    runtimeName, runtimeVersion, custom,
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
      cacheKey: activeCacheKey,
    }, cb)
  }, done)
}

/**
 * Fetches known tests from the API with cursor-based pagination and writes the
 * result to cache on success.
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
  cacheKey,
}, done) {
  const options = {
    path: '/api/v2/ci/libraries/tests',
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
    options.path = `${evpProxyPrefix}/api/v2/ci/libraries/tests`
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
  } else {
    const apiKey = getValueFromEnvSources('DD_API_KEY')
    if (!apiKey) {
      return done(new Error('Known tests were not fetched because Datadog API key is not defined.'))
    }

    options.headers['dd-api-key'] = apiKey
  }

  const configurations = {
    'os.platform': osPlatform,
    'os.version': osVersion,
    'os.architecture': osArchitecture,
    'runtime.name': runtimeName,
    'runtime.version': runtimeVersion,
    custom,
  }

  incrementCountMetric(TELEMETRY_KNOWN_TESTS)

  const startTime = Date.now()
  let aggregateTests = null
  let totalResponseBytes = 0
  let pageNumber = 0

  function fetchPage (pageState) {
    pageNumber++

    if (pageNumber > MAX_KNOWN_TESTS_PAGES) {
      log.error('Known tests pagination exceeded maximum of %d pages. Aborting.', MAX_KNOWN_TESTS_PAGES)
      distributionMetric(TELEMETRY_KNOWN_TESTS_MS, {}, Date.now() - startTime)
      return done(new Error(`Known tests pagination exceeded maximum of ${MAX_KNOWN_TESTS_PAGES} pages`))
    }

    const pageInfo = pageState ? { page_state: pageState } : {}

    const data = JSON.stringify({
      data: {
        id: id().toString(10),
        type: 'ci_app_libraries_tests_request',
        attributes: {
          configurations,
          service,
          env,
          repository_url: repositoryUrl,
          sha,
          page_info: pageInfo,
        },
      },
    })

    request(data, options, (err, res, statusCode) => {
      if (err) {
        distributionMetric(TELEMETRY_KNOWN_TESTS_MS, {}, Date.now() - startTime)
        incrementCountMetric(TELEMETRY_KNOWN_TESTS_ERRORS, { statusCode })
        return done(err)
      }

      try {
        totalResponseBytes += res.length

        const { data: { attributes } } = JSON.parse(res)
        const { tests: pageTests, page_info: responsePageInfo } = attributes

        aggregateTests = mergeKnownTests(aggregateTests, pageTests)

        // Check if there are more pages
        if (responsePageInfo && responsePageInfo.has_next) {
          if (!responsePageInfo.cursor) {
            log.error(
              'Known tests response has has_next=true but no cursor on page %d. Aborting pagination.', pageNumber
            )
            distributionMetric(TELEMETRY_KNOWN_TESTS_MS, {}, Date.now() - startTime)
            return done(new Error('Known tests pagination: has_next=true but no cursor'))
          }
          return fetchPage(responsePageInfo.cursor)
        }

        // Done — no more pages
        distributionMetric(TELEMETRY_KNOWN_TESTS_MS, {}, Date.now() - startTime)

        const numTests = getNumFromKnownTests(aggregateTests)

        distributionMetric(TELEMETRY_KNOWN_TESTS_RESPONSE_TESTS, {}, numTests)
        distributionMetric(TELEMETRY_KNOWN_TESTS_RESPONSE_BYTES, {}, totalResponseBytes)

        log.debug('Number of received known tests: %d', numTests)

        writeToCache(cacheKey, aggregateTests)

        done(null, aggregateTests)
      } catch (err) {
        distributionMetric(TELEMETRY_KNOWN_TESTS_MS, {}, Date.now() - startTime)
        done(err)
      }
    })
  }

  fetchPage(null)
}

module.exports = { getKnownTests }
