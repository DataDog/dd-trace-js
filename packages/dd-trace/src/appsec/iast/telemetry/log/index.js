'use strict'

const logCollector = require('./log-collector')
const { sendData } = require('../../../../telemetry/send-data')
const log = require('../../../../log')
const { createAppObject, createHostObject } = require('../../../../telemetry')

let enabled = false
let debugLevelEnabled = false

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
  return enabled && (level !== 'DEBUG' || debugLevelEnabled)
}

function isLogCollectionEnabled (config) {
  return config?.telemetry &&
    config.telemetry.enabled &&
    config.telemetry.logCollection
}

function start (aConfig, debug = false) {
  if (!isLogCollectionEnabled(aConfig)) {
    return
  }

  log.debug('IAST telemetry logs starting')

  enabled = true
  debugLevelEnabled = debug
  config = aConfig
  application = createAppObject(config)
  host = createHostObject()

  if (interval) {
    clearInterval(interval)
  }

  const heartbeatInterval = config.telemetry.heartbeatInterval
  if (heartbeatInterval) {
    interval = setInterval(sendLogs, heartbeatInterval)
    interval.unref()
  }
}

function stop () {
  log.debug('IAST telemetry logs stopping')

  enabled = false
  debugLevelEnabled = false
  config = null
  application = null
  host = null

  if (interval) {
    clearInterval(interval)
  }
}

module.exports = {
  start,
  stop,
  publish,
  isLevelEnabled
}
