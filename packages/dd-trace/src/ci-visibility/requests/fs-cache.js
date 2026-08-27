'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { tmpdir } = require('node:os')

const getConfig = require('../../config')
const log = require('../../log')

const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes
const CACHE_LOCK_POLL_MS = 500
const CACHE_LOCK_TIMEOUT_MS = 120_000 // 2 minutes
const CACHE_LOCK_HEARTBEAT_MS = 30_000 // 30 seconds

/**
 * Returns whether the filesystem cache is enabled via config.
 *
 * @returns {boolean}
 */
function isCacheEnabled () {
  return getConfig().DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE
}

/**
 * Builds a deterministic cache key by hashing arbitrary key-value parts.
 *
 * @param {string} prefix - Cache file prefix (e.g. 'known-tests', 'skippable', 'test-mgmt')
 * @param {Array<unknown>} parts - Values that uniquely identify the cached response
 * @returns {string}
 */
function buildCacheKey (prefix, parts) {
  const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
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
 * Checks whether a filesystem cache timestamp can be safely compared with the current time.
 *
 * @param {unknown} timestamp - Timestamp read from a cache or lock file.
 * @param {number} now - Current Unix timestamp in milliseconds.
 * @returns {timestamp is number}
 */
function isValidTimestamp (timestamp, now) {
  return Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= now
}

/**
 * Attempts to read cached data from the filesystem.
 *
 * @param {string} cacheKey
 * @param {number} [cacheTtlMs] - Maximum cache age in milliseconds.
 * @returns {{ data: unknown } | undefined}
 */
function readFromCache (cacheKey, cacheTtlMs = CACHE_TTL_MS) {
  const cachePath = getCachePath(cacheKey)
  try {
    const raw = fs.readFileSync(cachePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Object.hasOwn(parsed, 'data')) {
      log.debug('%s cache file has no data field, ignoring', cacheKey)
      return
    }
    const { timestamp, data } = parsed
    const now = Date.now()
    if (!isValidTimestamp(timestamp, now)) {
      log.debug('%s cache file has an invalid timestamp, ignoring', cacheKey)
      return
    }
    const age = now - timestamp
    if (age > cacheTtlMs) {
      log.debug('%s cache expired (age: %d ms)', cacheKey, age)
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
 * @param {unknown} data
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
 * @returns {boolean|undefined}
 */
function tryAcquireLock (cacheKey) {
  const lockPath = getLockPath(cacheKey)
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY)
    fs.writeSync(fd, String(Date.now()))
    fs.closeSync(fd)
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return false
    log.debug('%s lock cannot be created, bypassing cache: %s', cacheKey, err.message)
  }
}

/**
 * Removes the lock file.
 *
 * @param {string} cacheKey
 * @returns {boolean}
 */
function releaseLock (cacheKey) {
  try {
    fs.unlinkSync(getLockPath(cacheKey))
    return true
  } catch (err) {
    return err.code === 'ENOENT'
  }
}

/**
 * Updates the lock file timestamp so waiters know the owner is still alive.
 *
 * @param {string} cacheKey
 */
function touchLock (cacheKey) {
  const lockPath = getLockPath(cacheKey)
  const tmpPath = lockPath + '.tmp.' + process.pid
  try {
    fs.writeFileSync(tmpPath, String(Date.now()))
    fs.renameSync(tmpPath, lockPath)
  } catch {
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  }
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
  interval.unref?.()
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
    const timestamp = Number(content)
    const now = Date.now()
    return !isValidTimestamp(timestamp, now) || now - timestamp > CACHE_LOCK_TIMEOUT_MS
  } catch {
    return true
  }
}

/**
 * Polls until the cache file appears or the timeout is reached.
 *
 * @param {string} cacheKey
 * @param {Function} fetchFn - function(cacheKey, done) that fetches from the API
 * @param {Function} done - callback(err, ...results)
 * @param {number} cacheTtlMs - Maximum cache age in milliseconds.
 */
function waitForCache (cacheKey, fetchFn, done, cacheTtlMs) {
  const poll = () => {
    const cached = readFromCache(cacheKey, cacheTtlMs)
    if (cached) {
      return done(null, cached.data)
    }
    if (isLockStale(cacheKey)) {
      log.debug('%s lock is stale, attempting takeover', cacheKey)
      if (!releaseLock(cacheKey)) {
        return fetchFn(null, done)
      }
      const isLockOwner = tryAcquireLock(cacheKey)
      if (isLockOwner === undefined) {
        return fetchFn(null, done)
      }
      if (!isLockOwner) {
        return setTimeout(poll, CACHE_LOCK_POLL_MS)
      }

      const cachedAfterTakeover = readFromCache(cacheKey, cacheTtlMs)
      if (cachedAfterTakeover) {
        releaseLock(cacheKey)
        return done(null, cachedAfterTakeover.data)
      }

      const stopHeartbeat = startLockHeartbeat(cacheKey)
      return fetchFn(cacheKey, (err, ...results) => {
        stopHeartbeat()
        done(err, ...results)
      })
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
 * @param {number} [cacheTtlMs] - Maximum cache age in milliseconds.
 */
function withCache (cacheKey, fetchFn, done, cacheTtlMs = CACHE_TTL_MS) {
  if (!isCacheEnabled()) {
    return fetchFn(null, done)
  }

  // Fast path: cache hit
  const cached = readFromCache(cacheKey, cacheTtlMs)
  if (cached) {
    return done(null, cached.data)
  }

  // Try to become the fetcher (lock owner)
  const isLockOwner = tryAcquireLock(cacheKey)

  if (isLockOwner === undefined) {
    return fetchFn(null, done)
  }

  if (!isLockOwner) {
    log.debug('%s lock held by another process, waiting for cache', cacheKey)
    return waitForCache(cacheKey, fetchFn, done, cacheTtlMs)
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
