'use strict'

const dc = require('dc-polyfill')
const logCollector = require('./log-collector')
const { sendData } = require('../send-data')

const telemetryLog = dc.channel('datadog:telemetry:log')
const errorLog = dc.channel('datadog:log:error')

let enabled = false

/**
 * Telemetry logs api defines only ERROR, WARN and DEBUG levels:
 * - WARN level is enabled by default
 * - DEBUG level will be possible to activate with an env var or telemetry config property
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
  const { message, cause } = msg
  if (!message && !cause) return

  const telLog = {
    level: 'ERROR',
    count: 1,

    // existing log.error(err) without message will be reported as 'Generic Error'
    message: message ?? 'Generic Error'
  }

  if (cause) {
    telLog.stack_trace = cause.stack
    telLog.errorType = cause.constructor.name
  }

  onLog(telLog)
}

function start (config) {
  if (!config.telemetry.logCollection || enabled) return

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
  send
}
