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
      errorChannel.channel.publish(message)
      return true
    })

    return this
  },

  debug (message) {
    if (debugChannel.channel.hasSubscribers) {
      debugChannel.channel.publish(processMsg(message))
    }
    return this
  },

  info (message) {
    if (infoChannel.channel.hasSubscribers) {
      infoChannel.channel.publish(processMsg(message))
    }
    return this
  },

  warn (message) {
    if (warnChannel.channel.hasSubscribers) {
      warnChannel.channel.publish(processMsg(message))
    }
    return this
  },

  error (err) {
    if (errorChannel.channel.hasSubscribers) {
      errorChannel.channel.publish(processMsg(err))
    }
    return this
  },

  deprecate (code, message) {
    return this._deprecate(code, message)
  }
}

log.reset()

module.exports = log
