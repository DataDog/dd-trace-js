'use strict'

const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const path = require('node:path')

const { getValueFromEnvSources } = require('../config/helper')
const log = require('../log')

const COVERAGE_BACKFILL_KEY = '_ddCoverageBackfill'
const COVERAGE_BACKFILL_ROOT_DIR_KEY = '_ddCoverageBackfillRootDir'

/**
 * Gets the test optimization settings cache file path from the env var.
 * @returns {string|undefined} The cache file path, or undefined if not set.
 */
function getSettingsCachePath () {
  return getValueFromEnvSources('DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE')
}

/**
 * Sets up the test optimization settings cache file path.
 * Returns the existing path if already set, otherwise creates a new one.
 * @returns {string} The cache file path.
 */
function setupSettingsCachePath () {
  const existing = getSettingsCachePath()
  if (existing) {
    return existing
  }

  const cacheFilePath = path.join(tmpdir(), `dd-test-optimization-${randomUUID()}.json`)

  // eslint-disable-next-line eslint-rules/eslint-process-env
  process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE = cacheFilePath

  return cacheFilePath
}

/**
 * Reads the shared test optimization cache file.
 * @returns {object} Cached settings and metadata.
 */
function readCacheFile () {
  const settingsCachePath = getSettingsCachePath()
  if (!settingsCachePath || !existsSync(settingsCachePath)) {
    return {}
  }

  try {
    return JSON.parse(readFileSync(settingsCachePath, 'utf8'))
  } catch (err) {
    log.debug('Failed to read settings cache: %s', err.message)
    return {}
  }
}

/**
 * Writes the shared test optimization cache file.
 * @param {object} cache - Cached settings and metadata.
 */
function writeCacheFile (cache) {
  const settingsCachePath = getSettingsCachePath()
  if (!settingsCachePath) {
    return
  }

  try {
    writeFileSync(settingsCachePath, JSON.stringify(cache), 'utf8')
    log.debug('Settings written to %s', settingsCachePath)
  } catch (err) {
    log.error('Failed to write settings to cache file', err)
  }
}

/**
 * Writes the settings to the cache file specified by DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE.
 * Does nothing if the env var is not set.
 * @param {object} settings - The settings object to cache.
 */
function writeSettingsToCache (settings) {
  writeCacheFile({
    ...readCacheFile(),
    ...settings,
  })
}

/**
 * Writes TIA coverage backfill to the shared nyc settings cache.
 * @param {object} coverage - Repository-relative coverage bitmaps by filename.
 * @param {string} [rootDir] - Root directory that coverage filenames are relative to.
 */
function writeCoverageBackfillToCache (coverage, rootDir) {
  writeCacheFile({
    ...readCacheFile(),
    [COVERAGE_BACKFILL_KEY]: coverage,
    [COVERAGE_BACKFILL_ROOT_DIR_KEY]: rootDir,
  })
}

/**
 * Reads TIA coverage backfill from the shared nyc settings cache.
 * @returns {object|undefined} Repository-relative coverage bitmaps by filename.
 */
function readCoverageBackfillFromCache () {
  return readCacheFile()[COVERAGE_BACKFILL_KEY]
}

/**
 * Reads TIA coverage backfill root directory from the shared nyc settings cache.
 * @returns {string|undefined} Root directory that cached coverage filenames are relative to.
 */
function readCoverageBackfillRootDirFromCache () {
  return readCacheFile()[COVERAGE_BACKFILL_ROOT_DIR_KEY]
}

module.exports = {
  getSettingsCachePath,
  readCoverageBackfillFromCache,
  readCoverageBackfillRootDirFromCache,
  setupSettingsCachePath,
  writeCoverageBackfillToCache,
  writeSettingsToCache,
}
