'use strict'

const { hostname: getHostname } = require('os')
const { stringify } = require('querystring')

const config = require('./config')
const JSONBuffer = require('./json-buffer')
const request = require('../../exporters/common/request')
const { GIT_COMMIT_SHA, GIT_REPOSITORY_URL } = require('../../plugins/util/tags')
const log = require('./log')
const { version } = require('../../../../../package.json')
const { getEnvironmentVariable } = require('../../config-helper')
const { pruneSnapshot } = require('./snapshot-pruner')

module.exports = send

const MAX_MESSAGE_LENGTH = 8 * 1024 // 8KB
const MAX_LOG_PAYLOAD_SIZE_MB = 1
const MAX_LOG_PAYLOAD_SIZE_BYTES = MAX_LOG_PAYLOAD_SIZE_MB * 1024 * 1024

const ddsource = 'dd_debugger'
const hostname = getHostname()
const service = config.service

const ddtags = [
  ['env', getEnvironmentVariable('DD_ENV')],
  ['version', getEnvironmentVariable('DD_VERSION')],
  ['debugger_version', version],
  ['host_name', hostname],
  [GIT_COMMIT_SHA, config.commitSHA],
  [GIT_REPOSITORY_URL, config.repositoryUrl]
].filter(([, value]) => value !== undefined).map((pair) => pair.join(':')).join(',')

const path = `/debugger/v1/input?${stringify({ ddtags })}`

const jsonBuffer = new JSONBuffer({
  size: config.maxTotalPayloadSize,
  timeout: config.dynamicInstrumentation.uploadIntervalSeconds * 1000,
  onFlush
})

function send (message, logger, dd, snapshot) {
  const payload = {
    ddsource,
    hostname,
    service,
    message: message?.length > MAX_MESSAGE_LENGTH
      ? message.slice(0, MAX_MESSAGE_LENGTH) + '…'
      : message,
    logger,
    dd,
    debugger: { snapshot }
  }

  let json = JSON.stringify(payload)
  let size = Buffer.byteLength(json)

  if (size > MAX_LOG_PAYLOAD_SIZE_BYTES) {
    let pruned
    try {
      pruned = pruneSnapshot(json, size, MAX_LOG_PAYLOAD_SIZE_BYTES)
    } catch (err) {
      log.error('[debugger:devtools_client] Error pruning snapshot', err)
    }

    if (pruned) {
      json = pruned
      size = Buffer.byteLength(json)
    } else {
      // Fallback if pruning fails
      const line = Object.keys(snapshot.captures.lines)[0]
      snapshot.captures.lines[line] = { pruned: true }
      json = JSON.stringify(payload)
      size = Buffer.byteLength(json)
    }
  }

  jsonBuffer.write(json, size)
}

function onFlush (payload) {
  log.debug('[debugger:devtools_client] Flushing probe payload buffer')

  const opts = {
    method: 'POST',
    url: config.url,
    path,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  }

  request(payload, opts, (err) => {
    if (err) log.error('[debugger:devtools_client] Error sending probe payload', err)
  })
}
