'use strict'

const { workerData: { config: parentConfig, configPort } } = require('node:worker_threads')
const { format } = require('node:url')
const log = require('../../log')

const config = module.exports = {
  runtimeId: parentConfig.tags['runtime-id'],
  service: parentConfig.service
}

updateUrl(parentConfig)

configPort.on('message', updateUrl)
configPort.on('messageerror', (err) => log.error(err))

function updateUrl (updates) {
  config.url = updates.url || format({
    protocol: 'http:',
    hostname: updates.hostname || 'localhost',
    port: updates.port
  })
}
