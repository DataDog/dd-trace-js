'use strict'

const {
  PAYLOAD_TAG_REQUEST_PREFIX,
  PAYLOAD_TAG_RESPONSE_PREFIX,
} = require('../constants')

const jsonpath = require('../../../../vendor/dist/jsonpath-plus').JSONPath

const log = require('../log')

const { tagsFromObject } = require('./tagging')
const { createSafeSnapshot, createSnapshotBudget } = require('./snapshot')
const { truncated } = require('./constants')

// JSONPath constructs that select on data values (predicates, script
// expressions, type, parent and property-name selectors). On an incomplete
// capture their matches can differ from the full payload, possibly missing a
// sensitive value. Incomplete captures are suppressed when any rule uses
// one; structural paths, wildcards, indexes and recursive descent stay safe
// because incompleteness only removes or normalizes content.
const dataDependentRulePattern = /[?()@^~:`]/

// Remaining cumulative string length (UTF-16 code units) available for
// JSON.parse attempts across one payload's expansions. Each attempt subtracts
// its input length up front and failed attempts are not refunded, bounding
// combined parse work.
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
 * Work shared by every expansion of one payload: the snapshot budget left by
 * capture and the remaining parse budget, both consumed in place. The
 * incomplete flag records any normalization or truncation encountered so far,
 * whether during initial capture or expansion.
 *
 * @typedef {{
 *   incomplete: boolean,
 *   budget: import('./snapshot').SnapshotBudget,
 *   expansionLength: number
 * }} Capture
 */

/**
 * Attempt to parse an identified string value as JSON. Parsed values go
 * through the same bounded snapshot, sharing the payload's budget, so
 * expansion cannot introduce unbounded parsing or traversal.
 *
 * @param {unknown} value
 * @param {Capture} capture
 * @returns {unknown} the parsed snapshot if parsing was successful, the input if not
 */
function maybeJSONParseValue (value, capture) {
  if (typeof value !== 'string' || value[0] !== '{') {
    return value
  }

  if (value.length > capture.expansionLength) {
    capture.incomplete = true
    return truncated
  }
  capture.expansionLength -= value.length

  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    return value
  }

  const snapshot = createSafeSnapshot(parsed, capture.budget)
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
 * @param {Capture} capture
 */
function expand (object, expansionRules, capture) {
  for (const rule of expansionRules) {
    jsonpath(rule, object, (value, _type, desc) => {
      // Property-name selectors report `parentProperty: null` and the root has
      // none at all; neither names a destination. Index 0 and the empty string
      // are valid, so only null and undefined are rejected.
      if (desc.parent && desc.parentProperty != null) {
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
      // See the expansion guard: null and undefined name no destination.
      if (desc.parent && desc.parentProperty != null) {
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
  } catch {
    // A capture failure must not break the instrumented operation. Omit
    // partly expanded or redacted tags; never inspect the caught value, as
    // payload getters can throw while logging it.
    log.error('Error generating payload tags; omitting payload tags for this operation')
    return {}
  }
}

/**
 * Snapshot, expand, redact and flatten a payload. Incomplete captures whose
 * rules are data-dependent are suppressed instead of risking exposure of
 * unredacted values.
 *
 * @param {{ expand: string[], request: string[], response: string[] }} config
 * @param {unknown} object
 * @param {{ prefix: string, maxDepth: number }} opts
 * @returns {Record<string, string|boolean>}
 */
function computeBoundedTags (config, object, opts) {
  const budget = createSnapshotBudget()
  const snapshot = createSafeSnapshot(object, budget)
  const payload = /** @type {Record<string, unknown>} */ (snapshot.value)
  const redactionRules = opts.prefix === PAYLOAD_TAG_REQUEST_PREFIX ? config.request : config.response
  const expansionRules = config.expand

  if (
    snapshot.incomplete &&
    (hasDataDependentRules(redactionRules) || hasDataDependentRules(expansionRules))
  ) {
    // Fixed, payload-safe diagnostic: no payload values or rule text included.
    log.debug(
      'Omitting payload tags: the capture was incomplete and the rules are data-dependent'
    )
    return {}
  }

  /** @type {Capture} */
  const capture = { incomplete: snapshot.incomplete, budget, expansionLength: maxExpansionLength }
  expand(payload, expansionRules, capture)

  if (
    capture.incomplete &&
    (hasDataDependentRules(redactionRules) || hasDataDependentRules(expansionRules))
  ) {
    log.debug(
      'Omitting payload tags: expansion was incomplete and the rules are data-dependent'
    )
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
