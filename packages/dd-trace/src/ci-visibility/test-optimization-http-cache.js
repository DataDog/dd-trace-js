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
const DEFAULT_VALIDATION_MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_VALIDATION_MAX_ENTRIES = 100_000
const DEFAULT_VALIDATION_MAX_NESTING_DEPTH = 32
const DEFAULT_VALIDATION_MAX_STRING_BYTES = 4096

function parseManifestVersion (content) {
  // Supported just the number version or 'version=x'
  const version = content.replace(/^\uFEFF/, '').trim()
  const match = version.match(/^version=(.+)$/)
  return match ? match[1].trim() : version
}

class TestOptimizationHttpCache {
  constructor ({
    cwd = process.cwd(),
    env,
    validationManifestPath,
    maxFileBytes = DEFAULT_VALIDATION_MAX_FILE_BYTES,
  } = {}) {
    this._cwd = cwd
    // This cache intentionally consumes env vars that are not tracer config keys. (??)
    // eslint-disable-next-line eslint-rules/eslint-process-env
    this._env = env ?? process.env
    this._validationManifestPath = validationManifestPath
    this._maxFileBytes = maxFileBytes
    this._lastError = undefined
    this._manifestPath = validationManifestPath
      ? this._resolveValidationManifestPath(validationManifestPath)
      : this._resolveManifestPath()
    this._testOptimizationPath = undefined
    this._httpCachePath = undefined
    this._available = false

    this._buildReader()
  }

  isAvailable () {
    return this._available
  }

  getLastError () {
    return this._lastError
  }

  readSettings () {
    const payload = this._readFile(SETTINGS_FILE_NAME)
    if (payload === CACHE_MISS) {
      this._disable()
      return CACHE_MISS
    }

    try {
      const settings = parseLibraryConfigurationResponse(
        this._parsePayload(payload, SETTINGS_FILE_NAME),
        undefined,
        { validateRequiredFields: true, validationMode: Boolean(this._validationManifestPath) }
      )
      incrementCountMetric(TELEMETRY_GIT_REQUESTS_SETTINGS_RESPONSE, settings)
      return settings
    } catch (err) {
      this._logInvalidCacheFile(SETTINGS_FILE_NAME, err)
      this._disable()
      return CACHE_MISS
    }
  }

  readKnownTests () {
    const payload = this._readFile(KNOWN_TESTS_FILE_NAME)
    if (payload === CACHE_MISS) return CACHE_MISS

    try {
      const knownTests = parseKnownTestsResponse(
        this._parsePayload(payload, KNOWN_TESTS_FILE_NAME),
        { validateRequiredFields: true, validationMode: Boolean(this._validationManifestPath) }
      )
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
      const boundedPayload = this._parsePayload(payload, SKIPPABLE_TESTS_FILE_NAME)
      const parsedResponse = typeof boundedPayload === 'string' ? JSON.parse(boundedPayload) : boundedPayload
      const result = parseSkippableSuitesResponse(parsedResponse, {
        ...options,
        validateRequiredFields: true,
        validationMode: Boolean(this._validationManifestPath),
      })
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

  hasValidSkippableSuites (options = {}) {
    const payload = this._readFile(SKIPPABLE_TESTS_FILE_NAME)
    if (payload === CACHE_MISS) return false

    try {
      parseSkippableSuitesResponse(
        this._parsePayload(payload, SKIPPABLE_TESTS_FILE_NAME),
        { ...options, validateRequiredFields: true, validationMode: Boolean(this._validationManifestPath) }
      )
      return true
    } catch {
      return false
    }
  }

  readTestManagementTests () {
    const payload = this._readFile(TEST_MANAGEMENT_FILE_NAME)
    if (payload === CACHE_MISS) return CACHE_MISS

    try {
      const testManagementTests = parseTestManagementTestsResponse(
        this._parsePayload(payload, TEST_MANAGEMENT_FILE_NAME),
        { validateRequiredFields: true, validationMode: Boolean(this._validationManifestPath) }
      )
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
      if (this._validationManifestPath && !this._lastError) {
        this._setError('Offline Test Optimization validation manifest was not found.')
      }
      log.debug('Test Optimization HTTP cache manifest not found')
      return
    }

    const version = this._readManifestVersion(this._manifestPath)
    if (version !== SUPPORTED_MANIFEST_VERSION) {
      if (this._validationManifestPath) {
        this._setError(`Unsupported offline Test Optimization validation manifest version: ${version || 'missing'}.`)
      }
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
      if (this._validationManifestPath) {
        this._setError('Offline Test Optimization validation settings fixture is missing.')
      }
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

  _resolveValidationManifestPath (manifestPath) {
    if (!path.isAbsolute(manifestPath)) {
      this._setError('Offline Test Optimization validation manifest path must be absolute.')
      return
    }

    const resolvedManifestPath = path.resolve(manifestPath)
    const testOptimizationPath = path.dirname(resolvedManifestPath)
    const fixtureRoot = path.dirname(testOptimizationPath)
    if (path.basename(resolvedManifestPath) !== MANIFEST_FILE_NAME ||
      path.basename(testOptimizationPath) !== PLAN_FOLDER) {
      this._setError('Offline Test Optimization validation manifest must use the fixed .testoptimization layout.')
      return
    }

    try {
      assertPathComponentsAreNotSymlinks(fixtureRoot, resolvedManifestPath)
      assertRegularFixtureFile(resolvedManifestPath)
      return resolvedManifestPath
    } catch (err) {
      this._setError(err.message)
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
      this._assertValidationFixtureFile(manifestPath)
      return parseManifestVersion(fs.readFileSync(manifestPath, 'utf8'))
    } catch (err) {
      if (this._validationManifestPath) this._setError(err.message)
      log.debug('Failed to read Test Optimization HTTP cache manifest %s: %s', manifestPath, err.message)
    }
  }

  _readFile (fileName) {
    if (!this.isAvailable()) return CACHE_MISS

    const filePath = path.join(this._httpCachePath, fileName)
    try {
      this._assertValidationFixtureFile(filePath)
      log.debug('Reading Test Optimization HTTP cache file %s', filePath)
      return fs.readFileSync(filePath, 'utf8')
    } catch (err) {
      if (this._validationManifestPath) this._setError(err.message)
      log.debug('Test Optimization HTTP cache file %s could not be read: %s', filePath, err.message)
      return CACHE_MISS
    }
  }

  _logInvalidCacheFile (fileName, err) {
    if (this._validationManifestPath) {
      this._setError(`Invalid offline Test Optimization ${fileName} fixture: ${err.message}`)
    }
    log.debug('Test Optimization HTTP cache file %s could not be parsed: %s', fileName, err.message)
  }

  _assertValidationFixtureFile (filePath) {
    if (!this._validationManifestPath) return
    const fixtureRoot = path.dirname(path.dirname(this._manifestPath))
    assertPathComponentsAreNotSymlinks(fixtureRoot, filePath)
    const stat = assertRegularFixtureFile(filePath)
    if (stat.size > this._maxFileBytes) {
      throw new Error(
        `Offline Test Optimization fixture ${path.basename(filePath)} exceeds ${this._maxFileBytes} bytes.`
      )
    }
  }

  _parsePayload (payload, fileName) {
    if (!this._validationManifestPath) return payload

    const parsed = JSON.parse(payload)
    assertBoundedValidationValue(parsed, fileName)
    return parsed
  }

  _setError (message) {
    this._lastError = new Error(message)
  }

  _disable () {
    this._available = false
  }
}

function assertPathComponentsAreNotSymlinks (root, filename) {
  const resolvedRoot = path.resolve(root)
  const resolvedFilename = path.resolve(filename)
  const rootStat = fs.lstatSync(resolvedRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Offline Test Optimization fixture root must be a regular directory: ${resolvedRoot}`)
  }
  const relative = path.relative(resolvedRoot, resolvedFilename)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Offline Test Optimization fixture path escapes its validation root.')
  }

  let current = resolvedRoot
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) {
      throw new Error(`Offline Test Optimization fixture path contains a symbolic link: ${current}`)
    }
  }
}

function assertRegularFixtureFile (filename) {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile()) {
    throw new Error(`Offline Test Optimization fixture is not a regular file: ${filename}`)
  }
  if (stat.nlink > 1) {
    throw new Error(`Offline Test Optimization fixture must not be hard-linked: ${filename}`)
  }
  return stat
}

function assertBoundedValidationValue (value, fileName) {
  const pending = [{ depth: 0, value }]
  let entries = 0

  while (pending.length > 0) {
    const current = pending.pop()
    if (current.depth > DEFAULT_VALIDATION_MAX_NESTING_DEPTH) {
      throw new Error(`${fileName} exceeds the validation nesting limit.`)
    }
    if (typeof current.value === 'string' &&
      Buffer.byteLength(current.value) > DEFAULT_VALIDATION_MAX_STRING_BYTES) {
      throw new Error(`${fileName} contains a string that exceeds the validation limit.`)
    }
    if (!current.value || typeof current.value !== 'object') continue

    const values = Array.isArray(current.value) ? current.value : Object.values(current.value)
    entries += values.length
    if (entries > DEFAULT_VALIDATION_MAX_ENTRIES) {
      throw new Error(`${fileName} exceeds the validation collection-entry limit.`)
    }
    for (const nestedValue of values) {
      pending.push({ depth: current.depth + 1, value: nestedValue })
    }
  }
}

module.exports = {
  CACHE_MISS,
  DEFAULT_VALIDATION_MAX_FILE_BYTES,
  TestOptimizationHttpCache,
}
