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
  isUnsupportedCIProvider: 'is_unsupported_ci'
}

// Transform tags dictionary to array of strings.
// If tag value is true, then only tag key is added to the array.
function formatMetricTags (tagsDictionary) {
  return Object.keys(tagsDictionary).reduce((acc, tagKey) => {
    const formattedTagKey = formattedTags[tagKey] || tagKey
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
const TELEMETRY_ITR_SKIPPABLE_TESTS = 'itr_skippable_tests.request'
const TELEMETRY_ITR_SKIPPABLE_TESTS_MS = 'itr_skippable_tests.request_ms'
const TELEMETRY_ITR_SKIPPABLE_TESTS_ERRORS = 'itr_skippable_tests.request_errors'
const TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_SUITES = 'itr_skippable_tests.response_suites'
const TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_TESTS = 'itr_skippable_tests.response_tests'
const TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_BYTES = 'itr_skippable_tests.response_bytes'

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
  TELEMETRY_ITR_SKIPPABLE_TESTS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_MS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_ERRORS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_SUITES,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_TESTS,
  TELEMETRY_ITR_SKIPPABLE_TESTS_RESPONSE_BYTES,
  getErrorTypeFromStatusCode
}
