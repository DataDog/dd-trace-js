'use strict'

const dc = require('dc-polyfill')
const log = require('../../log')

const telemetryLog = dc.channel('datadog:telemetry:log')

function getTelemetryLog (data, level) {
  try {
    data = typeof data === 'function' ? data() : data

    let message
    if (typeof data !== 'object' || !data) {
      message = String(data)
    } else {
      message = String(data.message || data)
    }

    const logEntry = {
      message,
      level
    }
    if (data.stack) {
      logEntry.stack_trace = data.stack
    }
    return logEntry
  } catch (e) {
    log.error(e)
  }
}

const iastLog = {
  debug (data) {
    log.debug(data)
    return this
  },

  info (data) {
    log.info(data)
    return this
  },

  warn (data) {
    log.warn(data)
    return this
  },

  error (data) {
    log.error(data)
    return this
  },

  publish (data, level) {
    if (telemetryLog.hasSubscribers) {
      telemetryLog.publish(getTelemetryLog(data, level))
    }
    return this
  },

  debugAndPublish (data) {
    this.debug(data)
    return this.publish(data, 'DEBUG')
  },

  /**
   * forward 'INFO' log level to 'DEBUG' telemetry log level
   * see also {@link ../../telemetry/logs#isLevelEnabled } method
   */
  infoAndPublish (data) {
    this.info(data)
    return this.publish(data, 'DEBUG')
  },

  warnAndPublish (data) {
    this.warn(data)
    return this.publish(data, 'WARN')
  },

  errorAndPublish (data) {
    this.error(data)
    return this.publish(data, 'ERROR')
  }
}

module.exports = iastLog
