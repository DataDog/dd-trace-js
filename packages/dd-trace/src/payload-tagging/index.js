'use strict'

const {
  PAYLOAD_TAG_REQUEST_PREFIX,
  PAYLOAD_TAG_RESPONSE_PREFIX,
} = require('../constants')

const jsonpath = require('../../../../vendor/dist/jsonpath-plus').JSONPath

const log = require('../log')

const { tagsFromObject } = require('./tagging')
const { createSafeSnapshot, truncated } = require('./snapshot')

// JSONPath constructs that select based on data values (predicates, script
// expressions, type, parent and property-name selectors, slices, literal
// escapes). On a partially captured payload their matches can differ from the
// full payload, which could stop a redaction rule from matching a sensitive
// value. Truncated captures are suppressed entirely when any rule uses one of
// these constructs; structural paths, wildcards, indexes and recursive descent
// stay safe because truncation only removes content, never reshapes retained
// branches.
const dataDependentRulePattern = /[?()@^~:`]/

// Bound expansion of JSON-encoded strings before parsing them, so an oversized
// candidate can neither be parsed nor retained for later truncation.
const maxExpansionLength = 1_000_000

/**
 * @param {string[]} rules
 */
function hasDataDependentRules (rules) {
  for (const rule of rules) {
    if (typeof rule !== 'string' || dataDependentRulePattern.test(rule)) {
      return true
    }
  }
  return false
}

/**
 * Assign to a snapshot container, keeping `__proto__` a plain data property.
 *
 * @param {Record<string, unknown>} parent
 * @param {string | number} parentProperty
 * @param {unknown} value
 */
function assignSafe (parent, parentProperty, value) {
  if (parentProperty === '__proto__') {
    Object.defineProperty(parent, parentProperty, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
    return
  }
  parent[parentProperty] = value
}

/**
 * Given an identified value, attempt to parse it as JSON if relevant. Parsed
 * values pass through the same bounded snapshot handling as the rest of the
 * payload, so expansion cannot introduce unbounded traversal either.
 *
 * @param {unknown} value
 * @param {{ incomplete: boolean }} capture
 * @returns {unknown} the parsed snapshot if parsing was successful, the input if not
 */
function maybeJSONParseValue (value, capture) {
  if (typeof value !== 'string' || value[0] !== '{') {
    return value
  }

  if (value.length > maxExpansionLength) {
    capture.incomplete = true
    return truncated
  }

  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    return value
  }

  const snapshot = createSafeSnapshot(parsed)
  if (snapshot.incomplete) {
    capture.incomplete = true
  }
  return snapshot.value
}

/**
 * Apply expansion to all expansion JSONPath queries
 *
 * @param {Record<string, unknown>} object
 * @param {string[]} expansionRules list of JSONPath queries
 * @param {{ incomplete: boolean }} capture
 */
function expand (object, expansionRules, capture) {
  for (const rule of expansionRules) {
    jsonpath(rule, object, (value, _type, desc) => {
      if (desc.parent && desc.parentProperty) {
        assignSafe(desc.parent, desc.parentProperty, maybeJSONParseValue(value, capture))
      }
    })
  }
}

/**
 * Apply redaction to all redaction JSONPath queries
 *
 * @param {Record<string, unknown>} object
 * @param {string[]} redactionRules
 */
function redact (object, redactionRules) {
  for (const rule of redactionRules) {
    jsonpath(rule, object, (_value, _type, desc) => {
      if (desc.parent && desc.parentProperty) {
        assignSafe(desc.parent, desc.parentProperty, 'redacted')
      }
    })
  }
}

/**
 * Generate a map of tag names to tag values by performing:
 * 1. Taking a bounded, acyclic, stream-safe snapshot of the input
 * 2. Attempting to parse identified fields as JSON
 * 3. Redacting fields identified by redaction rules
 * 4. Flattening the resulting object, producing as many tag name/tag value pairs
 *    as there are leaf values in the object
 * This function never mutates the input object.
 *
 * @param {{ expand: string[], request: string[], response: string[] }} config sdk configuration for the service
 * @param {unknown} object the input object to generate tags from
 * @param {{ prefix: string, maxDepth: number }} opts tag generation options
 * @returns {Record<string, string|boolean>} Tags map
 */
function computeTags (config, object, opts) {
  try {
    return computeBoundedTags(config, object, opts)
  } catch (err) {
    // Payload capture must never break the instrumented operation or disable
    // the plugin. Omit payload tags entirely rather than emit a capture that
    // may be partly expanded or partly redacted. Log only the error name:
    // exception messages can carry payload contents.
    log.error(
      'Error generating payload tags; omitting payload tags for this operation (error: %s)',
      err instanceof Error ? err.name : typeof err
    )
    return {}
  }
}

/**
 * Snapshot, expand, redact and flatten a payload. When the snapshot is
 * incomplete, captures whose redaction could be unreliable are suppressed
 * instead of risking exposure of unredacted values.
 *
 * @param {{ expand: string[], request: string[], response: string[] }} config
 * @param {unknown} object
 * @param {{ prefix: string, maxDepth: number }} opts
 * @returns {Record<string, string|boolean>}
 */
function computeBoundedTags (config, object, opts) {
  const snapshot = createSafeSnapshot(object)
  const payload = /** @type {Record<string, unknown>} */ (snapshot.value)
  const redactionRules = opts.prefix === PAYLOAD_TAG_REQUEST_PREFIX ? config.request : config.response
  const expansionRules = config.expand

  if (
    snapshot.incomplete &&
    (hasDataDependentRules(redactionRules) || hasDataDependentRules(expansionRules))
  ) {
    return {}
  }

  const capture = { incomplete: snapshot.incomplete }
  expand(payload, expansionRules, capture)

  if (capture.incomplete && hasDataDependentRules(redactionRules)) {
    return {}
  }

  redact(payload, redactionRules)
  const tags = tagsFromObject(payload, opts)
  if (capture.incomplete) {
    tags['_dd.payload_tags_incomplete'] = true
  }
  return tags
}

/**
 * Compute request tags with the request prefix.
 *
 * @param {{ expand: string[], request: string[], response: string[] }} config
 * @param {Record<string, unknown>} object
 * @param {{ maxDepth: number }} opts
 * @returns {Record<string, string|boolean>}
 */
function tagsFromRequest (config, object, opts) {
  return computeTags(config, object, { ...opts, prefix: PAYLOAD_TAG_REQUEST_PREFIX })
}

/**
 * Compute response tags with the response prefix.
 *
 * @param {{ expand: string[], request: string[], response: string[] }} config
 * @param {Record<string, unknown>} object
 * @param {{ maxDepth: number }} opts
 * @returns {Record<string, string|boolean>}
 */
function tagsFromResponse (config, object, opts) {
  return computeTags(config, object, { ...opts, prefix: PAYLOAD_TAG_RESPONSE_PREFIX })
}

module.exports = { computeTags, tagsFromRequest, tagsFromResponse }
