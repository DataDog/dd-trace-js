'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

// Channel for stream injection (similar to Winston's add-transport channel)
const addStreamCh = channel('ci:log-submission:bunyan:add-stream')

addHook({ name: 'bunyan', versions: ['>=1'] }, Logger => {
  const logCh = channel('apm:bunyan:log')
  shimmer.wrap(Logger.prototype, '_emit', emit => {
    return function wrappedEmit (rec) {
      if (logCh.hasSubscribers) {
        const payload = { message: rec }
        logCh.publish(payload)
        arguments[0] = payload.message
      }
      return emit.apply(this, arguments)
    }
  })

  return Logger
})

// Hook bunyan module to wrap createLogger
addHook({ name: 'bunyan', versions: ['>=1'] }, bunyan => {
  if (typeof bunyan.createLogger === 'function') {
    shimmer.wrap(bunyan, 'createLogger', originalCreateLogger => {
      return function wrappedCreateLogger (...args) {
        const logger = originalCreateLogger.apply(this, args)
        // Publish logger instance for stream injection (synchronous)
        if (addStreamCh.hasSubscribers) {
          addStreamCh.publish(logger)
        }
        return logger
      }
    })
  }

  return bunyan
})
