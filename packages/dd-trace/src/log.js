'use strict'

const { Level, publishChannel, getChannelLogLevel } = require('./log_channels')
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
  _isLogLevelEnabled (level) {
    return getChannelLogLevel(level) >= this._logLevel
  },

  _publish (level, message) {
    if (this._isLogLevelEnabled(level)) {
      publishChannel(level, message)
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
      publishChannel(Level.Error, message)
      return true
    })

    return this
  },

  debug (message) {
    return this._publish(Level.Debug, message)
  },

  info (message) {
    return this._publish(Level.Info, message)
  },

  warn (message) {
    return this._publish(Level.Warn, message)
  },

  error (err) {
    return this._publish(Level.Error, err)
  },

  // this method is used?
  deprecate (code, message) {
    return this._deprecate(code, message)
  }
}

log.reset()

module.exports = log
