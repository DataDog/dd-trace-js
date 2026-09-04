'use strict'

const { hostname: getHostname } = require('os')
const { stringify } = require('querystring')

const { version } = require('../../../../../package.json')
const request = require('../../exporters/common/request')
const { DEBUGGER_DIAGNOSTICS_V1, DEBUGGER_INPUT_V2 } = require('../constants')
const { INCOMPLETE_REASON } = require('../guardrail-metrics')
const log = require('./log')
const JSONBuffer = require('./json-buffer')
const config = require('./config')
const guardrailMetrics = require('./guardrail-metrics')
const getRequestOptions = require('./request-options')
const { pruneSnapshot } = require('./snapshot-pruner')
const buildTags = require('./tags')

module.exports = send

const MAX_MESSAGE_LENGTH = 8 * 1024 // 8KB
const MAX_LOG_PAYLOAD_SIZE_MB = 1
const MAX_LOG_PAYLOAD_SIZE_BYTES = MAX_LOG_PAYLOAD_SIZE_MB * 1024 * 1024

const ddsource = 'dd_debugger'
const hostname = getHostname()
const service = config.service

const ddtags = buildTags(config, hostname, version, log)

let path
setInputPath(config.inputPath)

const jsonBuffer = new JSONBuffer({
  size: config.maxTotalPayloadSize,
  timeout: config.dynamicInstrumentation.uploadIntervalSeconds * 1000,
  onFlush,
})

/**
 * Queue a probe result for upload.
 *
 * @param {string} message - The evaluated log message
 * @param {object} logger - The logger metadata
 * @param {object | undefined} dd - The trace and span ids of the active trace, if any
 * @param {object} snapshot - The snapshot payload
 * @param {string | undefined} processTags - The serialized process tags, if enabled
 * @param {number} eventType - The guardrail event type, one of `EVENT_TYPE`
 * @param {number} incompleteReasons - Bitmask of `INCOMPLETE_REASON` flags enforced while capturing the snapshot
 */
function send (message, logger, dd, snapshot, processTags, eventType, incompleteReasons) {
  if (message?.length > MAX_MESSAGE_LENGTH) {
    message = message.slice(0, MAX_MESSAGE_LENGTH) + '…'
    incompleteReasons |= INCOMPLETE_REASON.STRING_LENGTH
  }

  const payload = {
    ddsource,
    hostname,
    service,
    message,
    logger,
    dd,
    process_tags: processTags,
    debugger: { snapshot },
  }

  let json = JSON.stringify(payload)
  let size = Buffer.byteLength(json)

  if (size > MAX_LOG_PAYLOAD_SIZE_BYTES) {
    incompleteReasons |= INCOMPLETE_REASON.PAYLOAD_TOO_LARGE
    let pruned
    try {
      pruned = pruneSnapshot(json, size, MAX_LOG_PAYLOAD_SIZE_BYTES)
    } catch (err) {
      log.error('[debugger:devtools_client] Error pruning snapshot', err)
    }

    if (pruned) {
      json = pruned
    } else {
      // Fallback if pruning fails
      const line = Object.keys(snapshot.captures.lines)[0]
      snapshot.captures.lines[line] = { pruned: true }
      json = JSON.stringify(payload)
    }
    size = Buffer.byteLength(json)
  }

  jsonBuffer.write(json, size)

  if (incompleteReasons !== 0) guardrailMetrics.captureIncomplete(incompleteReasons, eventType)
}

/**
 * @param {string} payload - The payload to send
 */
function onFlush (payload) {
  log.debug('[debugger:devtools_client] Flushing probe payload buffer')

  request(payload, buildRequestOptions(), (err, res, statusCode) => {
    if (!handleV2FallbackIfNeeded(statusCode, payload) && err) {
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

  request(payload, buildRequestOptions(), (err) => {
    if (err) {
      log.error('[debugger:devtools_client] Error sending probe payload after fallback to %s',
        DEBUGGER_DIAGNOSTICS_V1,
        err)
    }
  })

  return true
}

function buildRequestOptions () {
  return getRequestOptions(config, path, { 'Content-Type': 'application/json; charset=utf-8' })
}

/**
 * @param {string} newPath - The new debugger input path
 */
function setInputPath (newPath) {
  config.inputPath = newPath
  path = `${newPath}?${stringify({ ddtags })}`
}
