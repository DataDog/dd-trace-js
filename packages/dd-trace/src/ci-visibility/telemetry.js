'use strict'

const telemetryMetrics = require('../telemetry/metrics')

const ciVisibilityMetrics = telemetryMetrics.manager.namespace('civisibility')

const formattedTags = {
  testLevel: 'event_type',
  testFramework: 'test_framework',
  errorType: 'error_type',
  exitCode: 'exit_code',
  isCodeCoverageEnabled: 'coverage_enabled',
  isSuitesSkippingEnabled: 'itrskip_enabled',
  hasCodeOwners: 'has_code_owners',
  isUnsupportedCIProvider: 'is_unsupported_ci',
  isNew: 'is_new',
  isRum: 'is_rum',
  browserDriver: 'browser_driver',
  autoInjected: 'auto_injected',
  isQuarantined: 'is_quarantined',
  isDisabled: 'is_disabled',
  isTestManagementEnabled: 'test_management_enabled',
  isItrEnabled: 'itr_enabled',
  isEarlyFlakeDetectionEnabled: 'early_flake_detection_enabled',
  isFlakyTestRetriesEnabled: 'flaky_test_retries_enabled',
  isKnownTestsEnabled: 'known_tests_enabled',
  isImpactedTestsEnabled: 'impacted_tests_enabled',
  hasFailedTestReplay: 'has_failed_test_replay',
  isFailedTestReplayEnabled: 'is_failed_test_replay_enabled',
  // isDiEnabled is specifically for the settings endpoint telemetry
  isDiEnabled: 'failed_test_replay_enabled',
  requireGit: 'require_git',
  isModified: 'is_modified',
  isRetry: 'is_retry',
  retryReason: 'retry_reason',
}

// Transform tags dictionary to array of strings.
// If tag value is true, then only tag key is added to the array.
/**
 * @param {Record<string, unknown>} tagsDictionary
 * @returns {string[]}
 */
function formatMetricTags (tagsDictionary) {
  return Object.keys(tagsDictionary).reduce((/** @type {string[]} */ acc, tagKey) => {
    if (tagKey === 'statusCode') {
      const statusCode = tagsDictionary[tagKey]
      if (isStatusCode400(statusCode)) {
        acc.push(`status_code:${statusCode}`)
      }
      acc.push(`error_type:${getErrorTypeFromStatusCode(statusCode)}`)
      return acc
    }
    const formattedTagKey = /** @type {string} */(formattedTags[tagKey] || tagKey)
    if (tagsDictionary[tagKey] === true) {
      acc.push(formattedTagKey)
    } else if (tagsDictionary[tagKey] !== undefined && tagsDictionary[tagKey] !== null) {
      acc.push(`${formattedTagKey}:${tagsDictionary[tagKey]}`)
    }
    return acc
  }, [])
}

function incrementCountMetric (name, tags = {}, value = 1) {
  ciVisibilityMetrics.count(name, formatMetricTags(tags)).inc(value)
}

function distributionMetric (name, tags, measure) {
  ciVisibilityMetrics.distribution(name, formatMetricTags(tags)).track(measure)
}

// CI Visibility telemetry events
const TELEMETRY_TEST_SESSION = 'test_session'
const TELEMETRY_EVENT_CREATED = 'event_created'
const TELEMETRY_EVENT_FINISHED = 'event_finished'
const TELEMETRY_CODE_COVERAGE_STARTED = 'code_coverage_started'
const TELEMETRY_CODE_COVERAGE_FINISHED = 'code_coverage_finished'
const TELEMETRY_ITR_SKIPPED = 'itr_skipped'
const TELEMETRY_ITR_UNSKIPPABLE = 'itr_unskippable'
const TELEMETRY_ITR_FORCED_TO_RUN = 'itr_forced_run'
const TELEMETRY_CODE_COVERAGE_EMPTY = 'code_coverage.is_empty'
const TELEMETRY_CODE_COVERAGE_NUM_FILES = 'code_coverage.files'
const TELEMETRY_EVENTS_ENQUEUED_FOR_SERIALIZATION = 'events_enqueued_for_serialization'
const TELEMETRY_ENDPOINT_PAYLOAD_SERIALIZATION_MS = 'endpoint_payload.events_serialization_ms'
const TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS = 'endpoint_payload.requests'
const TELEMETRY_ENDPOINT_PAYLOAD_BYTES = 'endpoint_payload.bytes'
const TELEMETRY_ENDPOINT_PAYLOAD_EVENTS_COUNT = 'endpoint_payload.events_count'
const TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_MS = 'endpoint_payload.requests_ms'
const TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS = 'endpoint_payload.requests_errors'
const TELEMETRY_ENDPOINT_PAYLOAD_DROPPED = 'endpoint_payload.dropped'
const TELEMETRY_GIT_COMMAND = 'git.command'
const TELEMETRY_GIT_COMMAND_MS = 'git.command_ms'
const TELEMETRY_GIT_COMMAND_ERRORS = 'git.command_errors'
const TELEMETRY_GIT_REQUESTS_SEARCH_COMMITS = 'git_requests.search_commits'
const TELEMETRY_GIT_REQUESTS_SEARCH_COMMITS_MS = 'git_requests.search_commits_ms'
const TELEMETRY_GIT_REQUESTS_SEARCH_COMMITS_ERRORS = 'git_requests.search_commits_errors'
const TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES = 'git_requests.objects_pack'
const TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_MS = 'git_requests.objects_pack_ms'
const TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_ERRORS = 'git_requests.objects_pack_errors'
const TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_NUM = 'git_requests.objects_pack_files'
const TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_BYTES = 'git_requests.objects_pack_bytes'
const TELEMETRY_GIT_REQUESTS_SETTINGS = 'git_requests.settings'
const TELEMETRY_GIT_REQUESTS_SETTINGS_MS = 'git_requests.settings_ms'
const TELEMETRY_GIT_REQUESTS_SETTINGS_ERRORS = 'git_requests.settings_errors'
const TELEMETRY_GIT_REQUESTS_SETTINGS_RESPONSE = 'git_requests.settings_response'
const TELEMETRY_GIT_SHA_MATCH = 'git.commit_sha_match'
const TELEMETRY_GIT_COMMIT_SHA_DISCREPANCY = 'git.commit_sha_discrepancy'
const TELEMETRY_ITR_SKIPPABLE_TESTS = 'itr_skippable_tests.request'
const TELEMETRY_ITR_SKIPPABLE_TESTS_MS = 'itr_skippable_tests.request_ms'
const TELEMETRY_ITR_SKIPPABLE_TESTS_ERRORS = 'itr_skippable_tests.request_errors'
const TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_SUITES = 'itr_skippable_tests.response_suites'
const TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_TESTS = 'itr_skippable_tests.response_tests'
const TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_BYTES = 'itr_skippable_tests.response_bytes'
// early flake detection
const TELEMETRY_KNOWN_TESTS = 'early_flake_detection.request'
const TELEMETRY_KNOWN_TESTS_MS = 'early_flake_detection.request_ms'
const TELEMETRY_KNOWN_TESTS_ERRORS = 'early_flake_detection.request_errors'
const TELEMETRY_KNOWN_TESTS_RESPONSE_TESTS = 'early_flake_detection.response_tests'
const TELEMETRY_KNOWN_TESTS_RESPONSE_BYTES = 'early_flake_detection.response_bytes'
// coverage upload
const TELEMETRY_COVERAGE_UPLOAD = 'coverage_upload.request'
const TELEMETRY_COVERAGE_UPLOAD_MS = 'coverage_upload.request_ms'
const TELEMETRY_COVERAGE_UPLOAD_ERRORS = 'coverage_upload.request_errors'
const TELEMETRY_COVERAGE_UPLOAD_BYTES = 'coverage_upload.request_bytes'
// test management
const TELEMETRY_TEST_MANAGEMENT_TESTS = 'test_management_tests.request'
const TELEMETRY_TEST_MANAGEMENT_TESTS_MS = 'test_management_tests.request_ms'
const TELEMETRY_TEST_MANAGEMENT_TESTS_ERRORS = 'test_management_tests.request_errors'
const TELEMETRY_TEST_MANAGEMENT_TESTS_RESPONSE_TESTS = 'test_management_tests.response_tests'
const TELEMETRY_TEST_MANAGEMENT_TESTS_RESPONSE_BYTES = 'test_management_tests.response_bytes'

function isStatusCode400 (statusCode) {
  return statusCode >= 400 && statusCode < 500
}

function getErrorTypeFromStatusCode (statusCode) {
  if (statusCode >= 400 && statusCode < 500) {
    return 'status_code_4xx_response'
  }
  if (statusCode >= 500) {
    return 'status_code_5xx_response'
  }
  return 'network'
}

module.exports = {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_TEST_SESSION,
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED,
  TELEMETRY_CODE_COVERAGE_STARTED,
  TELEMETRY_CODE_COVERAGE_FINISHED,
  TELEMETRY_ITR_SKIPPED,
  TELEMETRY_ITR_UNSKIPPABLE,
  TELEMETRY_ITR_FORCED_TO_RUN,
  TELEMETRY_CODE_COVERAGE_EMPTY,
  TELEMETRY_CODE_COVERAGE_NUM_FILES,
  TELEMETRY_EVENTS_ENQUEUED_FOR_SERIALIZATION,
  TELEMETRY_ENDPOINT_PAYLOAD_SERIALIZATION_MS,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS,
  TELEMETRY_ENDPOINT_PAYLOAD_BYTES,
  TELEMETRY_ENDPOINT_PAYLOAD_EVENTS_COUNT,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_MS,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS,
  TELEMETRY_ENDPOINT_PAYLOAD_DROPPED,
  TELEMETRY_GIT_COMMAND,
  TELEMETRY_GIT_COMMAND_MS,
  TELEMETRY_GIT_COMMAND_ERRORS,
  TELEMETRY_GIT_REQUESTS_SEARCH_COMMITS,
  TELEMETRY_GIT_REQUESTS_SEARCH_COMMITS_MS,
  TELEMETRY_GIT_REQUESTS_SEARCH_COMMITS_ERRORS,
  TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_NUM,
  TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_BYTES,
  TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES,
  TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_MS,
  TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_ERRORS,
  TELEMETRY_GIT_REQUESTS_SETTINGS,
  TELEMETRY_GIT_REQUESTS_SETTINGS_MS,
  TELEMETRY_GIT_REQUESTS_SETTINGS_ERRORS,
  TELEMETRY_GIT_REQUESTS_SETTINGS_RESPONSE,
  TELEMETRY_GIT_SHA_MATCH,
  TELEMETRY_GIT_COMMIT_SHA_DISCREPANCY,
  TELEMETRY_ITR_SKIPPABLE_TESTS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_MS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_ERRORS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_SUITES,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_TESTS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_BYTES,
  TELEMETRY_KNOWN_TESTS,
  TELEMETRY_KNOWN_TESTS_MS,
  TELEMETRY_KNOWN_TESTS_ERRORS,
  TELEMETRY_KNOWN_TESTS_RESPONSE_TESTS,
  TELEMETRY_KNOWN_TESTS_RESPONSE_BYTES,
  TELEMETRY_COVERAGE_UPLOAD,
  TELEMETRY_COVERAGE_UPLOAD_MS,
  TELEMETRY_COVERAGE_UPLOAD_ERRORS,
  TELEMETRY_COVERAGE_UPLOAD_BYTES,
  TELEMETRY_TEST_MANAGEMENT_TESTS,
  TELEMETRY_TEST_MANAGEMENT_TESTS_MS,
  TELEMETRY_TEST_MANAGEMENT_TESTS_ERRORS,
  TELEMETRY_TEST_MANAGEMENT_TESTS_RESPONSE_TESTS,
  TELEMETRY_TEST_MANAGEMENT_TESTS_RESPONSE_BYTES,
}
