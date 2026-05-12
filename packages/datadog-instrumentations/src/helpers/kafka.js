'use strict'

// Side-table mapping a kafkajs producer/consumer to the cluster captured at
// creation time. The boundary uses it to read `cluster.brokerPool` lazily on
// first send/consume instead of opening a parallel admin connection. A
// WeakMap keeps the kafkajs object itself untouched: no Symbol-keyed
// property to leak through `Reflect.ownKeys`, no string-keyed underscore for
// user serializers to pick up, and the entry drops as soon as the producer
// is GC'd.
const clientToCluster = new WeakMap()

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
  clientToCluster,
  cloneMessages,
}
