'use strict'

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}${String.raw`\[[0-?]*[ -/]*[@-~]`}`, 'g')

/**
 * Extracts the final test count from common JavaScript test-runner summaries.
 *
 * @param {string} framework test framework name
 * @param {string} stdout captured stdout
 * @param {string} stderr captured stderr
 * @returns {number|null} observed count when a supported summary was found
 */
function getObservedTestCount (framework, stdout = '', stderr = '') {
  const output = `${stdout}\n${stderr}`.replaceAll(ANSI_PATTERN, '')
  if (framework === 'jest') return getJestObservedTestCount(output)
  if (framework === 'vitest') return getVitestObservedTestCount(output)

  const totalPatterns = framework === 'node:test'
    ? [/^# tests\s+(\d+)\s*$/gim]
    : framework === 'cucumber'
      ? [/\b(\d+)\s+scenarios?\b/gi]
      : []

  for (const pattern of totalPatterns) {
    const count = getLastMatchCount(output, pattern)
    if (count !== null) return count
  }

  if (framework === 'mocha') {
    return sumLastMatchCounts(output, [
      /\b(\d+)\s+passing\b/gi,
      /\b(\d+)\s+failing\b/gi,
      /\b(\d+)\s+pending\b/gi,
    ])
  }

  return getLastMatchCount(output, /\b(\d+)\s+tests?\s+(?:passed|failed)\b/gi)
}

/**
 * Counts Jest tests that actually ran, excluding tests skipped by a name filter.
 *
 * @param {string} output test output without ANSI codes
 * @returns {number|null} executed test count
 */
function getJestObservedTestCount (output) {
  return getExecutedTestSummaryCount(output, /^\s*Tests:\s+/)
}

/**
 * Counts Vitest tests that actually ran, excluding tests skipped by a name filter.
 *
 * @param {string} output test output without ANSI codes
 * @returns {number|null} executed test count
 */
function getVitestObservedTestCount (output) {
  return getExecutedTestSummaryCount(output, /^\s*Tests\s+/)
}

/**
 * Extracts passed and failed counts from the final matching runner summary.
 *
 * @param {string} output test output without ANSI codes
 * @param {RegExp} summaryPattern test-summary line pattern
 * @returns {number|null} executed test count
 */
function getExecutedTestSummaryCount (output, summaryPattern) {
  const summaryLines = output.split(/\r?\n/).filter(line => summaryPattern.test(line))
  const summary = summaryLines.at(-1)
  if (!summary) return null

  const observed = sumLastMatchCounts(summary, [
    /\b(\d+)\s+passed\b/gi,
    /\b(\d+)\s+failed\b/gi,
  ])
  if (observed !== null) return observed
  return /\b\d+\s+skipped\b/i.test(summary) ? 0 : null
}

/**
 * Returns the count captured by the last match of one summary pattern.
 *
 * @param {string} output test output
 * @param {RegExp} pattern global summary pattern
 * @returns {number|null} final captured count
 */
function getLastMatchCount (output, pattern) {
  let count = null
  for (const match of output.matchAll(pattern)) count = Number(match[1])
  return count
}

/**
 * Sums the final counts from multiple summary categories.
 *
 * @param {string} output test output
 * @param {RegExp[]} patterns global summary patterns
 * @returns {number|null} summed count when any category was found
 */
function sumLastMatchCounts (output, patterns) {
  let found = false
  let count = 0
  for (const pattern of patterns) {
    const value = getLastMatchCount(output, pattern)
    if (value === null) continue
    found = true
    count += value
  }
  return found ? count : null
}

module.exports = { getObservedTestCount }
