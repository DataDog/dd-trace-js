'use strict'

const shimmer = require('../../../datadog-shimmer')
const { channel } = require('./instrument')

/**
 * @param {{ prototype: object }} Logger
 * @param {string} id
 */
module.exports = function wrapLogger (Logger, id) {
  const logCh = channel(`apm:${id}:log`)
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
}
