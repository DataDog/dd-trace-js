'use strict'

const dc = require('dc-polyfill')
const { sendData } = require('../send-data')
const logCollector = require('./log-collector')

const telemetryLog = dc.channel('datadog:telemetry:log')
const errorLog = dc.channel('datadog:log:error:record')

const TEST_OPTIMIZATION_ERROR_CODES = new Set([
  'ERR_DD_TEST_OPTIMIZATION_QUEUE_FULL',
  'ERR_DD_TEST_OPTIMIZATION_BACKPRESSURE_TIMEOUT',
  'ERR_DD_TEST_OPTIMIZATION_REQUEST_TIMEOUT',
  'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT',
])

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
    try {
      const code = cause.code
      if (TEST_OPTIMIZATION_ERROR_CODES.has(code)) telLog.tags = `error_code:${code}`
    } catch {
      // Error-like causes may expose unreadable properties.
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

function start (config) {
  if (!config.telemetry.DD_TELEMETRY_LOG_COLLECTION_ENABLED || enabled) return

  enabled = true

  telemetryLog.subscribe(onLog)

  errorLog.subscribe(onErrorLog)
}

function stop () {
  enabled = false

  if (telemetryLog.hasSubscribers) {
    telemetryLog.unsubscribe(onLog)
  }

  errorLog.unsubscribe(onErrorLog)
}

function send (config, application, host) {
  if (!enabled) return

  const logs = logCollector.drain()
  if (logs) {
    if (config.isCiVisibility) {
      for (const entry of logs) {
        entry.tags = entry.tags
          ? `${entry.tags},test_optimization_enabled:true`
          : 'test_optimization_enabled:true'
      }
    }
    sendData(config, application, host, 'logs', { logs })
  }
}

module.exports = {
  start,
  stop,
  send,
}
