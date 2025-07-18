'use strict'

module.exports = function getDebuggerConfig (config) {
  return {
    commitSHA: config.commitSHA,
    dynamicInstrumentation: config.dynamicInstrumentation,
    hostname: config.hostname,
    port: config.port,
    repositoryUrl: config.repositoryUrl,
    runtimeId: config.tags['runtime-id'],
    service: config.service,
    url: config.url?.toString(),
  }
}
