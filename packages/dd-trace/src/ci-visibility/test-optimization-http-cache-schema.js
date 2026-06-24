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

function validateSettingsResponse (response) {
  const attributes = response?.data?.attributes ?? response
  assertObject(attributes, 'Invalid settings response: attributes must be an object')
  assertHasKeys(attributes, REQUIRED_SETTINGS_KEYS, 'settings')
  assertObject(attributes.early_flake_detection, 'Invalid settings response: early_flake_detection must be an object')
  assertObject(attributes.test_management, 'Invalid settings response: test_management must be an object')
  assertHasKeys(attributes.early_flake_detection, ['enabled'], 'settings early_flake_detection')
  assertHasKeys(attributes.test_management, ['enabled'], 'settings test_management')
}

function validateKnownTestsResponse (response) {
  const attributes = getAttributes(response, 'known tests')
  assertHasKeys(attributes, ['tests'], 'known tests')

  const { tests } = attributes
  if (tests === null) return
  assertObject(tests, 'Invalid known tests response: tests must be an object or null')

  for (const suites of Object.values(tests)) {
    assertObject(suites, 'Invalid known tests response: module suites must be objects')
    for (const testNames of Object.values(suites)) {
      if (!Array.isArray(testNames)) {
        throw new Error('Invalid known tests response: suite tests must be arrays')
      }
      for (const testName of testNames) {
        if (typeof testName !== 'string') {
          throw new Error('Invalid known tests response: test names must be strings')
        }
      }
    }
  }
}

function validateSkippableTestsResponse (response) {
  assertObject(response, 'Invalid skippable tests response: response must be an object')
  if (!Array.isArray(response.data)) {
    throw new Error('Invalid skippable tests response: data must be an array')
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
      throw new Error('Invalid skippable tests response: data entry type must be a string')
    }
    assertObject(item.attributes, 'Invalid skippable tests response: data entry attributes must be an object')
    if ((item.type === 'suite' || item.type === 'test') && typeof item.attributes.suite !== 'string') {
      throw new Error('Invalid skippable tests response: data entry suite must be a string')
    }
    if (item.type === 'test' && typeof item.attributes.name !== 'string') {
      throw new Error('Invalid skippable tests response: data entry name must be a string')
    }
  }
}

function validateTestManagementTestsResponse (response) {
  const attributes = getAttributes(response, 'test management tests')
  assertHasKeys(attributes, ['modules'], 'test management tests')
  assertObject(attributes.modules, 'Invalid test management tests response: modules must be an object')

  for (const testModule of Object.values(attributes.modules)) {
    assertObject(testModule, 'Invalid test management tests response: modules entries must be objects')
    assertObject(testModule.suites, 'Invalid test management tests response: module suites must be objects')
    for (const suite of Object.values(testModule.suites)) {
      assertObject(suite, 'Invalid test management tests response: suites entries must be objects')
      assertObject(suite.tests, 'Invalid test management tests response: suite tests must be objects')
      for (const test of Object.values(suite.tests)) {
        assertObject(test, 'Invalid test management tests response: tests entries must be objects')
        assertObject(test.properties, 'Invalid test management tests response: test properties must be objects')
      }
    }
  }
}

module.exports = {
  validateKnownTestsResponse,
  validateSettingsResponse,
  validateSkippableTestsResponse,
  validateTestManagementTestsResponse,
}
