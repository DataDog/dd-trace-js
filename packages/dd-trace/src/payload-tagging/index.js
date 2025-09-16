'use strict'

const rfdc = require('rfdc')({ proto: false, circles: false })

const {
  PAYLOAD_TAG_REQUEST_PREFIX,
  PAYLOAD_TAG_RESPONSE_PREFIX
} = require('../constants')

const jsonpath = require('jsonpath-plus').JSONPath

const { tagsFromObject } = require('./tagging')

/**
 * Given an identified value, attempt to parse it as JSON if relevant
 *
 * @param {unknown} value
 * @returns {unknown} the parsed object if parsing was successful, the input if not
 */
function maybeJSONParseValue (value) {
  if (typeof value !== 'string' || value[0] !== '{') {
    return value
  }

  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * Apply expansion to all expansion JSONPath queries
 *
 * @param {Record<string, unknown>} object
 * @param {string[]} expansionRules list of JSONPath queries
 */
function expand (object, expansionRules) {
  for (const rule of expansionRules) {
    jsonpath(rule, object, (value, _type, desc) => {
      desc.parent[desc.parentProperty] = maybeJSONParseValue(value)
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
      desc.parent[desc.parentProperty] = 'redacted'
    })
  }
}

/**
 * Generate a map of tag names to tag values by performing:
 * 1. Attempting to parse identified fields as JSON
 * 2. Redacting fields identified by redaction rules
 * 3. Flattening the resulting object, producing as many tag name/tag value pairs
 *    as there are leaf values in the object
 * This function performs side-effects on a _copy_ of the input object.
 *
 * @param {{ expand: string[], request: string[], response: string[] }} config sdk configuration for the service
 * @param {Record<string, unknown>} object the input object to generate tags from
 * @param {{ prefix: string, maxDepth: number }} opts tag generation options
 * @returns {Record<string, string|boolean>} Tags map
 */
function computeTags (config, object, opts) {
  const payload = rfdc(object)
  const redactionRules = opts.prefix === PAYLOAD_TAG_REQUEST_PREFIX ? config.request : config.response
  const expansionRules = config.expand
  expand(payload, expansionRules)
  redact(payload, redactionRules)
  return tagsFromObject(payload, opts)
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
