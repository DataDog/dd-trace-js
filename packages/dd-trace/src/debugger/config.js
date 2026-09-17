'use strict'

const { getEnvironmentVariable } = require('../config/helper')
const { createSiteUrl } = require('../exporters/common/url')
const getGitMetadata = require('../git_metadata')

const DEFAULT_QUEUE_MAX_BYTES = 10 * 1024 * 1024
const QUEUE_MAX_BYTES_ENV = '_DD_DYNAMIC_INSTRUMENTATION_QUEUE_MAX_BYTES'

/**
 * @param {ReturnType<import('../config')>} config
 * @param {string} [inputPath]
 */
module.exports = function getDebuggerConfig (config, inputPath) {
  const { commitSHA, repositoryUrl } = getGitMetadata(config)
  const agentless = config.DD_AGENTLESS_ENABLED
  const agentlessUrl = agentless ? createSiteUrl(config.site, 'debugger-intake') : undefined
  if (agentless && agentlessUrl === undefined) return
  const configuredQueueMaxBytes = Number(getEnvironmentVariable(QUEUE_MAX_BYTES_ENV))
  const queueMaxBytes = Number.isSafeInteger(configuredQueueMaxBytes) && configuredQueueMaxBytes > 0
    ? configuredQueueMaxBytes
    : DEFAULT_QUEUE_MAX_BYTES

  return {
    agentless,
    apiKey: agentless ? config.DD_API_KEY : undefined,
    commitSHA,
    debug: config.debug,
    dynamicInstrumentation: {
      ...config.dynamicInstrumentation,
      queueMaxBytes,
    },
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
