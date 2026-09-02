'use strict'

const { GIT_COMMIT_SHA, GIT_REPOSITORY_URL } = require('../../plugins/util/tags')

/**
 * @param {ReturnType<import('../config')>} config - Debugger configuration
 * @param {string} hostname - Host name
 * @param {string} debuggerVersion - Debugger version
 * @param {typeof import('./log')} log - Debugger logger
 */
module.exports = function buildTags (config, hostname, debuggerVersion, log) {
  let tags = ''

  if (isValidTag('env', config.env, log)) tags += `,env:${config.env}`
  if (isValidTag('version', config.version, log)) tags += `,version:${config.version}`
  if (isValidTag('debugger_version', debuggerVersion, log)) tags += `,debugger_version:${debuggerVersion}`
  if (config.agentless && isValidTag('runtime_id', config.runtimeId, log)) tags += `,runtime_id:${config.runtimeId}`
  if (isValidTag('host_name', hostname, log)) tags += `,host_name:${hostname}`
  if (isValidTag(GIT_COMMIT_SHA, config.commitSHA, log)) tags += `,${GIT_COMMIT_SHA}:${config.commitSHA}`
  if (isValidTag(GIT_REPOSITORY_URL, config.repositoryUrl, log)) {
    tags += `,${GIT_REPOSITORY_URL}:${config.repositoryUrl}`
  }

  return tags.slice(1)
}

/**
 * @param {string} key
 * @param {string | number | undefined} value
 * @param {typeof import('./log')} log
 */
function isValidTag (key, value, log) {
  if (value === undefined) return false

  if (String(value).includes(',')) {
    log.warn('[debugger:devtools_client] Skipping invalid tag value for %s', key)
    return false
  }

  return true
}
