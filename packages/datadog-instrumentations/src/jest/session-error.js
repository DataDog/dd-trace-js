'use strict'

const { stripVTControlCharacters } = require('node:util')

const { MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION: MAX_LENGTH } =
  require('../../../dd-trace/src/encode/tags-processors')

/**
 * @typedef {{ name?: unknown, type?: unknown, message?: unknown, stack?: unknown }} SuiteError
 * @typedef {object} JestResults
 * @property {number} [numFailedTestSuites]
 * @property {number} [numFailedTests]
 * @property {number} [numPassedTests]
 * @property {{ testExecError?: SuiteError }[]} [testResults]
 */

/**
 * Includes suite execution errors when no tests ran, without mutating Jest's results.
 *
 * @param {JestResults} results
 * @param {boolean} hasExecutedTests
 * @returns {Error}
 */
function getSessionError (results = {}, hasExecutedTests = results.numPassedTests > 0 || results.numFailedTests > 0) {
  const { numFailedTestSuites = 0, numFailedTests = 0 } = results
  const summary = `Failed test suites: ${numFailedTestSuites}. Failed tests: ${numFailedTests}`
  const error = new Error(summary)
  if (hasExecutedTests || !results.testResults) return error

  const groups = new Map()
  for (const { testExecError } of results.testResults) {
    if (!testExecError) continue
    const name = sanitizeErrorField(testExecError.name) || sanitizeErrorField(testExecError.type) || 'Error'
    const message = sanitizeErrorField(testExecError.message)
    const stack = sanitizeErrorField(testExecError.stack)
    if (!message && !stack) continue
    const key = JSON.stringify([name, message, stack])
    const group = groups.get(key)
    if (group) {
      group.count++
    } else {
      groups.set(key, { name, message, stack, count: 1 })
    }
  }
  if (!groups.size) return error

  // Worker completion order must not determine which errors survive the size limit.
  const errors = [...groups.keys()].sort().map(key => groups.get(key))
  const messages = errors.map(({ name, message, count }) =>
    `${name}: ${message} (${count} suite${count === 1 ? '' : 's'})`)
  error.message = fitErrors(summary, messages)
  const name = errors.length === 1 ? errors[0].name : 'Error'
  error.name = name.length > MAX_LENGTH ? `${truncate(name, MAX_LENGTH - 3)}...` : name
  error.stack = fitErrors('', errors.map(({ name, message, stack, count }) => {
    const originalStack = stack || `${name}: ${message}`
    return errors.length === 1 ? originalStack : `Affected suites: ${count}\n${originalStack}`
  }))
  return error
}

/** @param {unknown} value */
function sanitizeErrorField (value) {
  return typeof value === 'string' ? stripVTControlCharacters(value) : ''
}

/**
 * @param {string} value
 * @param {number} length
 */
function truncate (value, length) {
  let truncated = value.slice(0, length)
  // Do not split a UTF-16 surrogate pair at the field boundary.
  if (/[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1)
  return truncated
}

/**
 * Reserves a truncation notice instead of relying on the encoder's blind truncation.
 *
 * @param {string} summary
 * @param {string[]} details
 */
function fitErrors (summary, details) {
  const totalLength = details.reduce((length, detail) => length + detail.length + 2, summary.length) - (summary ? 0 : 2)
  if (totalLength <= MAX_LENGTH) return [summary, ...details].filter(Boolean).join('\n\n')

  let output = summary
  for (let i = 0; i < details.length; i++) {
    const remaining = details.length - i - 1
    const notice = '\n\n[Error details truncated. ' +
      (remaining ? `${remaining} additional distinct errors omitted. ` : '') +
      'See suite events for full details.]'
    const separator = output ? '\n\n' : ''
    const available = MAX_LENGTH - output.length - separator.length - notice.length
    if (details[i].length + (remaining ? 2 : 0) > available) {
      return output + separator + truncate(details[i], available) + notice
    }
    output += separator + details[i]
  }
  return output
}

module.exports = { getSessionError }
