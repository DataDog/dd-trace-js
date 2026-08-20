'use strict'

const shimmer = require('../../../datadog-shimmer')
const { channel } = require('./instrument')

/**
 * @param {{ prototype: object }} Logger
 * @param {string} id
 * @param {import('node:diagnostics_channel').Channel} [logSubmissionCh]
 */
module.exports = function wrapLogger (Logger, id, logSubmissionCh) {
  const logCh = channel(`apm:${id}:log`)
  shimmer.wrap(Logger.prototype, '_emit', emit => {
    return function wrappedEmit (rec) {
      if (logCh.hasSubscribers) {
        const payload = { message: rec }
        logCh.publish(payload)
        rec = arguments[0] = payload.message
      }

      const line = emit.apply(this, arguments)
      if (logSubmissionCh?.hasSubscribers && logCh.hasSubscribers && !arguments[1]) {
        logSubmissionCh.publish({ source: id, message: line ?? rec })
      }
      return line
    }
  })
}
