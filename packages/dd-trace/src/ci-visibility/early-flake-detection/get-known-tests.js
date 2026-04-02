'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { tmpdir } = require('node:os')

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

const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes
const CACHE_LOCK_POLL_MS = 500
const CACHE_LOCK_TIMEOUT_MS = 120_000 // 2 minutes
const CACHE_LOCK_HEARTBEAT_MS = 30_000 // 30 seconds

const MAX_KNOWN_TESTS_PAGES = 10_000

/**
 * Builds a deterministic cache key from the request parameters that identify
 * a unique known-tests response.
 *
 * @param {object} params
 * @param {string} params.sha
 * @param {string} params.service
 * @param {string} params.env
 * @param {string} params.repositoryUrl
 * @param {string} params.osPlatform
 * @param {string} params.osVersion
 * @param {string} params.osArchitecture
 * @param {string} params.runtimeName
 * @param {string} params.runtimeVersion
 * @param {object} [params.custom]
 * @returns {string} hex digest
 */
function buildCacheKey ({
  sha,
  service,
  env,
  repositoryUrl,
  osPlatform,
  osVersion,
  osArchitecture,
  runtimeName,
  runtimeVersion,
  custom,
}) {
  const parts = [
    sha, service, env, repositoryUrl, osPlatform, osVersion, osArchitecture,
    runtimeName, runtimeVersion, JSON.stringify(custom ?? {}),
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}

/**
 * @param {string} cacheKey
 * @returns {string}
 */
function getCachePath (cacheKey) {
  return path.join(tmpdir(), `dd-known-tests-${cacheKey}.json`)
}

/**
 * @param {string} cacheKey
 * @returns {string}
 */
function getLockPath (cacheKey) {
  return path.join(tmpdir(), `dd-known-tests-${cacheKey}.lock`)
}

/**
 * Attempts to read known tests from the filesystem cache.
 * Returns the cached data if it exists and has not expired, otherwise undefined.
 *
 * @param {string} cacheKey
 * @returns {{ knownTests: object, numTests: number } | undefined}
 */
function readFromCache (cacheKey) {
  const cachePath = getCachePath(cacheKey)
  try {
    const raw = fs.readFileSync(cachePath, 'utf8')
    const { timestamp, knownTests } = JSON.parse(raw)
    if (Date.now() - timestamp > CACHE_TTL_MS) {
      log.debug('Known tests cache expired (age: %d ms)', Date.now() - timestamp)
      return
    }
    const numTests = getNumFromKnownTests(knownTests)
    log.debug('Known tests cache hit (%d tests)', numTests)
    return { knownTests, numTests }
  } catch {
    // Cache file missing, corrupt, or unreadable — treat as cache miss
  }
}

/**
 * Writes known tests to the filesystem cache atomically.
 *
 * @param {string} cacheKey
 * @param {object} knownTests
 */
function writeToCache (cacheKey, knownTests) {
  const cachePath = getCachePath(cacheKey)
  const tmpPath = cachePath + '.tmp.' + process.pid
  try {
    fs.writeFileSync(tmpPath, JSON.stringify({ timestamp: Date.now(), knownTests }), 'utf8')
    fs.renameSync(tmpPath, cachePath)
    log.debug('Known tests written to cache: %s', cachePath)
  } catch (err) {
    log.error('Failed to write known tests cache: %s', err.message)
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}

/**
 * Attempts to acquire an exclusive lock using O_CREAT|O_EXCL.
 *
 * @param {string} cacheKey
 * @returns {boolean} true if this process acquired the lock
 */
function tryAcquireLock (cacheKey) {
  const lockPath = getLockPath(cacheKey)
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY)
    fs.writeSync(fd, String(Date.now()))
    fs.closeSync(fd)
    return true
  } catch {
    return false
  }
}

/**
 * Removes the lock file.
 *
 * @param {string} cacheKey
 */
function releaseLock (cacheKey) {
  try { fs.unlinkSync(getLockPath(cacheKey)) } catch { /* ignore */ }
}

/**
 * Updates the lock file timestamp so waiters know the owner is still alive.
 *
 * @param {string} cacheKey
 */
function touchLock (cacheKey) {
  try { fs.writeFileSync(getLockPath(cacheKey), String(Date.now())) } catch { /* ignore */ }
}

/**
 * Starts a periodic heartbeat that touches the lock file.
 * Returns a function that stops the heartbeat and releases the lock.
 *
 * @param {string} cacheKey
 * @returns {Function} cleanup function that stops heartbeat and removes lock
 */
function startLockHeartbeat (cacheKey) {
  const interval = setInterval(() => touchLock(cacheKey), CACHE_LOCK_HEARTBEAT_MS)
  interval.unref()
  return () => {
    clearInterval(interval)
    try { fs.unlinkSync(getLockPath(cacheKey)) } catch { /* ignore */ }
  }
}

/**
 * Checks whether the lock file is stale (older than the lock timeout).
 *
 * @param {string} cacheKey
 * @returns {boolean}
 */
function isLockStale (cacheKey) {
  try {
    const content = fs.readFileSync(getLockPath(cacheKey), 'utf8')
    return Date.now() - Number(content) > CACHE_LOCK_TIMEOUT_MS
  } catch {
    return true
  }
}

/**
 * Polls until the cache file appears or the timeout is reached.
 * If the cache appears, calls done with the cached data.
 * If the timeout is reached or the lock is stale, calls fetchFn as fallback.
 *
 * @param {string} cacheKey
 * @param {Function} fetchFn - function(done) that fetches from the API
 * @param {Function} done - callback(err, knownTests)
 */
function waitForCache (cacheKey, fetchFn, done) {
  const deadline = Date.now() + CACHE_LOCK_TIMEOUT_MS
  const poll = () => {
    const cached = readFromCache(cacheKey)
    if (cached) {
      return done(null, cached.knownTests)
    }
    if (Date.now() > deadline || isLockStale(cacheKey)) {
      log.debug('Known tests cache wait timed out, fetching directly')
      releaseLock(cacheKey)
      return fetchFn(done)
    }
    setTimeout(poll, CACHE_LOCK_POLL_MS)
  }
  poll()
}

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
  const cacheKey = buildCacheKey({
    sha,
    service,
    env,
    repositoryUrl,
    osPlatform,
    osVersion,
    osArchitecture,
    runtimeName,
    runtimeVersion,
    custom,
  })

  // Fast path: cache hit
  const cached = readFromCache(cacheKey)
  if (cached) {
    distributionMetric(TELEMETRY_KNOWN_TESTS_RESPONSE_TESTS, {}, cached.numTests)
    return done(null, cached.knownTests)
  }

  // Try to become the fetcher (lock owner)
  const isLockOwner = tryAcquireLock(cacheKey)

  if (!isLockOwner) {
    // Another process is fetching — wait for the cache to appear
    log.debug('Known tests lock held by another process, waiting for cache')
    return waitForCache(cacheKey, (cb) => fetchFromApi({
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
    }, cb), done)
  }

  // This process owns the lock — start heartbeat and fetch
  const stopHeartbeat = startLockHeartbeat(cacheKey)

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
    cacheKey,
  }, (err, knownTests) => {
    stopHeartbeat()
    done(err, knownTests)
  })
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
 * @param {string} params.cacheKey
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

module.exports = { getKnownTests, mergeKnownTests }
