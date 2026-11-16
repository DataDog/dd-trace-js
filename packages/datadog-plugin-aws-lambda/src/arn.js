'use strict'

// Ported from datadog-lambda-js at da9fc3c0c9dca00893f70c9a1bd5ac1254af3b01.

/**
 * @param {string} arn
 * @param {string} [version]
 */
function parseLambdaARN (arn, version) {
  let [, , , region, accountId, , functionname, alias] = arn.split(':')
  const tags = { region, account_id: accountId, functionname }
  // If we have an alias...
  if (alias === undefined) {
    tags.resource = functionname
  } else {
    // Check if $Latest and remove $ for datadog tag convention.
    if (alias.startsWith('$')) {
      alias = alias.slice(1)
      // Check if this is an alias and not a version.
    } else if (!Number(alias)) {
      tags.executedversion = version
    }
    tags.resource = functionname + ':' + alias
  }
  return tags
}

/** @param {Record<string, string | undefined>} tags */
function makeTagStringsFromObject (tags) {
  return Object.entries(tags).map(([tagKey, tagValue]) => `${tagKey}:${tagValue}`)
}

/**
 * @param {string} arn
 * @param {string} [version]
 */
function parseTagsFromARN (arn, version) {
  return makeTagStringsFromObject(parseLambdaARN(arn, version))
}

module.exports = { parseLambdaARN, parseTagsFromARN }
