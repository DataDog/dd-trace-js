'use strict'

const REQUIRED_SETTINGS_KEYS = [
  'code_coverage',
  'tests_skipping',
  'itr_enabled',
  'require_git',
  'early_flake_detection',
  'flaky_test_retries_enabled',
  'di_enabled',
  'known_tests_enabled',
  'test_management',
  'impacted_tests_enabled',
  'coverage_report_upload_enabled',
]
const SETTINGS_BOOLEAN_KEYS = [
  'code_coverage',
  'tests_skipping',
  'itr_enabled',
  'require_git',
  'flaky_test_retries_enabled',
  'di_enabled',
  'known_tests_enabled',
  'impacted_tests_enabled',
  'coverage_report_upload_enabled',
]
const EARLY_FLAKE_DETECTION_KEYS = ['enabled', 'faulty_session_threshold', 'slow_test_retries']
const TEST_MANAGEMENT_KEYS = ['attempt_to_fix_retries', 'enabled']
const RETRY_THRESHOLD_PATTERN = /^\d+(?:ms|s|m|h)$/
const MAX_VALIDATION_MODULES = 1000
const MAX_VALIDATION_SUITES = 10_000
const MAX_VALIDATION_TESTS = 100_000
const MAX_VALIDATION_RETRIES = 100
const MAX_VALIDATION_STRING_BYTES = 4096

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertObject (value, message) {
  if (!isObject(value)) {
    throw new Error(message)
  }
}

function assertHasKeys (value, keys, endpoint) {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`Invalid ${endpoint} response: missing ${key}`)
    }
  }
}

function getAttributes (response, endpoint) {
  const attributes = response?.data?.attributes
  assertObject(attributes, `Invalid ${endpoint} response: attributes must be an object`)
  return attributes
}

function validateSettingsResponse (response, options = {}) {
  const attributes = response?.data?.attributes ?? response
  assertObject(attributes, 'Invalid settings response: attributes must be an object')
  assertHasKeys(attributes, REQUIRED_SETTINGS_KEYS, 'settings')
  assertObject(attributes.early_flake_detection, 'Invalid settings response: early_flake_detection must be an object')
  assertObject(attributes.test_management, 'Invalid settings response: test_management must be an object')
  assertHasKeys(attributes.early_flake_detection, ['enabled'], 'settings early_flake_detection')
  assertHasKeys(attributes.test_management, ['enabled'], 'settings test_management')
  if (!options.validationMode) return

  assertOnlyKeys(attributes, REQUIRED_SETTINGS_KEYS, 'settings')
  assertOnlyKeys(attributes.early_flake_detection, EARLY_FLAKE_DETECTION_KEYS, 'settings early_flake_detection')
  assertOnlyKeys(attributes.test_management, TEST_MANAGEMENT_KEYS, 'settings test_management')
  assertBooleanFields(attributes, SETTINGS_BOOLEAN_KEYS, 'settings')
  assertBooleanFields(attributes.early_flake_detection, ['enabled'], 'settings early_flake_detection')
  assertBooleanFields(attributes.test_management, ['enabled'], 'settings test_management')
  assertOptionalBoundedNumber(
    attributes.early_flake_detection.faulty_session_threshold,
    'settings early_flake_detection faulty_session_threshold'
  )
  assertRetryMap(attributes.early_flake_detection.slow_test_retries)
  assertOptionalBoundedNumber(
    attributes.test_management.attempt_to_fix_retries,
    'settings test_management attempt_to_fix_retries',
    { integer: true }
  )
}

function validateKnownTestsResponse (response, options = {}) {
  const attributes = getAttributes(response, 'known tests')
  assertHasKeys(attributes, ['tests'], 'known tests')

  const { tests } = attributes
  if (tests === null) return
  assertObject(tests, 'Invalid known tests response: tests must be an object or null')

  let suiteCount = 0
  let testCount = 0
  const modules = Object.entries(tests)
  if (options.validationMode && modules.length > MAX_VALIDATION_MODULES) {
    throw new Error('Invalid known tests response: too many modules')
  }
  for (const [moduleName, suites] of modules) {
    if (options.validationMode) assertValidationString(moduleName, 'known tests module')
    assertObject(suites, 'Invalid known tests response: module suites must be objects')
    for (const [suiteName, testNames] of Object.entries(suites)) {
      suiteCount++
      if (options.validationMode) {
        if (suiteCount > MAX_VALIDATION_SUITES) throw new Error('Invalid known tests response: too many suites')
        assertValidationString(suiteName, 'known tests suite')
      }
      if (!Array.isArray(testNames)) {
        throw new TypeError('Invalid known tests response: suite tests must be arrays')
      }
      for (const testName of testNames) {
        testCount++
        if (typeof testName !== 'string') {
          throw new TypeError('Invalid known tests response: test names must be strings')
        }
        if (options.validationMode) {
          if (testCount > MAX_VALIDATION_TESTS) throw new Error('Invalid known tests response: too many tests')
          assertValidationString(testName, 'known test name')
        }
      }
    }
  }
}

function validateSkippableTestsResponse (response, options = {}) {
  assertObject(response, 'Invalid skippable tests response: response must be an object')
  if (!Array.isArray(response.data)) {
    throw new TypeError('Invalid skippable tests response: data must be an array')
  }
  if (options.validationMode && response.data.length > MAX_VALIDATION_TESTS) {
    throw new Error('Invalid skippable tests response: too many items')
  }
  if (response.meta !== undefined) {
    assertObject(response.meta, 'Invalid skippable tests response: meta must be an object')
  }
  if (response.meta?.coverage !== undefined) {
    assertObject(response.meta.coverage, 'Invalid skippable tests response: meta.coverage must be an object')
  }
  if (response.meta?.correlation_id !== undefined && typeof response.meta.correlation_id !== 'string') {
    throw new Error('Invalid skippable tests response: meta.correlation_id must be a string')
  }

  for (const item of response.data) {
    assertObject(item, 'Invalid skippable tests response: data entries must be objects')
    if (typeof item.type !== 'string') {
      throw new TypeError('Invalid skippable tests response: data entry type must be a string')
    }
    if (options.validationMode) assertValidationString(item.type, 'skippable test type')
    assertObject(item.attributes, 'Invalid skippable tests response: data entry attributes must be an object')
    if ((item.type === 'suite' || item.type === 'test') && typeof item.attributes.suite !== 'string') {
      throw new Error('Invalid skippable tests response: data entry suite must be a string')
    }
    if (options.validationMode && item.attributes.suite !== undefined) {
      assertValidationString(item.attributes.suite, 'skippable test suite')
    }
    if (item.type === 'test' && typeof item.attributes.name !== 'string') {
      throw new Error('Invalid skippable tests response: data entry name must be a string')
    }
    if (options.validationMode && item.attributes.name !== undefined) {
      assertValidationString(item.attributes.name, 'skippable test name')
    }
  }
}

function validateTestManagementTestsResponse (response, options = {}) {
  const attributes = getAttributes(response, 'test management tests')
  assertHasKeys(attributes, ['modules'], 'test management tests')
  assertObject(attributes.modules, 'Invalid test management tests response: modules must be an object')

  let suiteCount = 0
  let testCount = 0
  const modules = Object.entries(attributes.modules)
  if (options.validationMode && modules.length > MAX_VALIDATION_MODULES) {
    throw new Error('Invalid test management tests response: too many modules')
  }
  for (const [moduleName, testModule] of modules) {
    if (options.validationMode) assertValidationString(moduleName, 'test management module')
    assertObject(testModule, 'Invalid test management tests response: modules entries must be objects')
    assertObject(testModule.suites, 'Invalid test management tests response: module suites must be objects')
    for (const [suiteName, suite] of Object.entries(testModule.suites)) {
      suiteCount++
      if (options.validationMode) {
        if (suiteCount > MAX_VALIDATION_SUITES) {
          throw new Error('Invalid test management tests response: too many suites')
        }
        assertValidationString(suiteName, 'test management suite')
      }
      assertObject(suite, 'Invalid test management tests response: suites entries must be objects')
      assertObject(suite.tests, 'Invalid test management tests response: suite tests must be objects')
      for (const [testName, test] of Object.entries(suite.tests)) {
        testCount++
        if (options.validationMode) {
          if (testCount > MAX_VALIDATION_TESTS) {
            throw new Error('Invalid test management tests response: too many tests')
          }
          assertValidationString(testName, 'test management test')
        }
        assertObject(test, 'Invalid test management tests response: tests entries must be objects')
        assertObject(test.properties, 'Invalid test management tests response: test properties must be objects')
      }
    }
  }
}

function assertBooleanFields (object, keys, endpoint) {
  for (const key of keys) {
    if (typeof object[key] !== 'boolean') {
      throw new TypeError(`Invalid ${endpoint} response: ${key} must be a boolean`)
    }
  }
}

function assertOptionalBoundedNumber (value, endpoint, { integer = false } = {}) {
  if (value === undefined) return
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) ||
    value < 0 || value > MAX_VALIDATION_RETRIES) {
    throw new TypeError(`Invalid ${endpoint}: value must be between 0 and ${MAX_VALIDATION_RETRIES}`)
  }
}

function assertRetryMap (retries) {
  if (retries === undefined) return
  assertObject(retries, 'Invalid settings response: early_flake_detection slow_test_retries must be an object')
  for (const [threshold, count] of Object.entries(retries)) {
    assertValidationString(threshold, 'early flake detection retry threshold')
    if (!RETRY_THRESHOLD_PATTERN.test(threshold)) {
      throw new TypeError('Invalid early flake detection retry threshold: expected a duration such as 5s')
    }
    assertOptionalBoundedNumber(count, `early flake detection retry count ${threshold}`, { integer: true })
  }
}

function assertOnlyKeys (object, keys, endpoint) {
  const allowed = new Set(keys)
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid ${endpoint} response: unexpected ${key}`)
    }
  }
}

function assertValidationString (value, field) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_VALIDATION_STRING_BYTES) {
    throw new TypeError(`Invalid ${field}: value must be a bounded string`)
  }
}

module.exports = {
  validateKnownTestsResponse,
  validateSettingsResponse,
  validateSkippableTestsResponse,
  validateTestManagementTestsResponse,
}
