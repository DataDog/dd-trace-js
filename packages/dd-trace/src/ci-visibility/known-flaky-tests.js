'use strict'

/**
 * An unavailable list leaves regular ATR enabled; a valid empty list excludes every test.
 * Parameters are deliberately ignored, matching the backend's flaky-test identity.
 *
 * @param {Record<string, Record<string, string[]>> | undefined} flakyTests
 * @param {string} testModule
 * @param {string | undefined} testSuite
 * @param {string | undefined} testName
 */
function isKnownFlakyTest (flakyTests, testModule, testSuite, testName) {
  if (flakyTests === undefined) return true
  if (testSuite === undefined || testName === undefined) return false
  const tests = flakyTests[testModule]?.[testSuite]
  return Array.isArray(tests) && tests.includes(testName)
}

module.exports = { isKnownFlakyTest }
