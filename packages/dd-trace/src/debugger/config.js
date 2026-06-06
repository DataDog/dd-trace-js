'use strict'

const { format } = require('node:url')

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
    // CI Visibility agentless mode leaves `config.url` empty; the worker still needs the local
    // agent URL, so resolve host/port here instead of shipping an empty string to `new URL()`.
    url: config.url
      ? config.url.toString()
      : format({ protocol: 'http:', hostname: config.hostname, port: config.port }),
    version: config.version,
    inputPath,
  }
}
