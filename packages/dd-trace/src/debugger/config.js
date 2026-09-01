'use strict'

const { createSiteUrl } = require('../exporters/common/url')
const getGitMetadata = require('../git_metadata')

/**
 * @param {ReturnType<import('../config')>} config
 * @param {string} [inputPath]
 */
module.exports = function getDebuggerConfig (config, inputPath) {
  const { commitSHA, repositoryUrl } = getGitMetadata(config)
  const agentless = config.DD_AGENTLESS_ENABLED
  const agentlessUrl = agentless ? createSiteUrl(config.site, 'debugger-intake') : undefined
  if (agentless && agentlessUrl === undefined) return

  return {
    agentless,
    apiKey: agentless ? config.DD_API_KEY : undefined,
    commitSHA,
    debug: config.debug,
    dynamicInstrumentation: config.dynamicInstrumentation,
    env: config.env,
    hostname: config.hostname,
    logLevel: config.logLevel,
    port: config.port,
    propagateProcessTags: { enabled: config.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED },
    repositoryUrl,
    runtimeId: config.tags['runtime-id'],
    service: config.service,
    url: agentless ? agentlessUrl.origin : config.url.toString(),
    version: config.version,
    inputPath,
  }
}
