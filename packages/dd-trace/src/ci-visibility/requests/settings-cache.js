'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const log = require('../../log')

const SETTINGS_CACHE_DIR = path.join(os.tmpdir(), 'dd-ci-visibility-settings-cache')

/**
 * Ensures the cache directory exists.
 * @returns {boolean} true if the cache directory exists or was created, false otherwise.
 */
function ensureCacheDir () {
  try {
    if (fs.existsSync(SETTINGS_CACHE_DIR)) {
      const stats = fs.statSync(SETTINGS_CACHE_DIR)
      if (!stats.isDirectory()) {
        throw new Error(`Cache directory path exists but is not a directory: ${SETTINGS_CACHE_DIR}`)
      }
    } else {
      fs.mkdirSync(SETTINGS_CACHE_DIR, { recursive: true })
    }
    return true
  } catch (err) {
    log.error('Failed to create settings cache directory', err)
    return false
  }
}

/**
 * Generates a cache key from the commit SHA and repository URL.
 * @param {string} sha - The commit SHA.
 * @param {string} repositoryUrl - The repository URL.
 * @returns {string} The cache key.
 */
function getCacheKey (sha, repositoryUrl) {
  const keyString = `${sha}:${repositoryUrl}`
  return crypto.createHash('sha256').update(keyString).digest('hex')
}

/**
 * Gets the cache file path for the given cache key.
 * @param {string} cacheKey - The cache key.
 * @returns {string} The cache file path.
 */
function getCacheFilePath (cacheKey) {
  return path.join(SETTINGS_CACHE_DIR, `${cacheKey}.json`)
}

/**
 * Writes the settings to the cache.
 * @param {string} sha - The commit SHA.
 * @param {string} repositoryUrl - The repository URL.
 * @param {object} settings - The settings object to cache.
 */
function writeSettingsToCache (sha, repositoryUrl, settings) {
  if (!sha || !repositoryUrl) {
    return
  }

  if (!ensureCacheDir()) {
    return
  }

  try {
    const cacheKey = getCacheKey(sha, repositoryUrl)
    const cacheFilePath = getCacheFilePath(cacheKey)
    const cacheContent = JSON.stringify(settings)
    fs.writeFileSync(cacheFilePath, cacheContent, 'utf8')
    log.debug('Settings cached to %s', cacheFilePath)
  } catch (err) {
    log.error('Failed to write settings cache', err)
  }
}

/**
 * Reads the settings from the cache.
 * @param {string} sha - The commit SHA.
 * @param {string} repositoryUrl - The repository URL.
 * @returns {object|null} The cached settings object, or null if not found.
 */
function readSettingsFromCache (sha, repositoryUrl) {
  if (!sha || !repositoryUrl) {
    return null
  }

  try {
    const cacheKey = getCacheKey(sha, repositoryUrl)
    const cacheFilePath = getCacheFilePath(cacheKey)

    if (!fs.existsSync(cacheFilePath)) {
      log.debug('Settings cache file not found: %s', cacheFilePath)
      return null
    }

    const cacheContent = fs.readFileSync(cacheFilePath, 'utf8')
    const settings = JSON.parse(cacheContent)
    log.debug('Settings read from cache: %s', cacheFilePath)
    return settings
  } catch (err) {
    log.error('Failed to read settings cache', err)
    return null
  }
}

module.exports = {
  getCacheKey,
  getCacheFilePath,
  writeSettingsToCache,
  readSettingsFromCache
}
