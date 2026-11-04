'use strict'

const dc = require('dc-polyfill')
const { sendData } = require('../send-data')
const logCollector = require('./log-collector')

const telemetryLog = dc.channel('datadog:telemetry:log')
const errorLog = dc.channel('datadog:log:error:record')

/**
 * @typedef {object} TelemetryLogOptions
 * @property {string} [tags] Default tags appended to every outgoing log.
 */

let logOptions
let enabled = false

/**
 * Telemetry logs api defines only ERROR, WARN and DEBUG levels:
 * - WARN level is enabled by default
 * - DEBUG level will be possible to activate with an env var or telemetry config property
 *
 * @param {string | undefined} level
 */
function isLevelEnabled (level) {
  return isValidLevel(level)
}

function isValidLevel (level) {
  switch (level) {
    case 'ERROR':
    case 'WARN':
      return true
    default:
      return false
  }
}

function onLog (log) {
  if (isLevelEnabled(log?.level?.toUpperCase())) {
    logCollector.add(log)
  }
}

function onErrorLog (msg) {
  const { message, cause, sendViaTelemetry } = msg
  if (!sendViaTelemetry || (!message && !cause)) return

  const telLog = {
    level: 'ERROR',
    count: 1,

    // existing log.error(err) without message will be reported as 'Generic Error'
    message: message || 'Generic Error',
  }

  if (cause) {
    try {
      telLog.stack_trace = cause.stack
    } catch {
      return
    }
    telLog.errorType = getErrorType(cause)
  }

  onLog(telLog)
}

function getErrorType (cause) {
  try {
    return cause.constructor?.name || 'Error'
  } catch {
    return 'Error'
  }
}

/**
 * @param {import('../../config/config-base')} config
 * @param {TelemetryLogOptions} [options]
 */
function start (config, options) {
  if (!config.telemetry.DD_TELEMETRY_LOG_COLLECTION_ENABLED || enabled) return

  enabled = true
  logOptions = options

  telemetryLog.subscribe(onLog)

  errorLog.subscribe(onErrorLog)
}

function stop () {
  enabled = false
  logOptions = undefined

  if (telemetryLog.hasSubscribers) {
    telemetryLog.unsubscribe(onLog)
  }

  errorLog.unsubscribe(onErrorLog)
}

function send (config, application, host) {
  if (!enabled) return

  let logs = logCollector.drain()
  if (logs) {
    const tags = logOptions?.tags
    if (tags) {
      logs = logs.map(entry => ({
        ...entry,
        tags: entry.tags ? `${entry.tags},${tags}` : tags,
      }))
    }
    sendData(config, application, host, 'logs', { logs })
  }
}

module.exports = {
  start,
  stop,
  send,
}
