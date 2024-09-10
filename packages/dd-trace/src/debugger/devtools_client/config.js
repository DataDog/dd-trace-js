'use strict'

const { workerData: { config: parentConfig, configPort } } = require('node:worker_threads')
const { URL, format } = require('node:url')
const log = require('../../log')

const config = module.exports = {
  runtimeId: parentConfig.tags['runtime-id'],
  service: parentConfig.service
}

updateUrl(parentConfig)

configPort.on('message', updateUrl)
configPort.on('messageerror', (err) => log.error(err))

function updateUrl (updates) {
  const url = updates.url || new URL(format({
    // TODO: Can this ever be anything other than `http:`, and if so, how do we get the configured value?
    protocol: config.url?.protocol || 'http:',
    hostname: updates.hostname || config.url?.hostname || 'localhost',
    port: updates.port || config.url?.port
  }))

  config.url = url.toString()
}
