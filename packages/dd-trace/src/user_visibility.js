'use strict'

const { SVC_SRC_KEY } = require('./constants')

const SOURCE_MANUAL = 'm'

const USER_VISIBLE = Symbol('dd.userVisible')

/**
 * Symbol property keeps the hot-path lookup in `_addTags` a single read
 * instead of a WeakSet hash, and stays invisible to enumeration and JSON.
 *
 * @template T
 * @param {T} span - The span to mark, or a falsy value (returned untouched).
 * @returns {T} The same span, for chaining.
 */
function markUserVisible (span) {
  if (span !== null && (typeof span === 'object' || typeof span === 'function') && !span[USER_VISIBLE]) {
    Object.defineProperty(span, USER_VISIBLE, { value: true })
  }
  return span
}

/**
 * @param {object} span
 * @returns {boolean}
 */
function isUserVisible (span) {
  return span?.[USER_VISIBLE] === true
}

/**
 * @param {Record<string, unknown> | null | undefined} blob
 * @returns {boolean}
 */
function hasService (blob) {
  return blob != null &&
    (blob.service !== undefined || blob['service.name'] !== undefined)
}

/**
 * @param {object} span - The DatadogSpan instance receiving the tags.
 * @param {Record<string, unknown> | null | undefined} blob - The key/value pairs being written.
 */
function applyUserSourceStamps (span, blob) {
  if (hasService(blob) && isUserVisible(span)) {
    span._spanContext._tags[SVC_SRC_KEY] = SOURCE_MANUAL
  }
}

/**
 * Returns the original object untouched when no service was supplied so the
 * common path stays free of allocations.
 *
 * @template {Record<string, unknown> | undefined} T
 * @param {T} options
 * @returns {T | (T & { tags: Record<string, unknown> })}
 */
function stampManualServiceInOptions (options) {
  if (options == null) return options
  if (options.service !== undefined || hasService(options.tags)) {
    return { ...options, tags: { ...options.tags, [SVC_SRC_KEY]: SOURCE_MANUAL } }
  }
  return options
}

module.exports = {
  applyUserSourceStamps,
  isUserVisible,
  markUserVisible,
  stampManualServiceInOptions,
}
