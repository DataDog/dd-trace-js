const rfdc = require('rfdc')({ proto: false, circles: false })

const {
  PAYLOAD_TAG_REQUEST_PREFIX,
  PAYLOAD_TAG_RESPONSE_PREFIX
} = require('../constants')

const jsonpath = require('./jsonpath-plus.js').JSONPath

const { tagsFromObject } = require('./tagging')

/**
 * Given an identified value, attempt to parse it as JSON if relevant
 *
 * @param {any} value
 * @returns {any} the parsed object if parsing was successful, the input if not
 */
function maybeJSONParseValue (value) {
  if (typeof value !== 'string' || value[0] !== '{') {
    return value
  }

  try {
    return JSON.parse(value)
  } catch (e) {
    return value
  }
}

/**
 * Apply expansion to all expansion JSONPath queries
 *
 * @param {Object} object
 * @param {[String]} expansionRules list of JSONPath queries
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
 * @param {Object} object
 * @param {[String]} redactionRules
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
 * @param {Object} config sdk configuration for the service
 * @param {[String]} config.expand expansion rules for the service
 * @param {[String]} config.request redaction rules for the request
 * @param {[String]} config.response redaction rules for the response
 * @param {Object} object the input object to generate tags from
 * @param {Object} opts tag generation options
 * @param {String} opts.prefix prefix for all generated tags
 * @param {number} opts.maxDepth maximum depth to traverse the object
 * @returns
 */
function computeTags (config, object, opts) {
  const payload = rfdc(object)
  const redactionRules = opts.prefix === PAYLOAD_TAG_REQUEST_PREFIX ? config.request : config.response
  const expansionRules = config.expand
  expand(payload, expansionRules)
  redact(payload, redactionRules)
  return tagsFromObject(payload, opts)
}

function tagsFromRequest (config, object, opts) {
  return computeTags(config, object, { ...opts, prefix: PAYLOAD_TAG_REQUEST_PREFIX })
}

function tagsFromResponse (config, object, opts) {
  return computeTags(config, object, { ...opts, prefix: PAYLOAD_TAG_RESPONSE_PREFIX })
}

module.exports = { computeTags, tagsFromRequest, tagsFromResponse }
