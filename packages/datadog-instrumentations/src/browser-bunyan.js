'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

addHook({ name: 'browser-bunyan', versions: ['>=1'] }, def => {
  const logCh = channel('apm:browser-bunyan:log')
  shimmer.wrap(def.Logger.prototype, '_emit', emit => {
    return function wrappedEmit (rec) {
      if (logCh.hasSubscribers) {
        const payload = { message: rec }
        logCh.publish(payload)
        arguments[0] = payload.message
      }
      return emit.apply(this, arguments)
    }
  })
  return def
})
