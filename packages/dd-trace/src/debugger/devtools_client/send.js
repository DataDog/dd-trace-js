'use strict'

const config = require('./config')
const log = require('../../log')
const request = require('../../exporters/common/request')

module.exports = send

const ddsource = 'dd_debugger'
const service = config.service

async function send (message, logger, snapshot) {
  const opts = {
    method: 'POST',
    url: config.url,
    path: '/debugger/v1/input',
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  }

  const payload = {
    ddsource,
    service,
    message,
    logger,
    'debugger.snapshot': snapshot
  }

  request(JSON.stringify(payload), opts, (err) => {
    if (err) log.error(err)
  })
}
