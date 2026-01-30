'use strict'

const { writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
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

module.exports = {
  getSettingsCachePath,
  setupSettingsCachePath,
  writeSettingsToCache
}
