'use strict'

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

const log = {
  use (logger) {
    logWriter.use(logger)
    return this
  },

  toggle (enabled, logLevel) {
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
    debugChannel.publish(message)
    return this
  },

  info (message) {
    infoChannel.publish(message)
    return this
  },

  warn (message) {
    warnChannel.publish(message)
    return this
  },

  error (err) {
    errorChannel.publish(err)
    return this
  },

  // is this method used?
  deprecate (code, message) {
    return this._deprecate(code, message)
  }
}

log.reset()

module.exports = log
