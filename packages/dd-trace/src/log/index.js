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

function processMsg (msg) {
  return typeof msg === 'function' ? msg() : msg
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

module.exports = log
