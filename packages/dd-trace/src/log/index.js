'use strict'
const { inspect } = require('util')
const { isTrue } = require('../util')
const { traceChannel, debugChannel, infoChannel, warnChannel, errorChannel } = require('./channels')
const logWriter = require('./writer')
const { Log, LogConfig, NoTransmitError } = require('./log')
const { memoize } = require('./utils')
const { getEnvironmentVariable } = require('../config-helper')

const config = {
  enabled: false,
  logger: undefined,
  logLevel: 'debug'
}

// in most places where we know we want to mute a log we use log.error() directly
const NO_TRANSMIT = new LogConfig(false)

const log = {
  LogConfig,
  NO_TRANSMIT,
  NoTransmitError,

  /**
   * @returns Read-only version of logging config. To modify config, call `log.use` and `log.toggle`
   */
  getConfig () {
    return { ...config }
  },

  use (logger) {
    config.logger = logger
    logWriter.use(logger)
    return this
  },

  toggle (enabled, logLevel) {
    config.enabled = enabled
    config.logLevel = logLevel
    logWriter.toggle(enabled, logLevel)
    return this
  },

  reset () {
    logWriter.reset()
    this._deprecate = memoize((code, message) => {
      errorChannel.publish(Log.parse(message))
      return true
    })

    return this
  },

  trace (...args) {
    if (traceChannel.hasSubscribers) {
      const logRecord = {}

      Error.captureStackTrace(logRecord, this.trace)

      const stack = logRecord.stack.split('\n')
      const fn = stack[1].replace(/^\s+at ([^\s]+) .+/, '$1')
      const options = { depth: 2, breakLength: Infinity, compact: true, maxArrayLength: Infinity }
      const params = args.map(a => inspect(a, options)).join(', ')

      stack[0] = `Trace: ${fn}(${params})`

      traceChannel.publish(Log.parse(stack.join('\n')))
    }
    return this
  },

  debug (...args) {
    if (debugChannel.hasSubscribers) {
      debugChannel.publish(Log.parse(...args))
    }
    return this
  },

  info (...args) {
    if (infoChannel.hasSubscribers) {
      infoChannel.publish(Log.parse(...args))
    }
    return this
  },

  warn (...args) {
    if (warnChannel.hasSubscribers) {
      warnChannel.publish(Log.parse(...args))
    }
    return this
  },

  error (...args) {
    if (errorChannel.hasSubscribers) {
      errorChannel.publish(Log.parse(...args))
    }
    return this
  },

  errorWithoutTelemetry (...args) {
    args.push(NO_TRANSMIT)
    if (errorChannel.hasSubscribers) {
      errorChannel.publish(Log.parse(...args))
    }
    return this
  },

  deprecate (code, message) {
    return this._deprecate(code, message)
  },

  isEnabled (fleetStableConfigValue, localStableConfigValue) {
    return isTrue(
      fleetStableConfigValue ??
      getEnvironmentVariable('DD_TRACE_DEBUG') ??
      (getEnvironmentVariable('OTEL_LOG_LEVEL') === 'debug' || undefined) ??
      localStableConfigValue ??
      config.enabled
    )
  },

  getLogLevel (
    optionsValue,
    fleetStableConfigValue,
    localStableConfigValue
  ) {
    return optionsValue ??
      fleetStableConfigValue ??
      getEnvironmentVariable('DD_TRACE_LOG_LEVEL') ??
      getEnvironmentVariable('OTEL_LOG_LEVEL') ??
      localStableConfigValue ??
      config.logLevel
  }
}

logWriter.setStackTraceLimitFunction(log.error)

log.reset()

log.toggle(log.isEnabled(), log.getLogLevel())

module.exports = log
