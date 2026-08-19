'use strict'

const getGitMetadata = require('../git_metadata')

module.exports = function getDebuggerConfig (config, inputPath) {
  const { commitSHA, repositoryUrl } = getGitMetadata(config)
  const agentless = config.DD_AGENTLESS_ENABLED === true

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
    url: agentless ? `https://debugger-intake.${config.site}` : config.url.toString(),
    version: config.version,
    inputPath,
  }
}
