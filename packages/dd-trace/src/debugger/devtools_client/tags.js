'use strict'

const { GIT_COMMIT_SHA, GIT_REPOSITORY_URL } = require('../../plugins/util/tags')

/**
 * @param {ReturnType<import('../config')>} config - Debugger configuration
 * @param {string} hostname - Host name
 * @param {string} debuggerVersion - Debugger version
 * @param {typeof import('./log')} log - Debugger logger
 * @returns {string} Serialized tags
 */
module.exports = function buildTags (config, hostname, debuggerVersion, log) {
  const tags = [
    ['env', config.env],
    ['version', config.version],
    ['debugger_version', debuggerVersion],
    ['host_name', hostname],
    [GIT_COMMIT_SHA, config.commitSHA],
    [GIT_REPOSITORY_URL, config.repositoryUrl],
  ]
  if (config.agentless) tags.splice(3, 0, ['runtime_id', config.runtimeId])
  let serializedTags = ''

  for (const [key, rawValue] of tags) {
    if (rawValue === undefined) continue

    if (String(rawValue).includes(',')) {
      log.warn('[debugger:devtools_client] Skipping invalid tag value for %s', key)
      continue
    }

    if (serializedTags) serializedTags += ','
    serializedTags += `${key}:${rawValue}`
  }

  return serializedTags
}
