'use strict'

const { getChannelLogLevel, debugChannel, infoChannel, warnChannel, errorChannel } = require('./log_channels')
const logWriter = require('./log_writer')

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

const log = {
  _isLogLevelEnabled (logLevel) {
    return logLevel >= this._logLevel
  },

  _publish (logChannel, message) {
    if (this._isLogLevelEnabled(logChannel.logLevel)) {
      logChannel.publish(message)
    }
    return this
  },

  use (logger) {
    logWriter.use(logger)
    return this
  },

  toggle (enabled, logLevel) {
    this._logLevel = getChannelLogLevel(logLevel)
    logWriter.toogle(enabled)
    return this
  },

  reset () {
    this._logLevel = getChannelLogLevel()
    logWriter.reset()
    this._deprecate = memoize((code, message) => {
      this._publish(errorChannel, message)
      return true
    })

    return this
  },

  debug (message) {
    return this._publish(debugChannel, message)
  },

  info (message) {
    return this._publish(infoChannel, message)
  },

  warn (message) {
    return this._publish(warnChannel, message)
  },

  error (err) {
    return this._publish(errorChannel, err)
  },

  // this method is used?
  deprecate (code, message) {
    return this._deprecate(code, message)
  }
}

log.reset()

module.exports = log
