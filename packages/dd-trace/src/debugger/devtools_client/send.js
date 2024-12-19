'use strict'

const { hostname: getHostname } = require('os')
const { stringify } = require('querystring')

const config = require('./config')
const request = require('../../exporters/common/request')
const { GIT_COMMIT_SHA, GIT_REPOSITORY_URL } = require('../../plugins/util/tags')

module.exports = send

const MAX_PAYLOAD_SIZE = 1024 * 1024 // 1MB

const ddsource = 'dd_debugger'
const hostname = getHostname()
const service = config.service

const ddtags = [
  [GIT_COMMIT_SHA, config.commitSHA],
  [GIT_REPOSITORY_URL, config.repositoryUrl]
].map((pair) => pair.join(':')).join(',')

const path = `/debugger/v1/input?${stringify({ ddtags })}`

function send (message, logger, dd, snapshot, cb) {
  const opts = {
    method: 'POST',
    url: config.url,
    path,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  }

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

  if (Buffer.byteLength(json) > MAX_PAYLOAD_SIZE) {
    // TODO: This is a very crude way to handle large payloads. Proper pruning will be implemented later (DEBUG-2624)
    const line = Object.values(payload['debugger.snapshot'].captures.lines)[0]
    line.locals = {
      notCapturedReason: 'Snapshot was too large',
      size: Object.keys(line.locals).length
    }
    json = JSON.stringify(payload)
  }

  request(json, opts, cb)
}
