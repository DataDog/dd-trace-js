'use strict'

const { hostname: getHostname } = require('node:os')

const tracerVersion = require('../../../../package.json').version
const getGitMetadata = require('../git_metadata')
const { GIT_COMMIT_SHA, GIT_REPOSITORY_URL } = require('../plugins/util/tags')
const processTags = require('../process-tags')

const REMOTE_CONFIG_REQUEST_TIMEOUT_MS = 5000

module.exports = function getDebuggerConfig (config, inputPath) {
  const { commitSHA, repositoryUrl } = getGitMetadata(config)
  const agentless = config.DD_AGENTLESS_ENABLED === true
  const tags = repositoryUrl
    ? {
        ...config.tags,
        [GIT_REPOSITORY_URL]: repositoryUrl,
        [GIT_COMMIT_SHA]: commitSHA,
      }
    : config.tags

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
    remoteConfig: agentless
      ? {
          runtimeId: config.tags['runtime-id'],
          service: config.service ?? '',
          env: config.env ?? '',
          appVersion: config.version ?? '',
          tags: Object.entries(tags).map(pair => pair.join(':')),
          processTags: processTags.tagsArray ?? [],
          language: 'node',
          tracerVersion,
          url: `https://${config.site}`,
          timeoutMs: REMOTE_CONFIG_REQUEST_TIMEOUT_MS,
          retryIntervalMs: Math.floor(config.remoteConfig.pollInterval * 1000),
          apiKey: config.DD_API_KEY,
          hostname: config.hostname || getHostname(),
        }
      : undefined,
    repositoryUrl,
    runtimeId: config.tags['runtime-id'],
    service: config.service,
    url: agentless ? `https://debugger-intake.${config.site}` : config.url.toString(),
    version: config.version,
    inputPath,
  }
}
