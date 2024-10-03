'use strict'

const { hostname: getHostname } = require('os')

const config = require('./config')
const request = require('../../exporters/common/request')

module.exports = send

const ddsource = 'dd_debugger'
const hostname = getHostname()
const service = config.service

function send (message, logger, snapshot, cb) {
  const opts = {
    method: 'POST',
    url: config.url,
    path: '/debugger/v1/input',
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  }

  const payload = {
    ddsource,
    hostname,
    service,
    message,
    logger,
    'debugger.snapshot': snapshot
  }

  request(JSON.stringify(payload), opts, cb)
}
