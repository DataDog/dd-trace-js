'use strict'

const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const path = require('node:path')

const { getValueFromEnvSources } = require('../config/helper')

// Path to store the cache folder location (persists across process forks)
const CACHE_FOLDER_MARKER_PATH = path.join(tmpdir(), '.dd-test-optimization-cache-folder')

/**
 * Gets the test optimization cache folder path.
 * Reads from env var first, falls back to marker file for forked processes.
 * @returns {string|undefined}
 */
function getCacheFolderPath () {
  // Try env var first
  const envValue = getValueFromEnvSources('DD_TEST_OPTIMIZATION_CACHE_FOLDER')
  if (envValue) {
    return envValue
  }

  // Fall back to marker file (for forked processes where env var might not persist)
  try {
    if (existsSync(CACHE_FOLDER_MARKER_PATH)) {
      return readFileSync(CACHE_FOLDER_MARKER_PATH, 'utf8').trim()
    }
  } catch {
    // Ignore read errors
  }
}

/**
 * Creates the test optimization cache folder and sets it up for sharing.
 * @returns {string|undefined} The cache folder path, or undefined if creation failed.
 */
function createCacheFolderIfNeeded () {
  // Check if already set up
  const existing = getCacheFolderPath()
  if (existing && existsSync(existing)) {
    return existing
  }

  // Create new cache folder
  const cacheFolder = path.join(tmpdir(), `dd-test-optimization-${randomUUID()}`)
  try {
    mkdirSync(cacheFolder, { recursive: true })
    // eslint-disable-next-line eslint-rules/eslint-process-env
    process.env.DD_TEST_OPTIMIZATION_CACHE_FOLDER = cacheFolder
    // Also write to marker file so forked processes can find it
    writeFileSync(CACHE_FOLDER_MARKER_PATH, cacheFolder)
    return cacheFolder
  } catch {
    // Ignore errors creating cache folder
  }
}

module.exports = {
  getCacheFolderPath,
  createCacheFolderIfNeeded,
  CACHE_FOLDER_MARKER_PATH
}
