'use strict'

const { hostname: getHostname } = require('os')
const { stringify } = require('querystring')

const { version } = require('../../../../../package.json')
const request = require('../../exporters/common/request')
const { GIT_COMMIT_SHA, GIT_REPOSITORY_URL } = require('../../plugins/util/tags')
const { getValueFromEnvSources } = require('../../config/helper')
const { DEBUGGER_DIAGNOSTICS_V1, DEBUGGER_INPUT_V2 } = require('../constants')
const log = require('./log')
const JSONBuffer = require('./json-buffer')
const config = require('./config')
const { pruneSnapshot } = require('./snapshot-pruner')

module.exports = send

const MAX_MESSAGE_LENGTH = 8 * 1024 // 8KB
const MAX_LOG_PAYLOAD_SIZE_MB = 1
const MAX_LOG_PAYLOAD_SIZE_BYTES = MAX_LOG_PAYLOAD_SIZE_MB * 1024 * 1024

const ddsource = 'dd_debugger'
const hostname = getHostname()
const service = config.service

const ddtags = [
  ['env', getValueFromEnvSources('DD_ENV')],
  ['version', getValueFromEnvSources('DD_VERSION')],
  ['debugger_version', version],
  ['host_name', hostname],
  [GIT_COMMIT_SHA, config.commitSHA],
  [GIT_REPOSITORY_URL, config.repositoryUrl],
].filter(([, value]) => value !== undefined).map((pair) => pair.join(':')).join(',')

let path
setInputPath(config.inputPath)

const jsonBuffer = new JSONBuffer({
  size: config.maxTotalPayloadSize,
  timeout: config.dynamicInstrumentation.uploadIntervalSeconds * 1000,
  onFlush,
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
    debugger: { snapshot },
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

/**
 * @param {string} payload - The payload to send
 */
function onFlush (payload) {
  log.debug('[debugger:devtools_client] Flushing probe payload buffer')

  request(payload, buildRequestOpts(), (err, res, statusCode) => {
    if (handleV2FallbackIfNeeded(statusCode, payload)) {
      return
    }

    if (err) {
      log.error('[debugger:devtools_client] Error sending probe payload', err)
    }
  })
}

/**
 * @param {number} statusCode - The status code of the response
 * @param {string} payload - The payload to send
 * @returns {boolean} True if the fallback was needed, false otherwise
 */
function handleV2FallbackIfNeeded (statusCode, payload) {
  if (statusCode !== 404 || config.inputPath !== DEBUGGER_INPUT_V2) {
    return false
  }

  log.warn('[debugger:devtools_client] Received 404 from %s, falling back to %s',
    DEBUGGER_INPUT_V2,
    DEBUGGER_DIAGNOSTICS_V1)

  setInputPath(DEBUGGER_DIAGNOSTICS_V1)

  request(payload, buildRequestOpts(), (err) => {
    if (err) {
      log.error('[debugger:devtools_client] Error sending probe payload after fallback to %s',
        DEBUGGER_DIAGNOSTICS_V1,
        err)
    }
  })

  return true
}

function buildRequestOpts () {
  return {
    method: 'POST',
    url: config.url,
    path,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  }
}

/**
 * @param {string} newPath - The new debugger input path
 */
function setInputPath (newPath) {
  config.inputPath = newPath
  path = `${newPath}?${stringify({ ddtags })}`
}
