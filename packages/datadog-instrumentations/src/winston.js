'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const patched = new WeakSet()

// Test Visibility log submission channels
const configureCh = channel('ci:log-submission:winston:configure')
const addTransport = channel('ci:log-submission:winston:add-transport')

addHook({ name: 'winston', file: 'lib/winston/transports/index.js', versions: ['>=3'] }, transportsPackage => {
  if (configureCh.hasSubscribers) {
    configureCh.publish(transportsPackage.Http)
  }

  return transportsPackage
})

addHook({ name: 'winston', file: 'lib/winston/logger.js', versions: ['>=3'] }, Logger => {
  const logCh = channel('apm:winston:log')
  shimmer.wrap(Logger.prototype, 'write', write => {
    return function wrappedWrite (chunk, enc, cb) {
      if (logCh.hasSubscribers) {
        const payload = { message: chunk }
        logCh.publish(payload)
        arguments[0] = payload.message
      }
      return write.apply(this, arguments)
    }
  })

  shimmer.wrap(Logger.prototype, 'configure', configure => function () {
    const configureResponse = configure.apply(this, arguments)
    // After the original `configure`, because it resets transports
    if (addTransport.hasSubscribers) {
      addTransport.publish(this)
    }
    return configureResponse
  })

  return Logger
})

addHook({ name: 'winston', file: 'lib/winston/logger.js', versions: ['1', '2'] }, logger => {
  const logCh = channel('apm:winston:log')
  if (logger.Logger.prototype.configure) {
    shimmer.wrap(logger.Logger.prototype, 'configure', configure => wrapMethod(configure, logCh))
  }
  shimmer.wrap(logger.Logger.prototype, 'add', configure => wrapMethod(configure, logCh))
  return logger
})

function wrapMethod (method, logCh) {
  return function methodWithTrace () {
    const result = method.apply(this, arguments)

    if (logCh.hasSubscribers) {
      for (const name in this.transports) {
        const transport = this.transports[name]

        if (patched.has(transport) || typeof transport.log !== 'function') continue

        shimmer.wrap(transport, 'log', log => function wrappedLog (level, msg, meta, callback) {
          const payload = { message: meta || {} }
          logCh.publish(payload)
          arguments[2] = payload.message
          log.apply(this, arguments)
        })
        patched.add(transport)
      }
    }
    return result
  }
}
