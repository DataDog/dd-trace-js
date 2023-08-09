'use strict'

const dc = require('../../../../../../diagnostics_channel')
const logCollector = require('./log-collector')
const { sendData } = require('../../../../telemetry/send-data')
const log = require('../../../../log')

const telemetryStartChannel = dc.channel('datadog:telemetry:start')
const telemetryStopChannel = dc.channel('datadog:telemetry:stop')

let config, application, host, interval

function publish (log) {
  if (log && isLevelEnabled(log.level)) {
    logCollector.add(log)
  }
}

function sendLogs () {
  try {
    const logs = logCollector.drain()
    if (logs) {
      sendData(config, application, host, 'logs', logs)
    }
  } catch (e) {
    log.error(e)
  }
}

function isLevelEnabled (level) {
  return isLogCollectionEnabled(config) && level !== 'DEBUG'
}

function isLogCollectionEnabled (config) {
  return config && config.telemetry && config.telemetry.logCollection
}

function onTelemetryStart (msg) {
  if (!msg || !isLogCollectionEnabled(msg.config)) {
    log.info('IAST telemetry logs start event received but log collection is not enabled or configuration is incorrect')
    return false
  }

  log.info('IAST telemetry logs starting')

  config = msg.config
  application = msg.application
  host = msg.host

  if (msg.heartbeatInterval) {
    interval = setInterval(sendLogs, msg.heartbeatInterval)
    interval.unref()
  }

  return true
}

function onTelemetryStop () {
  stop()
}

function start () {
  telemetryStartChannel.subscribe(onTelemetryStart)
  telemetryStopChannel.subscribe(onTelemetryStop)
}

function stop () {
  if (!isLogCollectionEnabled(config)) return

  log.info('IAST telemetry logs stopping')

  config = null
  application = null
  host = null

  if (telemetryStartChannel.hasSubscribers) {
    telemetryStartChannel.unsubscribe(onTelemetryStart)
  }

  if (telemetryStopChannel.hasSubscribers) {
    telemetryStopChannel.unsubscribe(onTelemetryStop)
  }

  clearInterval(interval)
}

module.exports = { start, stop, publish, isLevelEnabled }
