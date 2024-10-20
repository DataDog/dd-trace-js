'use strict'

const { hostname: getHostname } = require('os')
const { stringify } = require('querystring')

const config = require('./config')
const request = require('../../exporters/common/request')
const { GIT_COMMIT_SHA, GIT_REPOSITORY_URL } = require('../../plugins/util/tags')

module.exports = send

const ddsource = 'dd_debugger'
const hostname = getHostname()
const service = config.service

const ddtags = [
  [GIT_COMMIT_SHA, config.commitSHA],
  [GIT_REPOSITORY_URL, config.repositoryUrl]
].map((pair) => pair.join(':')).join(',')

const path = `/debugger/v1/input?${stringify({ ddtags })}`

function send (message, logger, snapshot, cb) {
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
    'debugger.snapshot': snapshot
  }

  request(JSON.stringify(payload), opts, cb)
}
