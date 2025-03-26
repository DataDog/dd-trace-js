'use strict'

const { workerData: { config: parentConfig, parentThreadId, configPort } } = require('node:worker_threads')
const { format } = require('node:url')
const log = require('../../log')

const config = module.exports = {
  dynamicInstrumentation: parentConfig.dynamicInstrumentation,
  runtimeId: parentConfig.tags['runtime-id'],
  service: parentConfig.service,
  commitSHA: parentConfig.commitSHA,
  repositoryUrl: parentConfig.repositoryUrl,
  parentThreadId,
  maxTotalPayloadSize: 5 * 1024 * 1024 // 5MB
}

updateUrl(parentConfig)

configPort.on('message', updateUrl)
configPort.on('messageerror', (err) =>
  log.error('[debugger:devtools_client] received "messageerror" on config port', err)
)

function updateUrl (updates) {
  config.url = updates.url || format({
    protocol: 'http:',
    hostname: updates.hostname || 'localhost',
    port: updates.port
  })
}
