'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { tmpdir } = require('node:os')

const log = require('../../log')
const { getValueFromEnvSources } = require('../../config/helper')

const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes
const CACHE_LOCK_POLL_MS = 500
const CACHE_LOCK_TIMEOUT_MS = 120_000 // 2 minutes
const CACHE_LOCK_HEARTBEAT_MS = 30_000 // 30 seconds

/**
 * Returns whether the filesystem cache is enabled via the env var.
 *
 * @returns {boolean}
 */
function isCacheEnabled () {
  const { isTrue } = require('../../util')
  return isTrue(getValueFromEnvSources('DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE'))
}

/**
 * Builds a deterministic cache key by hashing arbitrary key-value parts.
 *
 * @param {string} prefix - Cache file prefix (e.g. 'known-tests', 'skippable', 'test-mgmt')
 * @param {Array<string | undefined>} parts - Values that uniquely identify the cached response
 * @returns {string}
 */
function buildCacheKey (prefix, parts) {
  const hash = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
  return `${prefix}-${hash}`
}

/**
 * @param {string} cacheKey
 * @returns {string}
 */
function getCachePath (cacheKey) {
  return path.join(tmpdir(), `dd-${cacheKey}.json`)
}

/**
 * @param {string} cacheKey
 * @returns {string}
 */
function getLockPath (cacheKey) {
  return path.join(tmpdir(), `dd-${cacheKey}.lock`)
}

/**
 * Attempts to read cached data from the filesystem.
 *
 * @param {string} cacheKey
 * @returns {{ data: object } | undefined}
 */
function readFromCache (cacheKey) {
  const cachePath = getCachePath(cacheKey)
  try {
    const raw = fs.readFileSync(cachePath, 'utf8')
    const { timestamp, data } = JSON.parse(raw)
    if (Date.now() - timestamp > CACHE_TTL_MS) {
      log.debug('%s cache expired (age: %d ms)', cacheKey, Date.now() - timestamp)
      return
    }
    log.debug('%s cache hit', cacheKey)
    return { data }
  } catch {
    // Cache file missing, corrupt, or unreadable — treat as cache miss
  }
}

/**
 * Writes data to the filesystem cache atomically.
 *
 * @param {string} cacheKey
 * @param {object} data
 */
function writeToCache (cacheKey, data) {
  if (!cacheKey) return
  const cachePath = getCachePath(cacheKey)
  const tmpPath = cachePath + '.tmp.' + process.pid
  try {
    fs.writeFileSync(tmpPath, JSON.stringify({ timestamp: Date.now(), data }), 'utf8')
    fs.renameSync(tmpPath, cachePath)
    log.debug('Cache written: %s', cachePath)
  } catch (err) {
    log.error('Failed to write cache %s: %s', cacheKey, err.message)
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}

/**
 * Attempts to acquire an exclusive lock using O_CREAT|O_EXCL.
 *
 * @param {string} cacheKey
 * @returns {boolean}
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
 * @returns {Function}
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
 *
 * @param {string} cacheKey
 * @param {Function} fetchFn - function(done) that fetches from the API
 * @param {Function} done - callback(err, data)
 */
function waitForCache (cacheKey, fetchFn, done) {
  const deadline = Date.now() + CACHE_LOCK_TIMEOUT_MS
  const poll = () => {
    const cached = readFromCache(cacheKey)
    if (cached) {
      return done(null, cached.data)
    }
    if (Date.now() > deadline || isLockStale(cacheKey)) {
      log.debug('%s cache wait timed out, fetching directly', cacheKey)
      releaseLock(cacheKey)
      return fetchFn(done)
    }
    setTimeout(poll, CACHE_LOCK_POLL_MS)
  }
  poll()
}

/**
 * Wraps a fetch function with filesystem-based caching and cross-process deduplication.
 *
 * When cache is disabled (env var not set), calls fetchFn directly.
 * When enabled, checks cache → acquires lock → fetches → writes cache → releases lock.
 *
 * @param {string} cacheKey - Unique cache key for this request
 * @param {Function} fetchFn - function(cacheKey, done) that performs the API request.
 *   Must call writeToCache(cacheKey, data) on success before calling done(null, data).
 * @param {Function} done - callback(err, ...results)
 */
function withCache (cacheKey, fetchFn, done) {
  if (!isCacheEnabled()) {
    return fetchFn(null, done)
  }

  // Fast path: cache hit
  const cached = readFromCache(cacheKey)
  if (cached) {
    return done(null, cached.data)
  }

  // Try to become the fetcher (lock owner)
  const isLockOwner = tryAcquireLock(cacheKey)

  if (!isLockOwner) {
    log.debug('%s lock held by another process, waiting for cache', cacheKey)
    return waitForCache(cacheKey, (cb) => fetchFn(cacheKey, cb), done)
  }

  // This process owns the lock — start heartbeat and fetch
  const stopHeartbeat = startLockHeartbeat(cacheKey)

  fetchFn(cacheKey, (err, ...results) => {
    stopHeartbeat()
    done(err, ...results)
  })
}

module.exports = {
  isCacheEnabled,
  buildCacheKey,
  readFromCache,
  writeToCache,
  withCache,
  getCachePath,
  getLockPath,
}
