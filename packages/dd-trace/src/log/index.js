'use strict'

const coalesce = require('koalas')
const { isTrue } = require('../util')
const { debugChannel, infoChannel, warnChannel, errorChannel } = require('./channels')
const logWriter = require('./writer')

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

function processMsg (msg) {
  return typeof msg === 'function' ? msg() : msg
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
    return Object.freeze({ ...config })
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
      errorChannel.publish(message)
      return true
    })

    return this
  },

  debug (message) {
    if (debugChannel.hasSubscribers) {
      debugChannel.publish(processMsg(message))
    }
    return this
  },

  info (message) {
    if (infoChannel.hasSubscribers) {
      infoChannel.publish(processMsg(message))
    }
    return this
  },

  warn (message) {
    if (warnChannel.hasSubscribers) {
      warnChannel.publish(processMsg(message))
    }
    return this
  },

  error (err) {
    if (errorChannel.hasSubscribers) {
      errorChannel.publish(processMsg(err))
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
