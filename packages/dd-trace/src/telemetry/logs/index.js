'use strict'

const dc = require('dc-polyfill')
const { sendData } = require('../send-data')
const formatError = require('./format-error')
const logCollector = require('./log-collector')

const telemetryLog = dc.channel('datadog:telemetry:log')
const errorLog = dc.channel('datadog:log:error')

let enabled = false

/**
 * Telemetry logs api defines only ERROR, WARN and DEBUG levels:
 * - WARN level is enabled by default
 * - DEBUG level will be possible to activate with an env var or telemetry config property
 *
 * @param {string | undefined} level
 * @returns {boolean}
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

function onErrorLog (error) {
  const telemetryLog = formatError(error)
  if (telemetryLog) onLog(telemetryLog)
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
    sendData(config, application, host, 'logs', { logs })
  }
}

module.exports = {
  start,
  stop,
  send,
}
