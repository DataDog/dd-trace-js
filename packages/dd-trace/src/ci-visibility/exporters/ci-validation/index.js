'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const TestOptimizationHttpCache = require('../../test-optimization-http-cache').TestOptimizationHttpCache
const CiVisibilityExporter = require('../ci-visibility-exporter')
const { CiValidationSink } = require('./sink')
const CiValidationWriter = require('./writer')

const VALIDATION_MANIFEST_ENV = '_DD_TEST_OPTIMIZATION_VALIDATION_MANIFEST_FILE'
const VALIDATION_OUTPUT_ENV = '_DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_DIR'
const VALIDATION_CAPTURE_MODE_ENV = '_DD_TEST_OPTIMIZATION_VALIDATION_CAPTURE_MODE'

class CiValidationExporter extends CiVisibilityExporter {
  /**
   * Creates an immediately available cache-only Test Optimization exporter.
   *
   * @param {object} config tracer configuration
   */
  constructor (config) {
    const validationManifestPath = process.env[VALIDATION_MANIFEST_ENV]
    const validationOutputRoot = process.env[VALIDATION_OUTPUT_ENV]
    if (!validationManifestPath) {
      throw new Error('Offline Test Optimization validation requires an explicit private manifest path.')
    }
    if (!validationOutputRoot) {
      throw new Error('Offline Test Optimization validation requires an explicit private output root.')
    }
    const cache = new TestOptimizationHttpCache({
      validationManifestPath,
    })
    super(config, { cacheOnly: true, testOptimizationHttpCache: cache })

    this._sink = new CiValidationSink(validationOutputRoot, {
      captureMode: process.env[VALIDATION_CAPTURE_MODE_ENV] || 'strict',
    })
    this._writer = new CiValidationWriter({ sink: this._sink, tags: config.tags })
    this._isInitialized = true
    this._isGzipCompatible = false
    this._resolveCanUseCiVisProtocol(true)
    this._resolveGit()
    this.exportUncodedTraces()

    this._finalizeValidation = () => this.flush(() => this._sink.writeSummary())
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(this._finalizeValidation)
    process.once('exit', this._finalizeValidation)
  }

  /**
   * Loads library settings from the validator-controlled cache.
   *
   * @param {object} testConfiguration test configuration identity
   * @param {Function} callback completion callback
   */
  getLibraryConfiguration (testConfiguration, callback) {
    super.getLibraryConfiguration(testConfiguration, (err, configuration) => {
      this._sink.writeInputResult('settings', err)
      if (err) process.exitCode = 1
      callback(err, configuration)
    })
  }

  /**
   * Loads known tests from the validator-controlled cache.
   *
   * @param {object} testConfiguration test configuration identity
   * @param {Function} callback completion callback
   */
  getKnownTests (testConfiguration, callback) {
    super.getKnownTests(testConfiguration, (err, tests) => {
      this._sink.writeInputResult('known_tests', err)
      if (err) process.exitCode = 1
      callback(err, tests)
    })
  }

  /**
   * Loads skippable suites from the validator-controlled cache.
   *
   * @param {object} testConfiguration test configuration identity
   * @param {Function} callback completion callback
   */
  getSkippableSuites (testConfiguration, callback) {
    super.getSkippableSuites(testConfiguration, (err, suites, correlationId, coverage) => {
      this._sink.writeInputResult('skippable_tests', err)
      if (err) process.exitCode = 1
      callback(err, suites, correlationId, coverage)
    })
  }

  /**
   * Loads managed tests from the validator-controlled cache.
   *
   * @param {object} testConfiguration test configuration identity
   * @param {Function} callback completion callback
   */
  getTestManagementTests (testConfiguration, callback) {
    super.getTestManagementTests(testConfiguration, (err, tests) => {
      this._sink.writeInputResult('test_management', err)
      if (err) process.exitCode = 1
      callback(err, tests)
    })
  }

  /**
   * Resolves the inherited git-upload gate without performing an upload.
   *
   * @returns {void}
   */
  sendGitMetadata () {
    this._resolveGit()
  }

  /**
   * Drops debugger logs in offline validation mode.
   *
   * @returns {void}
   */
  exportDiLogs () {}

  /**
   * Reports that code coverage is outside the offline validator's scope.
   *
   * @returns {boolean} always false
   */
  canReportCodeCoverage () {
    return false
  }

  /**
   * Reports that screenshot upload is unavailable.
   *
   * @returns {boolean} always false
   */
  canUploadTestScreenshots () {
    return false
  }

  /**
   * Rejects screenshot upload in offline validation mode.
   *
   * @param {object} options ignored upload options
   * @param {Function} callback completion callback
   */
  uploadTestScreenshot (options, callback) {
    callback(new Error('Screenshot upload is disabled during offline Test Optimization validation.'))
  }
}

module.exports = CiValidationExporter
