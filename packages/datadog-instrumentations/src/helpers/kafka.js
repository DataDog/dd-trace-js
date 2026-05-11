'use strict'

/**
 * Shallow-clone each message and its headers so the boundary, kafkajs, and
 * the user never share the same nested objects. With `ensureHeaders` true
 * (header injection enabled) messages without `headers` get an empty object
 * the producer plugin can inject into; with it false (broker rejected
 * headers) the absence of `headers` is preserved so brokers that fail on any
 * header field can recover.
 *
 * @param {Array<unknown>} messages
 * @param {boolean} ensureHeaders
 */
function cloneMessages (messages, ensureHeaders) {
  const result = new Array(messages.length)
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message === null || typeof message !== 'object') {
      result[i] = message
    } else if (message.headers) {
      result[i] = { ...message, headers: { ...message.headers } }
    } else {
      result[i] = ensureHeaders ? { ...message, headers: {} } : { ...message }
    }
  }
  return result
}

module.exports = {
  cloneMessages,
}
