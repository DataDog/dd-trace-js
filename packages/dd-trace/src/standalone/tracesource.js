'use strict'

const { TRACE_SOURCE_PROPAGATION_KEY } = require('../constants')

/**
 * Adds or updates the trace source propagation tag with the given product bit.
 *
 * @param {Record<string, unknown>|undefined} tags
 * @param {{ id: number }|undefined} product
 * @returns {Record<string, unknown>|undefined}
 */
function addTraceSourceTag (tags, product) {
  if (tags && product) {
    const actual = tags[TRACE_SOURCE_PROPAGATION_KEY]
      ? Number.parseInt(String(tags[TRACE_SOURCE_PROPAGATION_KEY]), 16)
      : 0
    tags[TRACE_SOURCE_PROPAGATION_KEY] = ((actual | product.id) >>> 0).toString(16).padStart(2, '0')
  }

  return tags
}

/**
 * Returns true when the trace source propagation tag exists on the given tags object.
 *
 * @param {Record<string, unknown>} tags
 * @returns {boolean}
 */
function hasTraceSourcePropagationTag (tags) {
  return Object.hasOwn(tags, TRACE_SOURCE_PROPAGATION_KEY)
}

module.exports = {
  addTraceSourceTag,
  hasTraceSourcePropagationTag
}
