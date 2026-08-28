'use strict'

const { GIT_COMMIT_SHA, GIT_REPOSITORY_URL } = require('../../plugins/util/tags')

/**
 * @param {ReturnType<import('../config')>} config - Debugger configuration
 * @param {string} hostname - Host name
 * @param {string} debuggerVersion - Debugger version
 * @param {typeof import('./log')} log - Debugger logger
 */
module.exports = function buildTags (config, hostname, debuggerVersion, log) {
  const tags = [
    ['env', config.env],
    ['version', config.version],
    ['debugger_version', debuggerVersion],
    ['runtime_id', config.agentless ? config.runtimeId : undefined],
    ['host_name', hostname],
    [GIT_COMMIT_SHA, config.commitSHA],
    [GIT_REPOSITORY_URL, config.repositoryUrl],
  ]
  let serializedTags = ''

  for (const [key, rawValue] of tags) {
    if (rawValue === undefined) continue

    const value = String(rawValue)
    if (value.includes(',')) {
      log.warn('[debugger:devtools_client] Skipping invalid tag value for %s', key)
      continue
    }

    if (serializedTags) serializedTags += ','
    serializedTags += `${key}:${value}`
  }

  return serializedTags
}
