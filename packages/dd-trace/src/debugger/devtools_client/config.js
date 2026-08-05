'use strict'

const { workerData: { config: parentConfig, parentThreadId, configPort } } = require('node:worker_threads')
const processTags = require('../../process-tags')
const log = require('./log')

processTags.initialize()

const config = module.exports = {
  ...parentConfig,
  parentThreadId,
  maxTotalPayloadSize: 5 * 1024 * 1024, // 5MB
}

updateConfig(parentConfig)

configPort.on('message', updateConfig)
configPort.on('messageerror', (err) =>
  log.error('[debugger:devtools_client] received "messageerror" on config port', err)
)

function updateConfig (updates) {
  // The worker receives a serialized config (see ../config.js) where `url` is a string, so it is
  // reconstructed into a URL here rather than read directly off a Config instance.
  config.url = new URL(updates.url)
  config.dynamicInstrumentation.captureTimeoutNs = BigInt(updates.dynamicInstrumentation.captureTimeoutMs) * 1_000_000n
}
