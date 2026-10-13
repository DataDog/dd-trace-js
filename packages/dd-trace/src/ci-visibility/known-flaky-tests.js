'use strict'

// Configuration lists are immutable; weak keys release indexes when a run's lists are discarded.
/** @type {WeakMap<string[], Set<string>>} */
const namesBySuite = new WeakMap()

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
  if (!Array.isArray(tests)) return false
  let names = namesBySuite.get(tests)
  if (!names) {
    names = new Set(tests)
    namesBySuite.set(tests, names)
  }
  return names.has(testName)
}

module.exports = { isKnownFlakyTest }
