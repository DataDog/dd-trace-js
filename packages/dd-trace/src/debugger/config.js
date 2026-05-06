'use strict'

const getGitMetadata = require('../git_metadata')

module.exports = function getDebuggerConfig (config, inputPath) {
  const { commitSHA, repositoryUrl } = getGitMetadata(config)
  return {
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
    url: config.url?.toString(),
    version: config.version,
    inputPath,
  }
}
