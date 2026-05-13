'use strict'

const log = require('../../dd-trace/src/log')

const defaultFilter = () => true

/**
 * @typedef {object} BullmqJobShape
 * @property {string} [name]
 * @property {unknown} [data]
 * @property {unknown} [opts]
 * @property {string} [queueName]
 */

/**
 * @typedef {(job: BullmqJobShape) => boolean} BullmqFilter
 */

/**
 * Resolve a user-provided filter from plugin config. If the value is present
 * but not a function, log an error and fall back to the default allow-all
 * filter. Mirrors the contract used by `plugins/util/urlfilter#getFilter`.
 *
 * @param {{ producerFilter?: unknown }} config Plugin config that may carry a `producerFilter`.
 * @returns {BullmqFilter}
 */
function getFilter (config) {
  if (typeof config?.producerFilter === 'function') {
    return /** @type {BullmqFilter} */ (config.producerFilter)
  }
  if (config?.producerFilter !== undefined) {
    log.error('Expected `producerFilter` to be a function. Overriding producerFilter property to default.')
  }
  return defaultFilter
}

module.exports = { defaultFilter, getFilter }
