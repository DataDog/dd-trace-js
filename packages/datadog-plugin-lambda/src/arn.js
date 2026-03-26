'use strict'

/**
 * @param {string} arn
 * @param {string} [version]
 * @returns {{ account_id: string, region: string, functionname: string, executedversion?: string, resource?: string }}
 */
function parseLambdaARN (arn, version) {
  const splitArn = arn.split(':')
  const region = splitArn[3]
  const accountId = splitArn[4]
  const functionname = splitArn[6]
  let alias = splitArn[7]

  const tags = { region, account_id: accountId, functionname }

  if (alias !== undefined) {
    if (alias.startsWith('$')) {
      alias = alias.substring(1)
    } else if (!Number(alias)) {
      tags.executedversion = version
    }
    tags.resource = functionname + ':' + alias
  } else {
    tags.resource = functionname
  }

  return tags
}

/**
 * @param {string} arn
 * @param {string} [version]
 * @returns {string[]}
 */
function parseTagsFromARN (arn, version) {
  const tags = parseLambdaARN(arn, version)
  return Object.entries(tags).map(([k, v]) => `${k}:${v}`)
}

module.exports = {
  parseLambdaARN,
  parseTagsFromARN,
}
