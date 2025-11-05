'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const log = require('../../log')
const { getEnvironmentVariable } = require('../../config-helper')
const { isTrue } = require('../../util')

// Cache TTL in milliseconds (default: 2 hours for a test session)
const DEFAULT_CACHE_TTL = 2 * 60 * 60 * 1000

// Check if caching is enabled via environment variable
function isCacheEnabled () {
  const cacheEnabled = getEnvironmentVariable('DD_CIVISIBILITY_CACHE_ENABLED')
  return isTrue(cacheEnabled)
}

// Get cache directory - use custom dir or temp dir for session-scoped cache
function getCacheDir () {
  const customDir = getEnvironmentVariable('DD_CIVISIBILITY_CACHE_DIR')
  const cacheDir = customDir || path.join(os.tmpdir(), 'dd-trace-ci-cache')
  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }
  } catch (err) {
    log.debug('Failed to create cache directory:', err)
  }
  return cacheDir
}

/**
 * Generate a cache key from request parameters
 */
function generateCacheKey (prefix, params) {
  const hash = crypto.createHash('sha256')
  hash.update(JSON.stringify(params))
  return `${prefix}-${hash.digest('hex')}`
}

/**
 * Get the lock file path for a given cache key
 */
function getLockFilePath (cacheKey) {
  return path.join(getCacheDir(), `${cacheKey}.lock`)
}

/**
 * Get the cache file path for a given cache key
 */
function getCacheFilePath (cacheKey) {
  return path.join(getCacheDir(), `${cacheKey}.json`)
}

/**
 * Try to acquire a lock for writing to cache
 * Uses atomic file creation to prevent race conditions
 * Returns true if lock acquired, false otherwise
 */
function tryAcquireLock (cacheKey, maxWaitMs = 30_000) {
  const lockFile = getLockFilePath(cacheKey)
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Try to create lock file exclusively (fails if exists)
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' })
      return true
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Lock exists, check if it's stale (process might have died)
        try {
          const lockPid = Number.parseInt(fs.readFileSync(lockFile, 'utf8'), 10)
          // Check if process is still running
          try {
            process.kill(lockPid, 0) // Signal 0 checks existence without killing
            // Process exists, wait a bit and retry
            const waitTime = Math.min(100, maxWaitMs - (Date.now() - startTime))
            if (waitTime > 0) {
              // Simple busy wait
              const waitUntil = Date.now() + waitTime
              while (Date.now() < waitUntil) {
                // Busy wait
              }
            }
          } catch {
            // Process doesn't exist, lock is stale - remove it
            try {
              fs.unlinkSync(lockFile)
            } catch {
              // Another process may have already removed it
            }
          }
        } catch {
          // Can't read lock file, try to remove it
          try {
            fs.unlinkSync(lockFile)
          } catch {
            // Ignore
          }
        }
      } else {
        // Other error, can't acquire lock
        log.debug('Error acquiring lock:', err)
        return false
      }
    }
  }

  return false
}

/**
 * Release a lock
 */
function releaseLock (cacheKey) {
  const lockFile = getLockFilePath(cacheKey)
  try {
    fs.unlinkSync(lockFile)
  } catch (err) {
    // Ignore errors on release
    log.debug('Error releasing lock:', err)
  }
}

/**
 * Read from cache if available and not expired
 * Returns null if cache miss or expired
 */
function readFromCache (cacheKey, ttl = DEFAULT_CACHE_TTL) {
  const cacheFile = getCacheFilePath(cacheKey)

  try {
    if (!fs.existsSync(cacheFile)) {
      return null
    }

    const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    const now = Date.now()

    // Check if cache is expired
    if (now - cacheData.timestamp > ttl) {
      log.debug('Cache expired for key:', cacheKey)
      // Clean up expired cache file
      try {
        fs.unlinkSync(cacheFile)
      } catch {
        // Ignore cleanup errors
      }
      return null
    }

    log.debug('Cache hit for key:', cacheKey)
    return cacheData.data
  } catch (err) {
    log.debug('Error reading from cache:', err)
    return null
  }
}

/**
 * Write to cache with lock protection
 */
function writeToCache (cacheKey, data, ttl = DEFAULT_CACHE_TTL) {
  const cacheFile = getCacheFilePath(cacheKey)

  try {
    const cacheData = {
      timestamp: Date.now(),
      data
    }

    // Write atomically using temp file + rename
    const tempFile = `${cacheFile}.tmp.${process.pid}`
    fs.writeFileSync(tempFile, JSON.stringify(cacheData), 'utf8')
    fs.renameSync(tempFile, cacheFile)

    log.debug('Cache written for key:', cacheKey)
    return true
  } catch (err) {
    log.debug('Error writing to cache:', err)
    return false
  }
}

/**
 * Wrap a request function with caching logic
 * The wrapped function will:
 * 1. Check cache first
 * 2. If cache miss, acquire lock
 * 3. Check cache again (another process might have filled it)
 * 4. Make request if still needed
 * 5. Cache the result
 * 6. Release lock
 *
 * @param {string} cachePrefix - Prefix for cache key
 * @param {function} requestFn - Original request function (params, callback)
 * @param {function} getCacheParams - Function to extract cache key params from request params
 * @param {number} ttl - Cache TTL in milliseconds
 */
function withCache (cachePrefix, requestFn, getCacheParams, ttl = DEFAULT_CACHE_TTL) {
  return function cachedRequest (params, callback) {
    // Check if caching is enabled
    if (!isCacheEnabled()) {
      // Cache disabled - call original function directly
      return requestFn(params, callback)
    }

    // Generate cache key from relevant params
    const cacheParams = getCacheParams(params)
    const cacheKey = generateCacheKey(cachePrefix, cacheParams)

    // Try to read from cache first
    const cachedResult = readFromCache(cacheKey, ttl)
    if (cachedResult !== null) {
      // Cache hit - return immediately
      return process.nextTick(() => callback(null, ...cachedResult))
    }

    // Cache miss - try to acquire lock
    const hasLock = tryAcquireLock(cacheKey)

    if (hasLock) {
      // We have the lock - check cache again (double-check pattern)
      const cachedResultAfterLock = readFromCache(cacheKey, ttl)
      if (cachedResultAfterLock !== null) {
        releaseLock(cacheKey)
        return process.nextTick(() => callback(null, ...cachedResultAfterLock))
      }

      // Still no cache - make the request
      requestFn(params, (err, ...results) => {
        if (!err) {
          // Cache successful results
          writeToCache(cacheKey, results, ttl)
        }

        releaseLock(cacheKey)
        callback(err, ...results)
      })
    } else {
      // Couldn't acquire lock - another process is fetching
      // Wait a bit and check cache again
      const maxRetries = 30
      let retries = 0

      const checkCacheInterval = setInterval(() => {
        const cachedResultAfterWait = readFromCache(cacheKey, ttl)
        if (cachedResultAfterWait !== null) {
          clearInterval(checkCacheInterval)
          return callback(null, ...cachedResultAfterWait)
        }

        retries++
        if (retries >= maxRetries) {
          clearInterval(checkCacheInterval)
          // Fallback to making request without cache
          log.debug('Cache wait timeout, making request without cache')
          requestFn(params, callback)
        }
      }, 1000)
    }
  }
}

module.exports = {
  withCache,
  generateCacheKey,
  readFromCache,
  writeToCache,
  tryAcquireLock,
  releaseLock,
  DEFAULT_CACHE_TTL
}
