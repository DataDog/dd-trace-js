'use strict'

const log = require('../../dd-trace/src/log')

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
 * Resolve a user-provided filter from plugin config. Returns `undefined` when
 * no filter is configured so callers can short-circuit the filtering path on a
 * cheap truthy check. If `producerFilter` is present but not a function, log
 * an error and fall back to no filter.
 *
 * @param {{ producerFilter?: unknown }} config Plugin config that may carry a `producerFilter`.
 * @returns {BullmqFilter | undefined}
 */
function getFilter (config) {
  if (typeof config?.producerFilter === 'function') {
    return /** @type {BullmqFilter} */ (config.producerFilter)
  }
  if (config?.producerFilter !== undefined) {
    log.error('Expected `producerFilter` to be a function. Ignoring.')
  }
}

module.exports = { getFilter }
