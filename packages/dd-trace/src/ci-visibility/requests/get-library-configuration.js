'use strict'

const getConfig = require('../../config')
const id = require('../../id')
const log = require('../../log')
const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_GIT_REQUESTS_SETTINGS,
  TELEMETRY_GIT_REQUESTS_SETTINGS_MS,
  TELEMETRY_GIT_REQUESTS_SETTINGS_ERRORS,
  TELEMETRY_GIT_REQUESTS_SETTINGS_RESPONSE,
} = require('../telemetry')
const { writeSettingsToCache } = require('../test-optimization-cache')
const { MAX_RETRIES, validateSettingsResponse } = require('../test-optimization-http-cache-schema')
const request = require('./request')

const DEFAULT_EARLY_FLAKE_DETECTION_NUM_RETRIES = 2
const DEFAULT_EARLY_FLAKE_DETECTION_SLOW_TEST_RETRIES = Object.freeze({
  '5s': 10,
  '10s': 5,
  '30s': 3,
  '5m': 2,
})
const DEFAULT_EARLY_FLAKE_DETECTION_ERROR_THRESHOLD = 30
const EARLY_FLAKE_DETECTION_RETRY_BUCKETS = Object.keys(DEFAULT_EARLY_FLAKE_DETECTION_SLOW_TEST_RETRIES)

/**
 * @typedef {object} EarlyFlakeDetectionSettings
 * @property {boolean} enabled
 * @property {number} numRetries
 * @property {Readonly<Record<string, number>>} slowTestRetries
 * @property {number} faultyThreshold
 */

/**
 * @typedef {object} TestManagementSettings
 * @property {boolean} enabled
 * @property {number|undefined} attemptToFixRetries
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNonNegativeInteger (value) {
  return Number.isInteger(value) && value >= 0
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isRetryCount (value) {
  return isNonNegativeInteger(value) && value <= MAX_RETRIES
}

/**
 * @param {unknown} value
 * @returns {Readonly<Record<string, number>>|undefined}
 */
function parseSlowTestRetries (value) {
  if (!isRecord(value)) return

  const slowTestRetries = {}
  for (const bucket of EARLY_FLAKE_DETECTION_RETRY_BUCKETS) {
    if (!Object.hasOwn(value, bucket)) continue

    const retries = value[bucket]
    if (!isRetryCount(retries)) return
    slowTestRetries[bucket] = retries
  }
  return Object.freeze(slowTestRetries)
}

/**
 * @param {unknown} value
 * @param {boolean} isKnownTestsEnabled
 * @returns {EarlyFlakeDetectionSettings}
 */
function parseEarlyFlakeDetectionSettings (value, isKnownTestsEnabled) {
  if (!isRecord(value) || value.enabled !== true) {
    return {
      enabled: false,
      numRetries: DEFAULT_EARLY_FLAKE_DETECTION_NUM_RETRIES,
      slowTestRetries: DEFAULT_EARLY_FLAKE_DETECTION_SLOW_TEST_RETRIES,
      faultyThreshold: DEFAULT_EARLY_FLAKE_DETECTION_ERROR_THRESHOLD,
    }
  }

  let isValid = true
  let numRetries = DEFAULT_EARLY_FLAKE_DETECTION_NUM_RETRIES
  let slowTestRetries = DEFAULT_EARLY_FLAKE_DETECTION_SLOW_TEST_RETRIES
  if (Object.hasOwn(value, 'slow_test_retries')) {
    const parsedSlowTestRetries = parseSlowTestRetries(value.slow_test_retries)
    if (parsedSlowTestRetries) {
      slowTestRetries = parsedSlowTestRetries
      numRetries = parsedSlowTestRetries['5s'] ?? DEFAULT_EARLY_FLAKE_DETECTION_NUM_RETRIES
    } else {
      isValid = false
    }
  }

  let faultyThreshold = DEFAULT_EARLY_FLAKE_DETECTION_ERROR_THRESHOLD
  if (Object.hasOwn(value, 'faulty_session_threshold')) {
    if (isNonNegativeInteger(value.faulty_session_threshold) && value.faulty_session_threshold <= 100) {
      faultyThreshold = value.faulty_session_threshold
    } else {
      isValid = false
    }
  }

  return {
    enabled: isKnownTestsEnabled && isValid,
    numRetries,
    slowTestRetries,
    faultyThreshold,
  }
}

/**
 * @param {unknown} value
 * @returns {TestManagementSettings}
 */
function parseTestManagementSettings (value) {
  if (!isRecord(value) || value.enabled !== true) {
    return {
      enabled: false,
      attemptToFixRetries: undefined,
    }
  }

  const attemptToFixRetries = value.attempt_to_fix_retries
  if (attemptToFixRetries !== undefined && !isRetryCount(attemptToFixRetries)) {
    return {
      enabled: false,
      attemptToFixRetries: undefined,
    }
  }

  return {
    enabled: true,
    attemptToFixRetries,
  }
}

function parseJsonResponse (rawJson) {
  return typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson
}

function parseLibraryConfigurationResponse (rawJson, config = getConfig(), options = {}) {
  const parsedResponse = parseJsonResponse(rawJson)
  if (options.validateRequiredFields) {
    validateSettingsResponse(parsedResponse, options)
  }
  const parsedAttributes = parsedResponse?.data?.attributes ?? parsedResponse
  if (!isRecord(parsedAttributes)) {
    throw new TypeError('Invalid settings response: attributes must be an object')
  }
  const attributes = parsedAttributes
  const isKnownTestsEnabled = attributes.known_tests_enabled === true
  const isFlakyTestRetriesEnabled = attributes.flaky_test_retries_enabled === true
  const earlyFlakeDetection = parseEarlyFlakeDetectionSettings(
    attributes.early_flake_detection,
    isKnownTestsEnabled
  )
  const testManagement = parseTestManagementSettings(attributes.test_management)

  const settings = {
    isCodeCoverageEnabled: attributes.code_coverage === true,
    isSuitesSkippingEnabled: attributes.tests_skipping === true,
    isItrEnabled: attributes.itr_enabled === true,
    requireGit: attributes.require_git === true,
    isEarlyFlakeDetectionEnabled: earlyFlakeDetection.enabled,
    earlyFlakeDetectionNumRetries: earlyFlakeDetection.numRetries,
    earlyFlakeDetectionSlowTestRetries: earlyFlakeDetection.slowTestRetries,
    earlyFlakeDetectionFaultyThreshold: earlyFlakeDetection.faultyThreshold,
    isFlakyTestRetriesEnabled,
    isDiEnabled: attributes.di_enabled === true && isFlakyTestRetriesEnabled,
    isKnownTestsEnabled,
    isTestManagementEnabled: testManagement.enabled,
    testManagementAttemptToFixRetries: testManagement.attemptToFixRetries,
    isImpactedTestsEnabled: attributes.impacted_tests_enabled === true,
    isCoverageReportUploadEnabled: attributes.coverage_report_upload_enabled === true,
  }

  log.debug('Remote settings: %j', settings)

  if (config.testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE) {
    settings.isCodeCoverageEnabled = true
    log.debug('Dangerously set code coverage to true')
  }
  if (config.testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_TEST_SKIPPING) {
    settings.isSuitesSkippingEnabled = true
    log.debug('Dangerously set test skipping to true')
  }
  if (
    settings.isCoverageReportUploadEnabled &&
    !config.testOptimization.DD_CIVISIBILITY_CODE_COVERAGE_REPORT_UPLOAD_ENABLED
  ) {
    settings.isCoverageReportUploadEnabled = false
    log.debug('Code coverage report upload was disabled by the environment variable')
  }

  return Object.freeze(settings)
}

function getLibraryConfiguration ({
  url,
  isEvpProxy,
  evpProxyPrefix,
  env,
  service,
  repositoryUrl,
  sha,
  osVersion,
  osPlatform,
  osArchitecture,
  runtimeName,
  runtimeVersion,
  branch,
  testLevel = 'suite',
  custom,
  tag,
}, done) {
  const config = getConfig()
  const options = {
    path: '/api/v2/libraries/tests/services/setting',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    url,
    timeout: 20_000,
  }

  if (isEvpProxy) {
    options.path = `${evpProxyPrefix}/api/v2/libraries/tests/services/setting`
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
  } else {
    if (!config.DD_API_KEY) {
      return done(new Error('Request to settings endpoint was not done because Datadog API key is not defined.'))
    }
    options.headers['dd-api-key'] = config.DD_API_KEY
  }

  const data = JSON.stringify({
    data: {
      id: id().toString(10),
      type: 'ci_app_test_service_libraries_settings',
      attributes: {
        test_level: testLevel,
        configurations: {
          'os.platform': osPlatform,
          'os.version': osVersion,
          'os.architecture': osArchitecture,
          'runtime.name': runtimeName,
          'runtime.version': runtimeVersion,
          custom,
        },
        service,
        env,
        repository_url: repositoryUrl,
        sha,
        branch: branch || tag,
      },
    },
  })

  incrementCountMetric(TELEMETRY_GIT_REQUESTS_SETTINGS)

  const startTime = Date.now()
  request(data, options, (err, res, statusCode) => {
    distributionMetric(TELEMETRY_GIT_REQUESTS_SETTINGS_MS, {}, Date.now() - startTime)
    if (err) {
      incrementCountMetric(TELEMETRY_GIT_REQUESTS_SETTINGS_ERRORS, { statusCode })
      done(err)
    } else {
      try {
        const settings = parseLibraryConfigurationResponse(res, config)

        incrementCountMetric(TELEMETRY_GIT_REQUESTS_SETTINGS_RESPONSE, settings)

        writeSettingsToCache(settings)

        done(null, settings)
      } catch (err) {
        done(err)
      }
    }
  })
}

module.exports = { getLibraryConfiguration, parseLibraryConfigurationResponse }
