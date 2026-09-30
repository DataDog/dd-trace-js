'use strict'

const { stripVTControlCharacters } = require('node:util')

const { MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION: MAX_LENGTH } =
  require('../../../dd-trace/src/encode/tags-processors')
const log = require('../../../dd-trace/src/log')

/**
 * @typedef {{ name?: unknown, type?: unknown, message?: unknown, stack?: unknown }} SuiteError
 * @typedef {{ value: string, truncated: boolean }} ErrorField
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
    let name, message, stack
    try {
      name = sanitizeErrorField(testExecError.name)
      if (!name.value && !name.truncated) name = sanitizeErrorField(testExecError.type)
      if (!name.value) name.value = 'Error'
      message = sanitizeErrorField(testExecError.message)
      stack = sanitizeErrorField(testExecError.stack)
    } catch {
      log.debug('Skipping unreadable Jest suite execution error in the test session summary')
      continue
    }
    if (!message.value && !message.truncated && !stack.value && !stack.truncated) continue
    const truncated = name.truncated || message.truncated || stack.truncated
    // Matching prefixes cannot establish equality when the unseen tails may differ.
    const key = JSON.stringify([name, message, stack]) + (truncated ? `:${groups.size}` : '')
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
  const messages = errors.map(({ name, message, count }) => ({
    value: `${name.value}: ${message.value} (${count} suite${count === 1 ? '' : 's'})`,
    truncated: name.truncated || message.truncated,
  }))
  error.message = fitErrors(summary, messages)
  const name = errors.length === 1 ? errors[0].name : { value: 'Error', truncated: false }
  error.name = name.truncated ? `${truncate(name.value, MAX_LENGTH - 3)}...` : name.value
  error.stack = fitErrors('', errors.map(({ name, message, stack, count }) => {
    const originalStack = stack.value || `${name.value}: ${message.value}`
    return {
      value: errors.length === 1 ? originalStack : `Affected suites: ${count}\n${originalStack}`,
      truncated: stack.truncated || (!stack.value && (name.truncated || message.truncated)),
    }
  }))
  return error
}

/**
 * @param {unknown} value
 * @returns {ErrorField}
 */
function sanitizeErrorField (value) {
  if (typeof value !== 'string') return { value: '', truncated: false }
  const truncated = value.length > MAX_LENGTH
  // Bound work and allocations before ANSI removal and grouping, not only the final output.
  return { value: stripVTControlCharacters(truncated ? truncate(value, MAX_LENGTH) : value), truncated }
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
 * @param {ErrorField[]} details
 */
function fitErrors (summary, details) {
  const totalLength = details.reduce((length, detail) => length + detail.value.length + 2, summary.length) -
    (summary ? 0 : 2)
  if (totalLength <= MAX_LENGTH && !details.some(detail => detail.truncated)) {
    return [summary, ...details.map(detail => detail.value)].filter(Boolean).join('\n\n')
  }

  let output = summary
  for (let i = 0; i < details.length; i++) {
    const remaining = details.length - i - 1
    const notice = '\n\n[Error details truncated. ' +
      (remaining ? `${remaining} additional errors omitted. ` : '') +
      'See suite events for full details.]'
    const separator = output ? '\n\n' : ''
    const available = MAX_LENGTH - output.length - separator.length - notice.length
    if (details[i].truncated || details[i].value.length + (remaining ? 2 : 0) > available) {
      return output + separator + truncate(details[i].value, available) + notice
    }
    output += separator + details[i].value
  }
  return output
}

module.exports = { getSessionError }
