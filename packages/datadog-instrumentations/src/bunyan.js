'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const logSubmissionCh = channel('ci:log-submission:log')

addHook({ name: 'bunyan', versions: ['>=1'] }, Logger => {
  const logCh = channel('apm:bunyan:log')
  shimmer.wrap(Logger.prototype, '_emit', emit => {
    return function wrappedEmit (rec) {
      if (logCh.hasSubscribers) {
        const payload = { message: rec }
        logCh.publish(payload)
        rec = arguments[0] = payload.message
      }

      const line = emit.apply(this, arguments)
      if (logSubmissionCh.hasSubscribers && !arguments[1]) {
        logSubmissionCh.publish({ source: 'bunyan', message: line ?? rec })
      }
      return line
    }
  })
  return Logger
})
