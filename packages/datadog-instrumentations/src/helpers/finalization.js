'use strict'

const log = require('../../../dd-trace/src/log')

/**
 * Runs Test Optimization finalization without replacing a framework error.
 *
 * @param {unknown} frameworkError
 * @param {() => Promise<unknown>} finalize
 * @param {string} framework
 * @returns {Promise<never>}
 */
async function finalizeAndRethrow (frameworkError, finalize, framework) {
  try {
    await finalize()
  } catch (finalizationError) {
    log.error('%s test session finalization error: %s', framework, finalizationError)
  }
  throw frameworkError
}

module.exports = { finalizeAndRethrow }
