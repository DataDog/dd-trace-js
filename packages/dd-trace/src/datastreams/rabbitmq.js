'use strict'

// Normalizes per-instance RabbitMQ queue, routing key and exchange names before
// they are used in DSM edge tags. Names generated per process or per request
// (server-named queues, reply queues, bus endpoints, names with a random
// suffix, names that are only a UUID) would otherwise create a new pathway hash
// for every instance.
//
// Only use this for DSM edge tags. Span tags and resource names keep the raw name.

const AMQ_GEN_PREFIX = 'amq.gen-'
const AMQ_GEN_NORMALIZED = 'amq.gen-*'
const REPLY_TO_PREFIX = 'amq.rabbitmq.reply-to'
const WOLVERINE_PREFIX = 'wolverine.'

// MassTransit bus and temporary endpoints: <host>_<app>_bus_<random>. The <host>_<app> prefix is split
// with string search to avoid a backtracking regex; it behaves like /^(.+)_(.+)_bus_([a-z0-9]+)$/i.
const BUS_SUFFIX = /_bus_[a-z0-9]+$/i
const WOLVERINE_NODE = /^wolverine\.(control|response|replies)\..+$/
// A separator followed by a UUID (dashed, or 32 hex undashed) or by 16 or more hex chars.
const RANDOM_SUFFIX = /([-_.])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i
// A name that is only a UUID (dashed, or exactly 32 hex undashed).
const BARE_UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i

/**
 * @param {string | null | undefined} name
 */
function normalizeRabbitMQName (name) {
  if (!name || typeof name !== 'string') return name

  if (name.startsWith(AMQ_GEN_PREFIX)) return AMQ_GEN_NORMALIZED
  if (name.startsWith(REPLY_TO_PREFIX)) return REPLY_TO_PREFIX

  if (name.includes('_')) {
    const busMatch = BUS_SUFFIX.exec(name)
    if (busMatch) {
      // The app segment must be non-empty and preceded by a non-empty host segment.
      const separator = name.lastIndexOf('_', busMatch.index - 2)
      if (separator > 0) return `*_${name.slice(separator + 1, busMatch.index)}_bus_*`
    }
  }

  if (name.startsWith(WOLVERINE_PREFIX)) {
    const match = WOLVERINE_NODE.exec(name)
    if (match) return `wolverine.${match[1]}.*`
  }

  const match = RANDOM_SUFFIX.exec(name)
  if (match) return `${name.slice(0, match.index)}${match[1]}*`

  if ((name.length === 36 || name.length === 32) && BARE_UUID.test(name)) return '*'

  return name
}

module.exports = { normalizeRabbitMQName }
