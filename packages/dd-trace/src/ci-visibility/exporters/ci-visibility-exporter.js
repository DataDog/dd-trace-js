'use strict'

const URL = require('url').URL

const { getLibraryConfiguration: getLibraryConfigurationRequest } = require('../requests/get-library-configuration')
const { getSkippableSuites: getSkippableSuitesRequest } = require('../intelligent-test-runner/get-skippable-suites')
const { getKnownTests: getKnownTestsRequest } = require('../early-flake-detection/get-known-tests')
const { getTestManagementTests: getTestManagementTestsRequest } =
  require('../test-management/get-test-management-tests')
const { writeSettingsToCache } = require('../test-optimization-cache')
const { CACHE_MISS, TestOptimizationHttpCache } = require('../test-optimization-http-cache')
const { uploadCoverageReport: uploadCoverageReportRequest } = require('../requests/upload-coverage-report')
const { uploadTestScreenshot: uploadTestScreenshotRequest } = require('../requests/upload-test-screenshot')
const log = require('../../log')
const BufferingExporter = require('../../exporters/common/buffering-exporter')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('../../plugins/util/tags')
const { sendGitMetadata: sendGitMetadataRequest } = require('./git/git_metadata')

function getTestConfigurationTags (tags) {
  if (!tags) {
    return {}
  }
  return Object.keys(tags).reduce((acc, key) => {
    if (key.startsWith('test.configuration.')) {
      const [, configKey] = key.split('test.configuration.')
      acc[configKey] = tags[key]
    }
    return acc
  }, {})
}

function getIsTestSessionTrace (trace) {
  return trace.some(span =>
    span.type === 'test_session_end' || span.type === 'test_suite_end' || span.type === 'test_module_end'
  )
}

const GIT_UPLOAD_TIMEOUT = 60_000 // 60 seconds
const CAN_USE_CI_VIS_PROTOCOL_TIMEOUT = GIT_UPLOAD_TIMEOUT

class CiVisibilityExporter extends BufferingExporter {
  constructor (config) {
    super(config)
    this._timer = undefined
    this._coverageTimer = undefined
    this._logsTimer = undefined
    this._coverageBuffer = []
    this._testOptimizationHttpCache = new TestOptimizationHttpCache()
    // The library can use new features like ITR and test suite level visibility
    // AKA CI Vis Protocol
    this._canUseCiVisProtocol = false

    this._isTestFailureScreenshotsEnabled =
      Boolean(config?.testOptimization?.DD_TEST_FAILURE_SCREENSHOTS_ENABLED)

    const gitUploadTimeoutId = setTimeout(() => {
      this._resolveGit(new Error('Timeout while uploading git metadata'))
    }, GIT_UPLOAD_TIMEOUT)
    gitUploadTimeoutId.unref?.()

    const canUseCiVisProtocolTimeoutId = setTimeout(() => {
      this._resolveCanUseCiVisProtocol(false)
    }, CAN_USE_CI_VIS_PROTOCOL_TIMEOUT)
    canUseCiVisProtocolTimeoutId.unref?.()

    this._gitUploadPromise = new Promise(resolve => {
      this._resolveGit = (err) => {
        clearTimeout(gitUploadTimeoutId)
        resolve(err)
      }
    })

    this._canUseCiVisProtocolPromise = new Promise(resolve => {
      this._resolveCanUseCiVisProtocol = (canUseCiVisProtocol) => {
        clearTimeout(canUseCiVisProtocolTimeoutId)
        this._canUseCiVisProtocol = canUseCiVisProtocol
        resolve(canUseCiVisProtocol)
      }
    })

    const flush = () => {
      if (this._writer) {
        this._writer.flush()
      }
      if (this._coverageWriter) {
        this._coverageWriter.flush()
      }
      if (this._logsWriter) {
        this._logsWriter.flush()
      }
    }
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(flush.bind(this))
  }

  shouldRequestSkippableSuites () {
    return !!(this._config.testOptimization.DD_CIVISIBILITY_ITR_ENABLED &&
      this._canUseCiVisProtocol &&
      this._libraryConfig?.isSuitesSkippingEnabled)
  }

  shouldRequestKnownTests () {
    return !!(
      this._canUseCiVisProtocol &&
      this._libraryConfig?.isKnownTestsEnabled
    )
  }

  shouldRequestTestManagementTests () {
    return !!(
      this._canUseCiVisProtocol &&
      this._config.testOptimization.DD_TEST_MANAGEMENT_ENABLED &&
      this._libraryConfig?.isTestManagementEnabled
    )
  }

  canReportSessionTraces () {
    return this._canUseCiVisProtocol
  }

  canReportCodeCoverage () {
    return this._canUseCiVisProtocol
  }

  getRequestConfiguration (testConfiguration) {
    return {
      url: this._getApiUrl(),
      env: this._config.env,
      service: this._config.service,
      isEvpProxy: !!this._isUsingEvpProxy,
      isGzipCompatible: this._isGzipCompatible,
      evpProxyPrefix: this.evpProxyPrefix,
      custom: getTestConfigurationTags(this._config.tags),
      ...testConfiguration,
    }
  }

  // We can't call the skippable endpoint until git upload has finished,
  // hence the this._gitUploadPromise.then
  getSkippableSuites (testConfiguration, callback) {
    if (!this.shouldRequestSkippableSuites()) {
      return callback(null, [])
    }
    const requestConfiguration = this.getRequestConfiguration(testConfiguration)
    const cachedSkippableSuites = this._testOptimizationHttpCache.readSkippableSuites({
      testLevel: requestConfiguration.testLevel,
      isCoverageReportUploadEnabled: requestConfiguration.isCoverageReportUploadEnabled,
    })
    if (cachedSkippableSuites !== CACHE_MISS) {
      const { skippableSuites, correlationId, coverage } = cachedSkippableSuites
      return callback(null, skippableSuites, correlationId, coverage)
    }

    this._gitUploadPromise.then(gitUploadError => {
      if (gitUploadError) {
        return callback(gitUploadError, [])
      }
      getSkippableSuitesRequest(requestConfiguration, callback)
    })
  }

  getKnownTests (testConfiguration, callback) {
    if (!this.shouldRequestKnownTests()) {
      return callback(null)
    }
    const cachedKnownTests = this._testOptimizationHttpCache.readKnownTests()
    if (cachedKnownTests !== CACHE_MISS) {
      return callback(null, cachedKnownTests)
    }
    getKnownTestsRequest(this.getRequestConfiguration(testConfiguration), callback)
  }

  getTestManagementTests (testConfiguration, callback) {
    if (!this.shouldRequestTestManagementTests()) {
      return callback(null)
    }
    const cachedTestManagementTests = this._testOptimizationHttpCache.readTestManagementTests()
    if (cachedTestManagementTests !== CACHE_MISS) {
      return callback(null, cachedTestManagementTests)
    }
    getTestManagementTestsRequest(this.getRequestConfiguration(testConfiguration), callback)
  }

  /**
   * We can't request library configuration until we know whether we can use the
   * CI Visibility Protocol, hence the this._canUseCiVisProtocol promise.
   */
  getLibraryConfiguration (testConfiguration, callback) {
    const { repositoryUrl } = testConfiguration
    this._canUseCiVisProtocolPromise.then((canUseCiVisProtocol) => {
      if (!canUseCiVisProtocol) {
        return callback(null, {})
      }
      const configuration = this.getRequestConfiguration(testConfiguration)
      const cachedLibraryConfig = this._testOptimizationHttpCache.readSettings()
      if (cachedLibraryConfig !== CACHE_MISS) {
        log.debug('Test Optimization HTTP cache settings found, skipping settings request')
        writeSettingsToCache(cachedLibraryConfig)
        this._libraryConfig = this.filterConfiguration(cachedLibraryConfig)
        const canUseCachedSkippableSuites = !this.shouldRequestSkippableSuites() ||
          this._testOptimizationHttpCache.hasValidSkippableSuites({
            testLevel: configuration.testLevel,
            isCoverageReportUploadEnabled: configuration.isCoverageReportUploadEnabled,
          })
        if (this._libraryConfig.requireGit && !canUseCachedSkippableSuites) {
          this.sendGitMetadata(repositoryUrl)
        } else {
          this._resolveGit()
        }
        return callback(null, this._libraryConfig)
      }

      this.sendGitMetadata(repositoryUrl)
      getLibraryConfigurationRequest(configuration, (err, libraryConfig) => {
        /**
         * **Important**: this._libraryConfig remains empty in testing frameworks
         * where the tests run in a subprocess, like Jest,
         * because `getLibraryConfiguration` is called only once in the main process.
         */
        this._libraryConfig = this.filterConfiguration(libraryConfig)

        if (err) {
          callback(err, {})
        } else if (libraryConfig?.requireGit) {
          // If the backend requires git, we'll wait for the upload to finish and request settings again
          this._gitUploadPromise.then(gitUploadError => {
            if (gitUploadError) {
              return callback(gitUploadError, {})
            }
            getLibraryConfigurationRequest(configuration, (err, finalLibraryConfig) => {
              this._libraryConfig = this.filterConfiguration(finalLibraryConfig)
              callback(err, this._libraryConfig)
            })
          })
        } else {
          callback(null, this._libraryConfig)
        }
      })
    })
  }

  // Takes into account potential kill switches
  filterConfiguration (remoteConfiguration) {
    if (!remoteConfiguration) {
      return {}
    }
    const {
      isCodeCoverageEnabled,
      isSuitesSkippingEnabled,
      isItrEnabled,
      requireGit,
      isEarlyFlakeDetectionEnabled,
      earlyFlakeDetectionNumRetries,
      earlyFlakeDetectionSlowTestRetries,
      earlyFlakeDetectionFaultyThreshold,
      isFlakyTestRetriesEnabled,
      isDiEnabled,
      isKnownTestsEnabled,
      isTestManagementEnabled,
      testManagementAttemptToFixRetries,
      isImpactedTestsEnabled,
      isCoverageReportUploadEnabled,
    } = remoteConfiguration
    const { testOptimization } = this._config
    return {
      isCodeCoverageEnabled,
      isSuitesSkippingEnabled,
      isItrEnabled,
      requireGit,
      isEarlyFlakeDetectionEnabled:
        isEarlyFlakeDetectionEnabled && testOptimization.DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED,
      earlyFlakeDetectionNumRetries,
      earlyFlakeDetectionSlowTestRetries,
      earlyFlakeDetectionFaultyThreshold,
      isFlakyTestRetriesEnabled: isFlakyTestRetriesEnabled && testOptimization.DD_CIVISIBILITY_FLAKY_RETRY_ENABLED,
      flakyTestRetriesCount: testOptimization.DD_CIVISIBILITY_FLAKY_RETRY_COUNT,
      isDiEnabled: isDiEnabled && testOptimization.DD_TEST_FAILED_TEST_REPLAY_ENABLED,
      isKnownTestsEnabled,
      isTestManagementEnabled: isTestManagementEnabled && testOptimization.DD_TEST_MANAGEMENT_ENABLED,
      testManagementAttemptToFixRetries:
        testManagementAttemptToFixRetries ?? testOptimization.DD_TEST_MANAGEMENT_ATTEMPT_TO_FIX_RETRIES,
      isImpactedTestsEnabled:
        isImpactedTestsEnabled && testOptimization.DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED,
      isCoverageReportUploadEnabled,
    }
  }

  sendGitMetadata (repositoryUrl) {
    if (!this._config.testOptimization.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED) {
      return
    }
    this._canUseCiVisProtocolPromise.then((canUseCiVisProtocol) => {
      if (!canUseCiVisProtocol) {
        return
      }
      sendGitMetadataRequest(
        this._getApiUrl(),
        { isEvpProxy: !!this._isUsingEvpProxy, evpProxyPrefix: this.evpProxyPrefix },
        repositoryUrl,
        (err) => {
          if (err) {
            log.error('Error uploading git metadata: %s', err.message)
          } else {
            log.debug('Successfully uploaded git metadata')
          }
          this._resolveGit(err)
        }
      )
    })
  }

  export (trace) {
    // Until it's initialized, we just store the traces as is
    if (!this._isInitialized) {
      this._traceBuffer.push(trace)
      return
    }
    if (!this.canReportSessionTraces() && getIsTestSessionTrace(trace)) {
      return
    }
    this._export(trace)
  }

  exportCoverage (formattedCoverage) {
    // Until it's initialized, we just store the coverages as is
    if (!this._isInitialized) {
      this._coverageBuffer.push(formattedCoverage)
      return
    }
    if (!this.canReportCodeCoverage()) {
      return
    }

    this._export(formattedCoverage, this._coverageWriter, '_coverageTimer')
  }

  formatLogMessage (testEnvironmentMetadata, logMessage) {
    const {
      [GIT_REPOSITORY_URL]: gitRepositoryUrl,
      [GIT_COMMIT_SHA]: gitCommitSha,
    } = testEnvironmentMetadata

    const { service, env, version } = this._config

    return {
      ddtags: [
        ...(logMessage.ddtags || []),
        `${GIT_REPOSITORY_URL}:${gitRepositoryUrl}`,
        `${GIT_COMMIT_SHA}:${gitCommitSha}`,
      ].join(','),
      level: 'error',
      service,
      dd: {
        ...(logMessage.dd || []),
        service,
        env,
        version,
      },
      ddsource: 'dd_debugger',
      ...logMessage,
    }
  }

  // DI logs
  exportDiLogs (testEnvironmentMetadata, logMessage) {
    // TODO: could we lose logs if it's not initialized?
    if (!this._config.testOptimization.DD_TEST_FAILED_TEST_REPLAY_ENABLED ||
      !this._isInitialized || !this._canForwardLogs) {
      return
    }

    this._export(
      this.formatLogMessage(testEnvironmentMetadata, logMessage),
      this._logsWriter,
      '_logsTimer'
    )
  }

  flush (done = () => {}) {
    if (!this._isInitialized) {
      return done()
    }

    // TODO: safe to do them at once? Or do we want to do them one by one?
    const writers = [
      this._writer,
      this._coverageWriter,
      this._logsWriter,
    ].filter(Boolean)

    let remaining = writers.length

    if (remaining === 0) {
      return done()
    }

    const onFlushComplete = () => {
      remaining -= 1
      if (remaining === 0) {
        done()
      }
    }

    for (const writer of writers) writer.flush(onFlushComplete)
  }

  exportUncodedCoverages () {
    for (const oldCoveragePayload of this._coverageBuffer) {
      this.exportCoverage(oldCoveragePayload)
    }
    this._coverageBuffer = []
  }

  _setUrl (url, coverageUrl = url) {
    try {
      url = new URL(url)
      coverageUrl = new URL(coverageUrl)
      this._url = url
      this._coverageUrl = coverageUrl
      this._writer.setUrl(url)
      this._coverageWriter.setUrl(coverageUrl)
    } catch (e) {
      log.error('Error setting CI exporter url', e)
    }
  }

  _getApiUrl () {
    return this._url
  }

  // By the time addMetadataTags is called, the agent info request might not have finished
  addMetadataTags (tags) {
    if (this._writer?.addMetadataTags) {
      this._writer.addMetadataTags(tags)
    } else {
      this._canUseCiVisProtocolPromise.then(() => {
        if (this._writer?.addMetadataTags) {
          this._writer.addMetadataTags(tags)
        }
      })
    }
  }

  /**
   * Uploads a single coverage report to the CI intake.
   * @param {object} options - Upload options
   * @param {string} options.filePath - Path to the coverage report file
   * @param {string} options.format - Format of the coverage report
   * @param {object} options.testEnvironmentMetadata - Test environment metadata containing git/CI tags
   * @param {Function} callback - Callback function (err)
   */
  uploadCoverageReport ({ filePath, format, testEnvironmentMetadata }, callback) {
    if (!this._codeCoverageReportUrl) {
      return callback(new Error('Coverage report upload URL not configured'))
    }

    uploadCoverageReportRequest({
      filePath,
      format,
      testEnvironmentMetadata,
      url: this._codeCoverageReportUrl,
      isEvpProxy: !!this._isUsingEvpProxy,
      evpProxyPrefix: this.evpProxyPrefix,
    }, callback)
  }

  /**
   * Returns whether the exporter can upload test failure screenshots.
   *
   * @returns {boolean}
   */
  canUploadTestScreenshots () {
    return Boolean(this._testScreenshotUploadUrl) && this._isTestFailureScreenshotsEnabled
  }

  /**
   * Uploads a single test screenshot to the Test Optimization media intake.
   *
   * @param {object} options - Upload options
   * @param {string} options.filePath - Path to the screenshot file
   * @param {string} options.traceId - Test trace id used as the screenshot key
   * @param {string} options.idempotencyKey - Stable per-artifact key, reused on retry
   * @param {number} options.capturedAtMs - Capture time in epoch milliseconds
   * @param {Function} callback - Callback function (err)
   */
  uploadTestScreenshot ({ filePath, traceId, idempotencyKey, capturedAtMs }, callback) {
    if (!this._testScreenshotUploadUrl) {
      return callback(new Error('Test screenshot upload URL not configured'))
    }

    uploadTestScreenshotRequest({
      filePath,
      traceId,
      idempotencyKey,
      capturedAtMs,
      url: this._testScreenshotUploadUrl,
    }, callback)
  }
}

module.exports = CiVisibilityExporter
