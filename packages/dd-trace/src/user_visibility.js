'use strict'

const { SVC_SRC_KEY } = require('./constants')

const SOURCE_MANUAL = 'm'

const userVisibleSpans = new WeakSet()

/**
 * Mark a span as user-visible, i.e. handed out to the user via a public-facing
 * API surface (e.g. tracer.startSpan, tracer.trace, tracer.scope().active(),
 * or a plugin `hooks.*` callback). Internal instrumentation must never call
 * this directly.
 *
 * @template T
 * @param {T} span - The span to mark, or a falsy value (returned untouched).
 * @returns {T} The same span, for chaining.
 */
function markUserVisible (span) {
  if (span !== null && (typeof span === 'object' || typeof span === 'function')) {
    userVisibleSpans.add(span)
  }
  return span
}

/**
 * @param {object} span
 * @returns {boolean}
 */
function isUserVisible (span) {
  return userVisibleSpans.has(span)
}

/**
 * Cheap structural check: does the given key/value blob contain a service
 * override?
 *
 * @param {Record<string, unknown> | null | undefined} blob
 * @returns {boolean}
 */
function hasService (blob) {
  return blob != null && typeof blob === 'object' &&
    (blob.service !== undefined || blob['service.name'] !== undefined)
}

/**
 * Apply user-source stamps to a span when a tag write looks like a manual
 * override. The cheap structural check runs first so the WeakSet read is
 * amortized over the rare path. New "stamp X when user sets Y" rules should
 * be added here as additional `if`/`else if` branches; callers stay one-line.
 *
 * @param {object} span - The DatadogSpan instance receiving the tags.
 * @param {Record<string, unknown> | null | undefined} blob - The key/value
 *   pairs being written.
 */
function applyUserSourceStamps (span, blob) {
  if (hasService(blob) && isUserVisible(span)) {
    span._spanContext._tags[SVC_SRC_KEY] = SOURCE_MANUAL
  }
}

/**
 * Return a new options object with `_dd.svc_src` stamped as manual when the
 * user explicitly set a service via options. Returns the original object
 * untouched when no service was supplied so the common path stays free of
 * allocations.
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
