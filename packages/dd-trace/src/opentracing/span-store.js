'use strict'

const stores = new WeakMap()

/**
 * Associate a span with the async-context store active at creation time.
 *
 * @param {object} span
 * @param {unknown} store
 */
function setSpanStore (span, store) {
  stores.set(span, store)
}

/**
 * Return the async-context store associated with a span.
 *
 * @param {object} span
 * @returns {unknown}
 */
function getSpanStore (span) {
  return stores.get(span)
}

module.exports = { getSpanStore, setSpanStore }
