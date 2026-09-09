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
  // The record must be replaceable before Bunyan emits it, while the serialized line is only available afterward.
  // This before-and-after contract requires the existing runtime wrapper rather than an Orchestrion subscriber.
  shimmer.wrap(Logger.prototype, '_emit', emit => {
    return function wrappedEmit (rec) {
      if (logCh.hasSubscribers) {
        const payload = { message: rec }
        logCh.publish(payload)
        rec = arguments[0] = payload.message
      }

      // Reuse Bunyan's cycle-safe serialization instead of serializing the record again.
      const line = emit.apply(this, arguments)
      if (logSubmissionCh?.hasSubscribers && logCh.hasSubscribers && !arguments[1]) {
        logSubmissionCh.publish({ source: id, message: line ?? rec })
      }
      return line
    }
  })
}
