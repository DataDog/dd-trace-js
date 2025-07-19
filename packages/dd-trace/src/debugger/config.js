'use strict'

module.exports = function getDebuggerConfig (config) {
  return {
    commitSHA: config.commitSHA,
    debug: config.debug,
    dynamicInstrumentation: config.dynamicInstrumentation,
    hostname: config.hostname,
    logLevel: config.logLevel,
    port: config.port,
    repositoryUrl: config.repositoryUrl,
    runtimeId: config.tags['runtime-id'],
    service: config.service,
    url: config.url?.toString(),
  }
}
