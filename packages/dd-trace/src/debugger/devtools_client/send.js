'use strict'

const { threadId } = require('node:worker_threads')
const config = require('./config')
const log = require('../../log')
const request = require('../../exporters/common/request')

module.exports = send

const ddsource = 'dd_debugger'
const service = config.service

// TODO: Figure out correct logger values
const logger = {
  name: __filename, // name of the class/type/file emitting the snapshot
  method: send.name, // name of the method/function emitting the snapshot
  version: 2, // version of the snapshot format (not currently used or enforced)
  thread_id: threadId, // current thread/process id emitting the snapshot
  thread_name: `${process.argv0};pid:${process.pid}` // name of the current thread emitting the snapshot
}

async function send (message, snapshot) {
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
