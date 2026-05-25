'use strict'

const { randomUUID } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const { getValueFromEnvSources } = require('../config/helper')
const log = require('../log')

/**
 * Gets the test optimization settings cache file path from the env var.
 * @returns {string|undefined} The cache file path, or undefined if not set.
 */
function getSettingsCachePath () {
  return getValueFromEnvSources('DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE')
}

/**
 * Gets the coverage backfill cache path derived from the settings cache path.
 * @returns {string|undefined} The coverage backfill cache file path,
 *   or undefined if settings cache is not configured.
 */
function getCoverageBackfillCachePath () {
  const settingsCachePath = getSettingsCachePath()
  return settingsCachePath ? `${settingsCachePath}.coverage-backfill.json` : undefined
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
 * Writes the settings to the cache file specified by DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE.
 * Does nothing if the env var is not set.
 * @param {object} settings - The settings object to cache.
 */
function writeSettingsToCache (settings) {
  const settingsCachePath = getSettingsCachePath()
  if (!settingsCachePath) {
    return
  }

  try {
    writeFileSync(settingsCachePath, JSON.stringify(settings), 'utf8')
    log.debug('Settings written to %s', settingsCachePath)
  } catch (err) {
    log.error('Failed to write settings to cache file', err)
  }
}

/**
 * Writes backend coverage for actually skipped suites to the shared coverage backfill cache.
 * @param {object} coverageBackfill - Backend coverage bitmap data keyed by repository-relative file path.
 */
function writeCoverageBackfillToCache (coverageBackfill) {
  const coverageBackfillCachePath = getCoverageBackfillCachePath()
  if (!coverageBackfillCachePath) {
    return
  }

  try {
    writeFileSync(coverageBackfillCachePath, JSON.stringify(coverageBackfill || {}), 'utf8')
  } catch (err) {
    log.error('Failed to write coverage backfill cache file', err)
  }
}

/**
 * Reads backend coverage for actually skipped suites from the shared coverage backfill cache.
 * @returns {object|undefined} Coverage bitmap data keyed by repository-relative file path.
 */
function readCoverageBackfillFromCache () {
  const coverageBackfillCachePath = getCoverageBackfillCachePath()
  if (!coverageBackfillCachePath) {
    return
  }

  try {
    return JSON.parse(readFileSync(coverageBackfillCachePath, 'utf8'))
  } catch {}
}

module.exports = {
  getCoverageBackfillCachePath,
  getSettingsCachePath,
  readCoverageBackfillFromCache,
  setupSettingsCachePath,
  writeCoverageBackfillToCache,
  writeSettingsToCache,
}
