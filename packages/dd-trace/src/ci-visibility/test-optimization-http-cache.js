'use strict'

const fs = require('node:fs')
const path = require('node:path')

const log = require('../log')
const { getNumFromKnownTests } = require('../plugins/util/test')
const { parseKnownTestsResponse } = require('./early-flake-detection/get-known-tests')
const { parseSkippableSuitesResponse } = require('./intelligent-test-runner/get-skippable-suites')
const { parseLibraryConfigurationResponse } = require('./requests/get-library-configuration')
const {
  getNumFromTestManagementTests,
  parseTestManagementTestsResponse,
} = require('./test-management/get-test-management-tests')
const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_GIT_REQUESTS_SETTINGS_RESPONSE,
  TELEMETRY_KNOWN_TESTS_RESPONSE_TESTS,
  TELEMETRY_KNOWN_TESTS_RESPONSE_BYTES,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_SUITES,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_TESTS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_BYTES,
  TELEMETRY_TEST_MANAGEMENT_TESTS_RESPONSE_TESTS,
  TELEMETRY_TEST_MANAGEMENT_TESTS_RESPONSE_BYTES,
} = require('./telemetry')

const CACHE_MISS = Symbol('test optimization http cache miss')

const PLAN_FOLDER = '.testoptimization'
const MANIFEST_FILE_NAME = 'manifest.txt'
const SUPPORTED_MANIFEST_VERSION = '1'
const CACHE_FOLDER_NAME = 'cache'
const HTTP_CACHE_FOLDER_NAME = 'http'

const ENV_MANIFEST_FILE = 'TEST_OPTIMIZATION_MANIFEST_FILE'
const ENV_MANIFEST_FILE_ALIAS = 'DD_TEST_OPTIMIZATION_MANIFEST_FILE'
const ENV_RUNFILES_DIR = 'RUNFILES_DIR'
const ENV_RUNFILES_MANIFEST_FILE = 'RUNFILES_MANIFEST_FILE'
const ENV_TEST_SRCDIR = 'TEST_SRCDIR'

const SETTINGS_FILE_NAME = 'settings.json'
const KNOWN_TESTS_FILE_NAME = 'known_tests.json'
const SKIPPABLE_TESTS_FILE_NAME = 'skippable_tests.json'
const TEST_MANAGEMENT_FILE_NAME = 'test_management.json'

const RUNFILES_MANIFEST_SEPARATOR = ' '

function parseManifestVersion (content) {
  // Supported just the number version or 'version=x'
  const version = content.replace(/^\uFEFF/, '').trim()
  const match = version.match(/^version=(.+)$/)
  return match ? match[1].trim() : version
}

class TestOptimizationHttpCache {
  constructor ({ cwd = process.cwd(), env } = {}) {
    this._cwd = cwd
    // This cache intentionally consumes env vars that are not tracer config keys. (??)
    // eslint-disable-next-line eslint-rules/eslint-process-env
    this._env = env ?? process.env
    this._manifestPath = this._resolveManifestPath()
    this._testOptimizationPath = undefined
    this._httpCachePath = undefined
    this._available = false

    this._buildReader()
  }

  isAvailable () {
    return this._available
  }

  readSettings () {
    const payload = this._readFile(SETTINGS_FILE_NAME)
    if (payload === CACHE_MISS) return CACHE_MISS

    try {
      const settings = parseLibraryConfigurationResponse(payload)
      incrementCountMetric(TELEMETRY_GIT_REQUESTS_SETTINGS_RESPONSE, settings)
      return settings
    } catch (err) {
      this._logInvalidCacheFile(SETTINGS_FILE_NAME, err)
      return CACHE_MISS
    }
  }

  readKnownTests () {
    const payload = this._readFile(KNOWN_TESTS_FILE_NAME)
    if (payload === CACHE_MISS) return CACHE_MISS

    try {
      const knownTests = parseKnownTestsResponse(payload)
      distributionMetric(TELEMETRY_KNOWN_TESTS_RESPONSE_TESTS, {}, getNumFromKnownTests(knownTests))
      distributionMetric(TELEMETRY_KNOWN_TESTS_RESPONSE_BYTES, {}, payload.length)
      return knownTests
    } catch (err) {
      this._logInvalidCacheFile(KNOWN_TESTS_FILE_NAME, err)
      return CACHE_MISS
    }
  }

  readSkippableSuites (options = {}) {
    const payload = this._readFile(SKIPPABLE_TESTS_FILE_NAME)
    if (payload === CACHE_MISS) return CACHE_MISS

    try {
      const parsedResponse = JSON.parse(payload)
      const result = parseSkippableSuitesResponse(parsedResponse, options)
      const testLevel = options.testLevel || 'suite'
      const skippableItems = parsedResponse.data.filter(({ type }) => type === testLevel)
      incrementCountMetric(
        testLevel === 'test'
          ? TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_TESTS
          : TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_SUITES,
        {},
        skippableItems.length
      )
      distributionMetric(TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_BYTES, {}, payload.length)
      return result
    } catch (err) {
      this._logInvalidCacheFile(SKIPPABLE_TESTS_FILE_NAME, err)
      return CACHE_MISS
    }
  }

  readTestManagementTests () {
    const payload = this._readFile(TEST_MANAGEMENT_FILE_NAME)
    if (payload === CACHE_MISS) return CACHE_MISS

    try {
      const testManagementTests = parseTestManagementTestsResponse(payload)
      distributionMetric(
        TELEMETRY_TEST_MANAGEMENT_TESTS_RESPONSE_TESTS,
        {},
        getNumFromTestManagementTests(testManagementTests)
      )
      distributionMetric(TELEMETRY_TEST_MANAGEMENT_TESTS_RESPONSE_BYTES, {}, payload.length)
      return testManagementTests
    } catch (err) {
      this._logInvalidCacheFile(TEST_MANAGEMENT_FILE_NAME, err)
      return CACHE_MISS
    }
  }

  _buildReader () {
    if (!this._manifestPath) {
      log.debug('Test Optimization HTTP cache manifest not found')
      return
    }

    const version = this._readManifestVersion(this._manifestPath)
    if (version !== SUPPORTED_MANIFEST_VERSION) {
      log.debug('Unsupported Test Optimization HTTP cache manifest version %j at %s', version, this._manifestPath)
      return
    }

    this._testOptimizationPath = path.dirname(this._manifestPath)
    this._httpCachePath = path.join(
      this._testOptimizationPath,
      CACHE_FOLDER_NAME,
      HTTP_CACHE_FOLDER_NAME
    )

    const settingsPath = path.join(this._httpCachePath, SETTINGS_FILE_NAME)
    if (!fs.existsSync(settingsPath)) {
      log.debug('Test Optimization HTTP cache settings file not found at %s', settingsPath)
      return
    }

    log.debug('Test Optimization HTTP cache found at %s', this._httpCachePath)
    this._available = true
  }

  _resolveManifestPath () {
    const localManifest = path.join(this._cwd, PLAN_FOLDER, MANIFEST_FILE_NAME)
    if (fs.existsSync(localManifest)) {
      return localManifest
    }

    const manifestFile = this._env[ENV_MANIFEST_FILE] || this._env[ENV_MANIFEST_FILE_ALIAS]
    if (!manifestFile) return

    const resolvedManifestPath = this._resolveRunfilePath(manifestFile)
    if (fs.existsSync(resolvedManifestPath)) {
      return resolvedManifestPath
    }
  }

  _resolveRunfilePath (manifestFile) {
    if (fs.existsSync(manifestFile)) {
      return manifestFile
    }

    const runfilesDir = this._env[ENV_RUNFILES_DIR]
    if (runfilesDir) {
      const candidate = path.join(runfilesDir, manifestFile)
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }

    const runfilesManifestCandidate = this._resolveRunfilePathFromManifest(manifestFile)
    if (runfilesManifestCandidate) {
      return runfilesManifestCandidate
    }

    const testSrcdir = this._env[ENV_TEST_SRCDIR]
    if (testSrcdir) {
      const candidate = path.join(testSrcdir, manifestFile)
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }

    return manifestFile
  }

  _resolveRunfilePathFromManifest (manifestFile) {
    const runfilesManifest = this._env[ENV_RUNFILES_MANIFEST_FILE]
    if (!runfilesManifest || !fs.existsSync(runfilesManifest)) return

    try {
      const lines = fs.readFileSync(runfilesManifest, 'utf8').split('\n')
      for (const line of lines) {
        const separatorIndex = line.indexOf(RUNFILES_MANIFEST_SEPARATOR)
        if (separatorIndex <= 0) continue
        if (line.slice(0, separatorIndex) !== manifestFile) continue

        const resolvedPath = line.slice(separatorIndex + 1).trim()
        if (resolvedPath) return resolvedPath
      }
    } catch (err) {
      log.debug('Failed to resolve Test Optimization HTTP cache manifest from %s: %s', runfilesManifest, err.message)
    }
  }

  _readManifestVersion (manifestPath) {
    try {
      return parseManifestVersion(fs.readFileSync(manifestPath, 'utf8'))
    } catch (err) {
      log.debug('Failed to read Test Optimization HTTP cache manifest %s: %s', manifestPath, err.message)
    }
  }

  _readFile (fileName) {
    if (!this.isAvailable()) return CACHE_MISS

    const filePath = path.join(this._httpCachePath, fileName)
    try {
      log.debug('Reading Test Optimization HTTP cache file %s', filePath)
      return fs.readFileSync(filePath, 'utf8')
    } catch (err) {
      log.debug('Test Optimization HTTP cache file %s could not be read: %s', filePath, err.message)
      return CACHE_MISS
    }
  }

  _logInvalidCacheFile (fileName, err) {
    log.debug('Test Optimization HTTP cache file %s could not be parsed: %s', fileName, err.message)
  }
}

module.exports = {
  CACHE_MISS,
  TestOptimizationHttpCache,
}
