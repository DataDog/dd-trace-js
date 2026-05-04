'use strict'

module.exports = function getDebuggerConfig (config, inputPath) {
  return {
    commitSHA: config.commitSHA,
    debug: config.debug,
    dynamicInstrumentation: config.dynamicInstrumentation,
    env: config.env,
    hostname: config.hostname,
    logLevel: config.logLevel,
    port: config.port,
    propagateProcessTags: { enabled: config.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED },
    repositoryUrl: config.repositoryUrl,
    runtimeId: config.tags['runtime-id'],
    service: config.service,
    url: config.url?.toString(),
    version: config.version,
    inputPath,
  }
}
