'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const TestOptimizationHttpCache = require('../../test-optimization-http-cache').TestOptimizationHttpCache
const CiVisibilityExporter = require('../ci-visibility-exporter')
const CiValidationCoverageWriter = require('./coverage-writer')
const { CiValidationSink } = require('./sink')
const CiValidationWriter = require('./writer')

const VALIDATION_MANIFEST_ENV = '_DD_TEST_OPTIMIZATION_VALIDATION_MANIFEST_FILE'
const VALIDATION_OUTPUT_ENV = '_DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_FILE'

class CiValidationExporter extends CiVisibilityExporter {
  /**
   * Creates an immediately available cache-only Test Optimization exporter.
   *
  * @param {object} config tracer configuration
  */
  constructor (config) {
    const validationManifestPath = process.env[VALIDATION_MANIFEST_ENV]
    const validationOutputPath = process.env[VALIDATION_OUTPUT_ENV]
    if (!validationManifestPath) {
      throw new Error('Offline Test Optimization validation requires an explicit private manifest path.')
    }
    if (!validationOutputPath) {
      throw new Error('Offline Test Optimization validation requires an explicit private output path.')
    }
    const cache = new TestOptimizationHttpCache({
      validationManifestPath,
    })
    super(config, { cacheOnly: true, testOptimizationHttpCache: cache })

    this._sink = new CiValidationSink(validationOutputPath)
    this._writer = new CiValidationWriter({ sink: this._sink, tags: config.tags })
    this._coverageWriter = new CiValidationCoverageWriter(this._sink)
    this._isInitialized = true
    this._isGzipCompatible = false
    this._resolveCanUseCiVisProtocol(true)
    this._resolveGit()
    this.exportUncodedTraces()
    this.exportUncodedCoverages()

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
   * Rejects coverage-report upload in offline validation mode.
   *
   * @param {object} options ignored upload options
   * @param {Function} callback completion callback
   */
  uploadCoverageReport (options, callback) {
    callback(new Error('Coverage-report upload is disabled during offline Test Optimization validation.'))
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
