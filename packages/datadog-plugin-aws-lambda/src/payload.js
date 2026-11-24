'use strict'

const log = require('../../dd-trace/src/log')

const redactableKeys = new Set(['authorization', 'x-authorization', 'password', 'token'])

/**
 * Preserve the Lambda shim's JSON decoding, depth counting, truncation and case-sensitive redaction.
 * Core payload tagging has different depth, undefined, key escaping and tag-limit semantics.
 * @param {import('../../dd-trace/src/opentracing/span')} span Invocation span.
 * @param {string} key Tag path.
 * @param {unknown} value Payload value.
 * @param {number} [depth] Current source depth.
 * @param {number} [maxDepth] Configured source depth cap.
 */
function tagObject (span, key, value, depth = 0, maxDepth = 10) {
  if (value === null) return span.setTag(key, value)
  if (depth >= maxDepth) {
    let text
    try {
      text = JSON.stringify(value)
    } catch (error) {
      log.debug('Unable to stringify Lambda payload for tagging: %s', error)
      return
    }
    if (text === undefined) return
    return span.setTag(key, redactValue(key, text.slice(0, 5000)))
  }
  depth++
  if (typeof value === 'string') {
    let parsed
    try {
      parsed = JSON.parse(value)
    } catch {
      return span.setTag(key, redactValue(key, value.slice(0, 5000)))
    }
    return tagObject(span, key, parsed, depth, maxDepth)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return span.setTag(key, value.toString())
  if (typeof value === 'object') {
    for (const [name, child] of Object.entries(value)) tagObject(span, `${key}.${name}`, child, depth, maxDepth)
  }
}

/**
 * @param {string} key Tag path.
 * @param {string} value Truncated source value.
 */
function redactValue (key, value) {
  const last = key.split('.').pop() || key
  return redactableKeys.has(last) ? 'redacted' : value
}

module.exports = { tagObject }
