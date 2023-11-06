'use strict'

const dc = require('dc-polyfill')
const log = require('../../log')
const { calculateDDBasePath } = require('../../util')

const telemetryLog = dc.channel('datadog:telemetry:log')

const ddBasePath = calculateDDBasePath(__dirname)
const EOL = '\n'
const STACK_FRAME_LINE_REGEX = /^\s*at\s/gm

function sanitize (logEntry, stack) {
  if (!stack) return logEntry

  let stackLines = stack.split(EOL)

  const firstIndex = stackLines.findIndex(l => l.match(STACK_FRAME_LINE_REGEX))

  const isDDCode = firstIndex > -1 && stackLines[firstIndex].includes(ddBasePath)
  stackLines = stackLines
    .filter((line, index) => (isDDCode && index < firstIndex) || line.includes(ddBasePath))
    .map(line => line.replace(ddBasePath, ''))

  logEntry.stack_trace = stackLines.join(EOL)

  if (!isDDCode) {
    logEntry.message = 'omitted'
  }

  return logEntry
}

function getTelemetryLog (data, level) {
  try {
    data = typeof data === 'function' ? data() : data

    let message
    if (typeof data !== 'object' || !data) {
      message = String(data)
    } else {
      message = String(data.message || data)
    }

    let logEntry = {
      message,
      level
    }

    if (data.stack) {
      logEntry = sanitize(logEntry, data.stack)
      if (logEntry.stack_trace === '') {
        return
      }
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
