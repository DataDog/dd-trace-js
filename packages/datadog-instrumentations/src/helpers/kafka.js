'use strict'

// Produce API key 0; v0–v2 use the legacy MessageSet format with no header
// field, so trace headers can only be carried on v3+ (Kafka >=0.11).
const PRODUCE_API_KEY = 0
const PRODUCE_VERSION_WITH_HEADERS = 3

// Side-table mapping a kafkajs producer/consumer to the cluster captured at
// creation time. The boundary uses it to read `cluster.brokerPool` lazily on
// first send/consume instead of opening a parallel admin connection. A
// WeakMap keeps the kafkajs object itself untouched: no Symbol-keyed
// property to leak through `Reflect.ownKeys`, no string-keyed underscore for
// user serializers to pick up, and the entry drops as soon as the producer
// is GC'd.
const clientToCluster = new WeakMap()

/**
 * @param {Array<unknown>} messages
 */
function cloneMessages (messages) {
  const result = new Array(messages.length)
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message === null || typeof message !== 'object') {
      result[i] = message
    } else {
      result[i] = message.headers
        ? { ...message, headers: { ...message.headers } }
        : { ...message }
    }
  }
  return result
}

/**
 * @param {Array<unknown>} messages
 */
function cloneMessagesForInjection (messages) {
  const result = new Array(messages.length)
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    result[i] = (message === null || typeof message !== 'object')
      ? message
      : { ...message, headers: message.headers ? { ...message.headers } : {} }
  }
  return result
}

/**
 * @param {{ versions?: Record<number, { minVersion: number, maxVersion: number }> } | undefined} brokerPool
 *   kafkajs's `cluster.brokerPool`. `versions` is populated once the seed
 *   broker handshakes; before that, the answer is unknown and we return
 *   `true` so the caller defaults to injection.
 */
function brokerSupportsMessageHeaders (brokerPool) {
  const produce = brokerPool?.versions?.[PRODUCE_API_KEY]
  return !produce || produce.maxVersion >= PRODUCE_VERSION_WITH_HEADERS
}

module.exports = {
  brokerSupportsMessageHeaders,
  clientToCluster,
  cloneMessages,
  cloneMessagesForInjection,
}
