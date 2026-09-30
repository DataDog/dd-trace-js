'use strict'

const { stripVTControlCharacters } = require('node:util')

const { MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION: MAX_LENGTH } =
  require('../../../dd-trace/src/encode/tags-processors')
const log = require('../../../dd-trace/src/log')

/**
 * @typedef {{ name?: unknown, type?: unknown, message?: unknown, stack?: unknown }} SuiteError
 * @typedef {object} JestResults
 * @property {number} [numFailedTestSuites]
 * @property {number} [numFailedTests]
 * @property {number} [numPassedTests]
 * @property {{ testExecError?: SuiteError }[]} [testResults]
 */

/**
 * Includes complete, deduplicated setup errors only when all details fit.
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
  let size = 0
  for (const { testExecError } of results.testResults) {
    if (!testExecError) continue
    let name, message, stack
    try {
      name = readField(testExecError.name)
      if (name === '') name = readField(testExecError.type)
      message = readField(testExecError.message)
      stack = readField(testExecError.stack)
    } catch {
      log.debug('Skipping unreadable Jest suite execution error in the test session summary')
      continue
    }
    if (name === undefined || message === undefined || stack === undefined) return omitDetails(error)
    if (!message && !stack) continue
    name ||= 'Error'
    const key = JSON.stringify([name, message, stack])
    const group = groups.get(key)
    if (group) {
      group.count++
    } else {
      // Retained text must fit across error.message and error.stack; also bound grouping memory.
      size += name.length + message.length + stack.length
      if (size > 2 * MAX_LENGTH) return omitDetails(error)
      groups.set(key, { name, message, stack, count: 1 })
    }
  }
  if (!groups.size) return error

  const errors = [...groups.keys()].sort().map(key => groups.get(key))
  let message = summary
  let stack = ''
  for (const { name, message: detail, stack: originalStack, count } of errors) {
    message += `\n\n${name}: ${detail} (${count} suite${count === 1 ? '' : 's'})`
    const prefix = errors.length === 1 ? '' : `Affected suites: ${count}\n`
    stack += (stack ? '\n\n' : '') + prefix + (originalStack || `${name}: ${detail}`)
    if (message.length > MAX_LENGTH || stack.length > MAX_LENGTH) return omitDetails(error)
  }
  error.name = errors.length === 1 ? errors[0].name : 'Error'
  error.message = message
  error.stack = stack
  return error
}

/**
 * Returns undefined for oversized input before scanning or copying it.
 * @param {unknown} value
 */
function readField (value) {
  if (typeof value !== 'string') return ''
  if (value.length > MAX_LENGTH) return
  return stripVTControlCharacters(value)
}

/** @param {Error} error */
function omitDetails (error) {
  error.message += '\n\nSetup error details exceed the size limit. See suite events for full details.'
  return error
}

module.exports = { getSessionError }
