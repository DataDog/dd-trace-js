'use strict'

const { channel } = require('dc-polyfill')

const aiguardChannel = channel('dd-trace:ai:aiguard')

/**
 * Publishes already-converted AI Guard style messages to the AIGuard channel.
 *
 * The Promise resolves when the evaluation has been performed (ALLOW, or a
 * non-ALLOW decision with blocking disabled) and rejects with
 * `AIGuardAbortError` when blocking is enabled and the action is DENY/ABORT.
 *
 * @param {Array<object>} messages - AI Guard style messages to evaluate
 * @returns {Promise<void>}
 */
function publishToAIGuard (messages) {
  return new Promise((resolve, reject) => {
    aiguardChannel.publish({ messages, resolve, reject })
  })
}

module.exports = { publishToAIGuard, aiguardChannel }
