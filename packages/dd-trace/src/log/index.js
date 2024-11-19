'use strict'

const coalesce = require('koalas')
const { isTrue } = require('../util')
const { debugChannel, infoChannel, warnChannel, errorChannel } = require('./channels')
const logWriter = require('./writer')
const { Log } = require('./log')

const memoize = func => {
  const cache = {}
  const memoized = function (key) {
    if (!cache[key]) {
      cache[key] = func.apply(this, arguments)
    }

    return cache[key]
  }

  return memoized
}

const config = {
  enabled: false,
  logger: undefined,
  logLevel: 'debug'
}

const log = {
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

  deprecate (code, message) {
    return this._deprecate(code, message)
  }
}

log.reset()

const enabled = isTrue(coalesce(
  process.env.DD_TRACE_DEBUG,
  process.env.OTEL_LOG_LEVEL === 'debug',
  config.enabled
))

const logLevel = coalesce(
  process.env.DD_TRACE_LOG_LEVEL,
  process.env.OTEL_LOG_LEVEL,
  config.logLevel
)

log.toggle(enabled, logLevel)

module.exports = log
