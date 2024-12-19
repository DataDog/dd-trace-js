'use strict'

const { channel } = require('dc-polyfill')

const Level = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  critical: 50,
  off: 100
}

const traceChannel = channel('datadog:log:trace')
const debugChannel = channel('datadog:log:debug')
const infoChannel = channel('datadog:log:info')
const warnChannel = channel('datadog:log:warn')
const errorChannel = channel('datadog:log:error')

const defaultLevel = Level.debug

function getChannelLogLevel (level) {
  return level && typeof level === 'string'
    ? Level[level.toLowerCase().trim()] || defaultLevel
    : defaultLevel
}

class LogChannel {
  constructor (level) {
    this._level = getChannelLogLevel(level)
  }

  subscribe (logger) {
    if (Level.trace >= this._level) {
      traceChannel.subscribe(logger.trace)
    }
    if (Level.debug >= this._level) {
      debugChannel.subscribe(logger.debug)
    }
    if (Level.info >= this._level) {
      infoChannel.subscribe(logger.info)
    }
    if (Level.warn >= this._level) {
      warnChannel.subscribe(logger.warn)
    }
    if (Level.error >= this._level) {
      errorChannel.subscribe(logger.error)
    }
  }

  unsubscribe (logger) {
    if (traceChannel.hasSubscribers) {
      traceChannel.unsubscribe(logger.trace)
    }
    if (debugChannel.hasSubscribers) {
      debugChannel.unsubscribe(logger.debug)
    }
    if (infoChannel.hasSubscribers) {
      infoChannel.unsubscribe(logger.info)
    }
    if (warnChannel.hasSubscribers) {
      warnChannel.unsubscribe(logger.warn)
    }
    if (errorChannel.hasSubscribers) {
      errorChannel.unsubscribe(logger.error)
    }
  }
}

module.exports = {
  LogChannel,
  traceChannel,
  debugChannel,
  infoChannel,
  warnChannel,
  errorChannel
}
