'use strict'

const fs = require('node:fs')
const { hostname: getHostname } = require('node:os')
const URL = require('url').URL

const { version: tracerVersion } = require('../../../../../package.json')
const { EMPTY_EFD_RETRY_POLICY, createEfdRetryPolicy } = require('../efd-retry-policy')
const { getLibraryConfiguration: getLibraryConfigurationRequest } = require('../requests/get-library-configuration')
const { getCachePath, withCache, writeToCache } = require('../requests/fs-cache')
const { getSkippableSuites: getSkippableSuitesRequest } = require('../intelligent-test-runner/get-skippable-suites')
const { getKnownTests: getKnownTestsRequest } = require('../early-flake-detection/get-known-tests')
const { getTestManagementTests: getTestManagementTestsRequest } =
  require('../test-management/get-test-management-tests')
const { writeSettingsToCache } = require('../test-optimization-cache')
const { CACHE_MISS, TestOptimizationHttpCache } = require('../test-optimization-http-cache')
const { MAX_RETRIES } = require('../test-optimization-http-cache-schema')
const { uploadCoverageReport: uploadCoverageReportRequest } = require('../requests/upload-coverage-report')
const { uploadTestScreenshot: uploadTestScreenshotRequest } = require('../requests/upload-test-screenshot')
const { parsers } = require('../../config/parsers')
const log = require('../../log')
const { getSegment } = require('../../util')
const BufferingExporter = require('../../exporters/common/buffering-exporter')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('../../plugins/util/tags')
const {
  createFinalFlushTimeoutError,
  FINAL_FLUSH_FALLBACK_DELAY,
  FINAL_FLUSH_TIMEOUT,
} = require('../final-flush')
const { sendGitMetadata: sendGitMetadataRequest } = require('./git/git_metadata')
const buildSettingsCacheKey = require('./settings-cache-key')

const hostname = getHostname()
const EMPTY_SETTINGS = Object.freeze({})
const SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const SETTINGS_BOOLEAN_FIELDS = Object.freeze([
  'isCodeCoverageEnabled',
  'isSuitesSkippingEnabled',
  'isItrEnabled',
  'requireGit',
  'isEarlyFlakeDetectionEnabled',
  'isFlakyTestRetriesEnabled',
  'isDiEnabled',
  'isKnownTestsEnabled',
  'isTestManagementEnabled',
  'isImpactedTestsEnabled',
  'isCoverageReportUploadEnabled',
])

/**
 * Test session identity sent with every request. Fields are optional because the CI provider,
 * the git repository or the runtime may not expose them.
 *
 * @typedef {{
 *   repositoryUrl?: string, sha?: string, branch?: string, tag?: string, testLevel?: string,
 *   osVersion?: string, osPlatform?: string, osArchitecture?: string,
 *   runtimeName?: string, runtimeVersion?: string, commitMessage?: string,
 *   pullRequestBaseSha?: string, commitHeadSha?: string, commitHeadMessage?: string,
 * }} TestConfiguration
 */

function getTestConfigurationTags (tags) {
  if (!tags) {
    return {}
  }
  return Object.keys(tags).reduce((acc, key) => {
    if (key.startsWith('test.configuration.')) {
      acc[getSegment(key, 'test.configuration.', 1)] = tags[key]
    }
    return acc
  }, {})
}

function isTestSessionEvent (span) {
  return span.type === 'test_session_end' || span.type === 'test_suite_end' || span.type === 'test_module_end'
}

function getIsTestSessionTrace (trace) {
  return trace.some(isTestSessionEvent)
}

/**
 * Checks whether a value is a non-negative safe integer.
 *
 * @param {unknown} value - Candidate integer.
 * @returns {value is number}
 */
function isNonNegativeSafeInteger (value) {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Checks whether a value is a retry count accepted by the settings parser.
 *
 * @param {unknown} value - Candidate retry count.
 * @returns {value is number}
 */
function isValidRetryCount (value) {
  return isNonNegativeSafeInteger(value) && value <= MAX_RETRIES
}

/**
 * Checks whether a cached EFD retry policy has the complete parsed shape.
 *
 * @param {unknown} retryPolicy - Candidate retry policy.
 * @returns {boolean}
 */
function isValidCachedEfdRetryPolicy (retryPolicy) {
  if (retryPolicy === null || typeof retryPolicy !== 'object' || Array.isArray(retryPolicy)) return false
  if (!isValidRetryCount(retryPolicy.schedulingRetryCount)) return false
  if (!Array.isArray(retryPolicy.durationRetryCounts) ||
    retryPolicy.durationRetryCounts.length !== EMPTY_EFD_RETRY_POLICY.durationRetryCounts.length) {
    return false
  }

  let schedulingRetryCount = 0
  for (let index = 0; index < EMPTY_EFD_RETRY_POLICY.durationRetryCounts.length; index++) {
    const durationRetryCount = retryPolicy.durationRetryCounts[index]
    if (durationRetryCount === null || typeof durationRetryCount !== 'object' ||
      Array.isArray(durationRetryCount) ||
      durationRetryCount.durationLimitMs !==
        EMPTY_EFD_RETRY_POLICY.durationRetryCounts[index].durationLimitMs ||
      !isValidRetryCount(durationRetryCount.retryCount)) {
      return false
    }
    if (durationRetryCount.retryCount > schedulingRetryCount) {
      schedulingRetryCount = durationRetryCount.retryCount
    }
  }
  return retryPolicy.schedulingRetryCount === schedulingRetryCount
}

/**
 * Checks whether a filesystem cache value has the complete shape produced by
 * parseLibraryConfigurationResponse.
 *
 * @param {unknown} settings - Cached settings value.
 * @returns {settings is Record<string, unknown>}
 */
function isValidCachedSettings (settings) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return false
  for (const field of SETTINGS_BOOLEAN_FIELDS) {
    if (typeof settings[field] !== 'boolean') return false
  }
  if (settings.isDiEnabled && !settings.isFlakyTestRetriesEnabled) return false
  if (settings.isEarlyFlakeDetectionEnabled && !settings.isKnownTestsEnabled) return false
  if (!isValidCachedEfdRetryPolicy(settings.earlyFlakeDetectionRetryPolicy)) return false
  if (!isNonNegativeSafeInteger(settings.earlyFlakeDetectionFaultyThreshold) ||
    settings.earlyFlakeDetectionFaultyThreshold > 100) {
    return false
  }
  return settings.testManagementAttemptToFixRetries === undefined ||
    isValidRetryCount(settings.testManagementAttemptToFixRetries)
}

const GIT_UPLOAD_TIMEOUT = 60_000 // 60 seconds
const CAN_USE_CI_VIS_PROTOCOL_TIMEOUT = GIT_UPLOAD_TIMEOUT
const MAX_COVERAGE_REPORT_FLAGS = 32

function appendLogTag (tags, key, value) {
  if (value !== undefined) {
    tags.push(`${key}:${value}`)
  }
}

function getLogTags (logMessage, { env, version }, gitRepositoryUrl, gitCommitSha) {
  const tags = []
  if (Array.isArray(logMessage.ddtags)) {
    for (const tag of logMessage.ddtags) {
      tags.push(tag)
    }
  } else if (logMessage.ddtags) {
    for (const tag of logMessage.ddtags.split(',')) {
      tags.push(tag)
    }
  }

  appendLogTag(tags, 'env', env)
  appendLogTag(tags, 'version', version)
  appendLogTag(tags, 'debugger_version', tracerVersion)
  appendLogTag(tags, 'host_name', hostname)
  appendLogTag(tags, GIT_COMMIT_SHA, gitCommitSha)
  appendLogTag(tags, GIT_REPOSITORY_URL, gitRepositoryUrl)

  return tags.join(',')
}

class CiVisibilityExporter extends BufferingExporter {
  #finalFlush
  #deferredTestSessionTraces = []
  #pendingScreenshotUploads = new Set()
  #screenshotFlushWaiters = new Set()
  #gitUploadTimeoutId

  constructor (config, options = {}) {
    super(config)
    this._timer = undefined
    this._coverageTimer = undefined
    this._logsTimer = undefined
    this._coverageBuffer = []
    this._testOptimizationHttpCache = options.testOptimizationHttpCache || new TestOptimizationHttpCache()
    this._isTestOptimizationCacheOnly = options.cacheOnly === true
    const coverageReportFlags = parsers.ARRAY(config?.testOptimization?.DD_CODE_COVERAGE_FLAGS)
    if (coverageReportFlags?.length > MAX_COVERAGE_REPORT_FLAGS) {
      log.warn(
        'Maximum of %d coverage report flags allowed, but %d flags were provided. Omitting coverage report flags.',
        MAX_COVERAGE_REPORT_FLAGS,
        coverageReportFlags.length
      )
    } else if (coverageReportFlags?.length) {
      this._coverageReportFlags = [...coverageReportFlags]
    }
    // The library can use new features like ITR and test suite level visibility
    // AKA CI Vis Protocol
    this._canUseCiVisProtocol = false

    this._isTestFailureScreenshotsEnabled =
      Boolean(config?.testOptimization?.DD_TEST_FAILURE_SCREENSHOTS_ENABLED)

    const canUseCiVisProtocolTimeoutId = setTimeout(() => {
      this._resolveCanUseCiVisProtocol(false)
    }, CAN_USE_CI_VIS_PROTOCOL_TIMEOUT)
    canUseCiVisProtocolTimeoutId.unref?.()

    this._gitUploadPromise = new Promise(resolve => {
      this._resolveGit = (err) => {
        clearTimeout(this.#gitUploadTimeoutId)
        this.#gitUploadTimeoutId = null
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

    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(() => this.flush(() => {}))
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
      isLineCoverageSupported: requestConfiguration.isLineCoverageSupported,
    })
    if (cachedSkippableSuites !== CACHE_MISS) {
      const { skippableSuites, correlationId, coverage } = cachedSkippableSuites
      return callback(null, skippableSuites, correlationId, coverage)
    }
    if (this._isTestOptimizationCacheOnly) {
      return callback(this._getCacheOnlyError('skippable tests'), [])
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
    if (this._isTestOptimizationCacheOnly) {
      return callback(this._getCacheOnlyError('known tests'))
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
    if (this._isTestOptimizationCacheOnly) {
      return callback(this._getCacheOnlyError('test management tests'))
    }
    getTestManagementTestsRequest(this.getRequestConfiguration(testConfiguration), callback)
  }

  /**
   * We can't request library configuration until we know whether we can use the
   * CI Visibility Protocol, hence the this._canUseCiVisProtocol promise.
   *
   * @param {TestConfiguration} testConfiguration
   * @param {(error: Error | null, libraryConfig?: Readonly<Record<string, unknown>>) => void} callback
   * @returns {void}
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
        return this._applyCachedSettings(cachedLibraryConfig, configuration, repositoryUrl, false, callback)
      }

      if (this._isTestOptimizationCacheOnly) {
        return callback(this._getCacheOnlyError('settings'), {})
      }

      // The settings request has a two-phase shape: when the backend returns
      // `require_git`, we upload git metadata and re-request settings. Only the
      // final (post-git-upload) configuration is cached, so the cross-process
      // filesystem cache never serves a pre-git-upload response that would skip
      // the git upload in other processes.
      //
      // The live-fetch and cache-hit paths resolve the git upload promise
      // differently, so they must not share a single apply path:
      //   - Live fetch: `sendGitMetadata` is started in `_fetchLibraryConfigurationFromBackend`
      //     and resolves `_gitUploadPromise` itself (with the upload result). We must NOT call
      //     `_resolveGit()` here, or we would race the in-flight upload and mask its error.
      //   - Filesystem cache hit: no upload was started in this process, so `_applyCachedSettings`
      //     resolves the git promise locally (starting an upload only if the cached config still
      //     requires git and we lack valid cached skippable suites).
      let liveFetchStarted = false
      const fsCacheKey = buildSettingsCacheKey(configuration)
      const fetchSettings = (activeCacheKey, done) => {
        liveFetchStarted = true
        this._fetchLibraryConfigurationFromBackend(configuration, repositoryUrl, activeCacheKey, done)
      }
      const applySettings = (err, libraryConfig) => {
        /**
         * **Important**: this._libraryConfig remains empty in testing frameworks
         * where the tests run in a subprocess, like Jest,
         * because `getLibraryConfiguration` is called only once in the main process.
         */
        if (err) {
          return callback(err, {})
        }
        if (liveFetchStarted) {
          // Live fetch: the git upload was already started and resolves
          // `_gitUploadPromise` itself. Do not call `_resolveGit()`.
          writeSettingsToCache(libraryConfig)
          this._libraryConfig = this.filterConfiguration(libraryConfig)
          return callback(null, this._libraryConfig)
        }
        // Filesystem cache hit: no git upload was started in this process.
        if (!isValidCachedSettings(libraryConfig)) {
          // A syntactically valid cache file with an invalid settings payload is corrupt.
          // Settings never writes such a value, so this is external corruption. Remove the
          // file and fall back to the backend so we never serve a garbage config that would
          // crash filterConfiguration or silently disable every feature.
          try {
            fs.unlinkSync(getCachePath(fsCacheKey))
          } catch (err) {
            if (err.code !== 'ENOENT') {
              return fetchSettings(null, applySettings)
            }
          }
          liveFetchStarted = false
          return withCache(fsCacheKey, fetchSettings, applySettings, SETTINGS_CACHE_TTL_MS)
        }
        this._applyCachedSettings(libraryConfig, configuration, repositoryUrl, true, callback)
      }
      withCache(fsCacheKey, fetchSettings, applySettings, SETTINGS_CACHE_TTL_MS)
    })
  }

  /**
   * Applies a resolved (cached or freshly fetched) library configuration: writes it to the
   * shared settings cache, filters it through local kill switches, and resolves the git
   * upload promise according to whether git metadata still needs to be uploaded.
   *
   * @param {Record<string, unknown>} settings - Resolved library configuration.
   * @param {object} configuration - Request configuration used to evaluate cached skippable suites.
   * @param {string} repositoryUrl - Repository URL for git metadata upload.
   * @param {boolean} isFilesystemCache - Whether settings came from the cross-process cache.
   * @param {Function} callback - Completion callback.
   * @returns {void}
   */
  _applyCachedSettings (settings, configuration, repositoryUrl, isFilesystemCache, callback) {
    writeSettingsToCache(settings)
    this._libraryConfig = this.filterConfiguration(settings)
    const canUseCachedSkippableSuites = !this.shouldRequestSkippableSuites() ||
      this._testOptimizationHttpCache.hasValidSkippableSuites({
        testLevel: configuration.testLevel,
        isCoverageReportUploadEnabled: configuration.isCoverageReportUploadEnabled,
      })
    if (!canUseCachedSkippableSuites && (this._libraryConfig.requireGit || isFilesystemCache)) {
      this.sendGitMetadata(repositoryUrl)
    } else {
      this._resolveGit()
    }
    callback(null, this._libraryConfig)
  }

  /**
   * Fetches library configuration from the backend, performing the two-phase
   * `require_git` re-request, and writes only the final configuration to the
   * filesystem cache when this process owns the cache lock.
   *
   * @param {object} configuration - Request configuration for the settings endpoint.
   * @param {string} repositoryUrl - Repository URL for git metadata upload.
   * @param {string|null} cacheKey - Filesystem cache key when this process owns the lock, null otherwise.
   * @param {Function} done - Completion callback.
   * @returns {void}
   */
  _fetchLibraryConfigurationFromBackend (configuration, repositoryUrl, cacheKey, done) {
    this.sendGitMetadata(repositoryUrl)
    getLibraryConfigurationRequest(configuration, (err, libraryConfig) => {
      // Mirror the original live path: keep the phase-1 config on `_libraryConfig` even
      // before the git upload resolves, so `shouldRequestSkippableSuites()` and the
      // skippable path's `_gitUploadPromise` await behave identically to the uncached flow.
      this._libraryConfig = this.filterConfiguration(libraryConfig)
      if (err) {
        return done(err, libraryConfig)
      }
      if (libraryConfig?.requireGit) {
        // If the backend requires git, wait for the upload to finish and request settings again
        this._gitUploadPromise.then(gitUploadError => {
          if (gitUploadError) {
            return done(gitUploadError, libraryConfig)
          }
          getLibraryConfigurationRequest(configuration, (finalErr, finalLibraryConfig) => {
            if (finalErr) {
              // Match the original live path: reset `_libraryConfig` from the final
              // (failed) response so stale phase-1 feature flags don't stay installed.
              // On error `finalLibraryConfig` is undefined, so this resolves to empty settings.
              this._libraryConfig = this.filterConfiguration(finalLibraryConfig)
              return done(finalErr, finalLibraryConfig)
            }
            writeToCache(cacheKey, finalLibraryConfig)
            done(null, finalLibraryConfig)
          })
        })
      } else {
        writeToCache(cacheKey, libraryConfig)
        done(null, libraryConfig)
      }
    })
  }

  /**
   * Returns the deterministic cache error for offline exporters.
   *
   * @param {string} input required cache input
   * @returns {Error} cache error
   */
  _getCacheOnlyError (input) {
    return this._testOptimizationHttpCache.getLastError?.() ||
      new Error(`Offline Test Optimization validation requires a valid ${input} cache fixture.`)
  }

  // Takes into account potential kill switches
  filterConfiguration (remoteConfiguration = EMPTY_SETTINGS) {
    const { testOptimization } = this._config
    const {
      DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: isEarlyFlakeDetectionAllowed,
      DD_CIVISIBILITY_FLAKY_RETRY_COUNT: flakyTestRetriesCount = 0,
      DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: isFlakyTestRetriesAllowed,
      DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: isImpactedTestsAllowed,
      DD_TEST_EARLY_FLAKE_DETECTION_RETRY_COUNT: earlyFlakeDetectionRetryCount,
      DD_TEST_FAILED_TEST_REPLAY_ENABLED: isFailedTestReplayAllowed,
      DD_TEST_MANAGEMENT_ATTEMPT_TO_FIX_RETRIES: configuredAttemptToFixRetries = 0,
      DD_TEST_MANAGEMENT_ENABLED: isTestManagementAllowed,
    } = testOptimization
    const earlyFlakeDetectionRetryPolicy = earlyFlakeDetectionRetryCount === undefined
      ? remoteConfiguration.earlyFlakeDetectionRetryPolicy ?? EMPTY_EFD_RETRY_POLICY
      : createEfdRetryPolicy({
        '5s': earlyFlakeDetectionRetryCount,
        '10s': earlyFlakeDetectionRetryCount,
        '30s': earlyFlakeDetectionRetryCount,
        '5m': earlyFlakeDetectionRetryCount,
      })
    const testManagementAttemptToFixRetries =
      remoteConfiguration.testManagementAttemptToFixRetries ?? configuredAttemptToFixRetries

    return Object.freeze({
      isCodeCoverageEnabled: remoteConfiguration.isCodeCoverageEnabled === true,
      isSuitesSkippingEnabled: remoteConfiguration.isSuitesSkippingEnabled === true,
      isItrEnabled: remoteConfiguration.isItrEnabled === true,
      requireGit: remoteConfiguration.requireGit === true,
      isEarlyFlakeDetectionEnabled:
        remoteConfiguration.isEarlyFlakeDetectionEnabled === true && isEarlyFlakeDetectionAllowed === true,
      earlyFlakeDetectionRetryPolicy,
      earlyFlakeDetectionFaultyThreshold: remoteConfiguration.earlyFlakeDetectionFaultyThreshold ?? 30,
      isFlakyTestRetriesEnabled:
        remoteConfiguration.isFlakyTestRetriesEnabled === true && isFlakyTestRetriesAllowed === true,
      flakyTestRetriesCount,
      isDiEnabled: remoteConfiguration.isDiEnabled === true && isFailedTestReplayAllowed === true,
      isKnownTestsEnabled: remoteConfiguration.isKnownTestsEnabled === true,
      isTestManagementEnabled:
        remoteConfiguration.isTestManagementEnabled === true && isTestManagementAllowed === true,
      testManagementAttemptToFixRetries,
      isImpactedTestsEnabled:
        remoteConfiguration.isImpactedTestsEnabled === true && isImpactedTestsAllowed === true,
      isCoverageReportUploadEnabled: remoteConfiguration.isCoverageReportUploadEnabled === true,
    })
  }

  sendGitMetadata (repositoryUrl) {
    if (!this._config.testOptimization.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED) {
      this._resolveGit()
      return
    }
    if (this.#gitUploadTimeoutId === null) return
    if (this.#gitUploadTimeoutId === undefined) {
      this.#gitUploadTimeoutId = setTimeout(() => {
        this._resolveGit(new Error('Timeout while uploading git metadata'))
      }, GIT_UPLOAD_TIMEOUT)
      this.#gitUploadTimeoutId.unref?.()
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
    this.#resetFinalFlush()
    this.#exportTrace(trace)
  }

  /**
   * Exports spans that are not retained for late updates to session, module, or suite events.
   *
   * @param {Array<object>} trace
   * @returns {void}
   */
  #exportTrace (trace) {
    // Until it's initialized, we just store the traces as is
    if (!this._isInitialized) {
      this._traceBuffer.push(trace)
      return
    }
    const isTestSessionTrace = getIsTestSessionTrace(trace)
    if (!this.canReportSessionTraces() && isTestSessionTrace) {
      const testTrace = []
      for (const span of trace) {
        if (!isTestSessionEvent(span)) testTrace.push(span)
      }
      if (testTrace.length > 0) this._export(testTrace)
      return
    }
    if (this._export(trace, undefined, undefined, isTestSessionTrace) === false && isTestSessionTrace) {
      this.#deferredTestSessionTraces.push(trace)
    }
  }

  /**
   * Retries session, module, and suite traces rejected by writer backpressure within the final deadline.
   *
   * @param {{ deadline?: number }} options final-flush options
   * @returns {void}
   */
  #exportDeferredTestSessionTraces (options) {
    if (!this._writer || !this.canReportSessionTraces()) return

    let retainedCount = 0

    for (const trace of this.#deferredTestSessionTraces) {
      if (this._writer.append(trace, options) === false) {
        this.#deferredTestSessionTraces[retainedCount++] = trace
      }
    }
    this.#deferredTestSessionTraces.length = retainedCount
  }

  exportCoverage (formattedCoverage) {
    this.#resetFinalFlush()

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
      ...logMessage,
      ddtags: getLogTags(logMessage, { env, version }, gitRepositoryUrl, gitCommitSha),
      level: 'error',
      service,
      hostname,
      dd: {
        ...logMessage.dd,
        service,
        env,
        version,
      },
      ddsource: 'dd_debugger',
    }
  }

  // DI logs
  exportDiLogs (testEnvironmentMetadata, logMessage) {
    // TODO: could we lose logs if it's not initialized?
    if (!this._config.testOptimization.DD_TEST_FAILED_TEST_REPLAY_ENABLED ||
      !this._isInitialized || !this._canForwardLogs) {
      return
    }

    this.#resetFinalFlush()
    this._export(
      this.formatLogMessage(testEnvironmentMetadata, logMessage),
      this._logsWriter,
      '_logsTimer'
    )
  }

  flush (done) {
    const isFinalFlush = typeof done === 'function'
    const onDone = done || (() => {})
    let finalFlush

    if (isFinalFlush && this.#finalFlush) {
      if (this.#finalFlush.completed) onDone(this.#finalFlush.error)
      else this.#finalFlush.callbacks.push(onDone)
      return
    }

    if (isFinalFlush && !this._isInitialized &&
      this._traceBuffer.length === 0 && this._coverageBuffer.length === 0 &&
      this.#deferredTestSessionTraces.length === 0 &&
      this.#pendingScreenshotUploads.size === 0) {
      onDone()
      return
    }

    if (isFinalFlush) {
      finalFlush = {
        callbacks: [onDone],
        completed: false,
        error: undefined,
      }
      this.#finalFlush = finalFlush
    }

    const deadline = isFinalFlush ? Date.now() + FINAL_FLUSH_TIMEOUT : undefined
    let hasCompleted = false
    let initializationTimeoutId

    const fallbackTimeoutId = isFinalFlush
      ? setTimeout(() => {
        complete(createFinalFlushTimeoutError())
      }, FINAL_FLUSH_TIMEOUT + FINAL_FLUSH_FALLBACK_DELAY)
      : undefined

    const complete = (error) => {
      if (hasCompleted) return
      hasCompleted = true
      clearTimeout(fallbackTimeoutId)
      clearTimeout(initializationTimeoutId)
      this.#screenshotFlushWaiters.delete(flushWriters)
      if (error) log.error('Error flushing Test Optimization data', error)
      if (!isFinalFlush) {
        onDone(error)
        return
      }

      finalFlush.completed = true
      finalFlush.error = error
      const callbacks = finalFlush.callbacks
      finalFlush.callbacks = []
      for (const callback of callbacks) {
        try {
          callback(error)
        } catch (callbackError) {
          log.error('Error completing Test Optimization flush callback', callbackError)
        }
      }
    }

    const flushWriters = () => {
      if (isFinalFlush && this.#pendingScreenshotUploads.size !== 0) {
        this.#screenshotFlushWaiters.add(flushWriters)
        return
      }

      const options = deadline === undefined ? undefined : { deadline }
      if (isFinalFlush) {
        this.#exportDeferredTestSessionTraces(options)
      }

      const writers = [
        this._writer,
        this._coverageWriter,
        this._logsWriter,
      ].filter(Boolean)

      let remaining = writers.length
      let flushError

      if (remaining === 0) {
        complete()
        return
      }

      const onFlushComplete = (error) => {
        flushError ||= error
        remaining -= 1
        if (remaining === 0) complete(flushError)
      }

      for (const writer of writers) writer.flush(onFlushComplete, options)
    }

    if (isFinalFlush && this._initializationRequest) {
      const initializationRequest = this._initializationRequest
      const { controller, options } = initializationRequest
      initializationRequest.finalFlush = finalFlush
      options.deadline = deadline
      initializationTimeoutId = setTimeout(() => {
        const error = createFinalFlushTimeoutError()
        if (initializationRequest.finalFlush === finalFlush) controller.abort(error)
        complete(error)
      }, Math.max(0, deadline - Date.now()))
    }

    if (!isFinalFlush) {
      if (this._isInitialized) flushWriters()
      else complete()
      return
    }

    if (this._isInitialized) {
      flushWriters()
      return
    }

    this._canUseCiVisProtocolPromise.then(() => {
      clearTimeout(initializationTimeoutId)
      if (!hasCompleted) flushWriters()
    })
  }

  /**
   * Allows later test activity to establish a new finalization boundary.
   *
   * @returns {void}
   */
  #resetFinalFlush () {
    this.#finalFlush = undefined
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
   * @param {bigint} options.fileDevice - Device containing the discovered report
   * @param {bigint} options.fileInode - Inode of the discovered report
   * @param {string} options.format - Format of the coverage report
   * @param {object} options.testEnvironmentMetadata - Test environment metadata containing git/CI tags
   * @param {(error: Error|null) => void} callback - Callback function
   */
  uploadCoverageReport ({ filePath, fileDevice, fileInode, format, testEnvironmentMetadata }, callback) {
    if (!this._codeCoverageReportUrl) {
      return callback(new Error('Coverage report upload URL not configured'))
    }

    uploadCoverageReportRequest({
      filePath,
      fileDevice,
      fileInode,
      format,
      flags: this._coverageReportFlags,
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
   * @param {AbortSignal} [options.signal] - Additional signal used to cancel the upload
   * @param {Function} callback - Callback function (err)
   */
  uploadTestScreenshot ({ filePath, traceId, idempotencyKey, capturedAtMs, signal }, callback) {
    if (!this._testScreenshotUploadUrl) {
      return callback(new Error('Test screenshot upload URL not configured'))
    }

    this.#resetFinalFlush()
    const controller = new AbortController()
    const deadline = Date.now() + FINAL_FLUSH_TIMEOUT
    let settled = false
    const complete = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', onAbort)

      try {
        callback(error)
      } finally {
        this.#pendingScreenshotUploads.delete(controller)
        if (this.#pendingScreenshotUploads.size === 0) {
          const waiters = [...this.#screenshotFlushWaiters]
          this.#screenshotFlushWaiters.clear()
          for (const waiter of waiters) queueMicrotask(waiter)
        }
      }
    }
    const onAbort = () => {
      const error = signal.reason || Object.assign(new Error('Test screenshot upload aborted'), { code: 'ABORT_ERR' })
      controller.abort(error)
      complete(error)
    }

    this.#pendingScreenshotUploads.add(controller)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeoutId = setTimeout(() => {
      const error = createFinalFlushTimeoutError()
      controller.abort(error)
      complete(error)
    }, FINAL_FLUSH_TIMEOUT)
    timeoutId.unref?.()

    if (signal?.aborted) {
      onAbort()
      return
    }

    uploadTestScreenshotRequest({
      filePath,
      traceId,
      idempotencyKey,
      capturedAtMs,
      url: this._testScreenshotUploadUrl,
      isEvpProxy: !!this._isUsingEvpProxy,
      evpProxyPrefix: this.evpProxyPrefix,
      deadline,
      signal: controller.signal,
    }, complete)
  }
}

module.exports = CiVisibilityExporter
