'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

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
