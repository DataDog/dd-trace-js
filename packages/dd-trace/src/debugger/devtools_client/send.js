'use strict'

const { hostname: getHostname } = require('os')
const { stringify } = require('querystring')

const config = require('./config')
const JSONBuffer = require('./json-buffer')
const request = require('../../exporters/common/request')
const { GIT_COMMIT_SHA, GIT_REPOSITORY_URL } = require('../../plugins/util/tags')
const log = require('../../log')
const { version } = require('../../../../../package.json')

module.exports = send

const MAX_LOG_PAYLOAD_SIZE = 1024 * 1024 // 1MB

const ddsource = 'dd_debugger'
const hostname = getHostname()
const service = config.service

const ddtags = [
  ['env', process.env.DD_ENV],
  ['version', process.env.DD_VERSION],
  ['debugger_version', version],
  ['host_name', hostname],
  [GIT_COMMIT_SHA, config.commitSHA],
  [GIT_REPOSITORY_URL, config.repositoryUrl]
].map((pair) => pair.join(':')).join(',')

const path = `/debugger/v1/input?${stringify({ ddtags })}`

let callbacks = []
const jsonBuffer = new JSONBuffer({ size: config.maxTotalPayloadSize, timeout: 1000, onFlush })

function send (message, logger, dd, snapshot, cb) {
  const payload = {
    ddsource,
    hostname,
    service,
    message,
    logger,
    dd,
    'debugger.snapshot': snapshot
  }

  let json = JSON.stringify(payload)
  let size = Buffer.byteLength(json)

  if (size > MAX_LOG_PAYLOAD_SIZE) {
    // TODO: This is a very crude way to handle large payloads. Proper pruning will be implemented later (DEBUG-2624)
    const line = Object.values(payload['debugger.snapshot'].captures.lines)[0]
    line.locals = {
      notCapturedReason: 'Snapshot was too large',
      size: Object.keys(line.locals).length
    }
    json = JSON.stringify(payload)
    size = Buffer.byteLength(json)
  }

  jsonBuffer.write(json, size)
  callbacks.push(cb)
}

function onFlush (payload) {
  const opts = {
    method: 'POST',
    url: config.url,
    path,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  }

  const _callbacks = callbacks
  callbacks = []

  request(payload, opts, (err) => {
    if (err) log.error('Could not send debugger payload', err)
    else _callbacks.forEach(cb => cb())
  })
}
