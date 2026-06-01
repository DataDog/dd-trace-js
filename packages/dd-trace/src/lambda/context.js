'use strict'

const log = require('../log')

/**
 * Extracts the context from the given Lambda handler arguments.
 *
 * It is possible for users to define a lambda function without specifying a
 * context arg. In these cases, this function returns null instead of throwing
 * an error.
 *
 * @param {unknown[]} args any amount of arguments
 * @returns {object | null}
 */
exports.extractContext = function extractContext (args) {
  let context = null
  for (let i = 0; i < args.length && i < 3; i++) {
    if (args[i] && typeof args[i].getRemainingTimeInMillis === 'function') {
      context = args[i]
      break
    }
  }
  if (!context) {
    log.debug('Unable to extract context object from Lambda handler arguments')
  }
  return context
}
