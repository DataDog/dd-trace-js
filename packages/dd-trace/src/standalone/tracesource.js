'use strict'

const { TRACE_SOURCE_PROPAGATION_KEY } = require('../constants')
const { hasOwn } = require('../util')

function addTraceSourceTag (tags, product) {
  if (tags && product) {
    const actual = tags[TRACE_SOURCE_PROPAGATION_KEY] ? parseInt(tags[TRACE_SOURCE_PROPAGATION_KEY], 16) : 0
    tags[TRACE_SOURCE_PROPAGATION_KEY] = ((actual | product.id) >>> 0).toString(16).padStart(2, '0')
  }

  return tags
}

function hasTraceSourcePropagationTag (tags) {
  return hasOwn(tags, TRACE_SOURCE_PROPAGATION_KEY)
}

module.exports = {
  addTraceSourceTag,
  hasTraceSourcePropagationTag
}
