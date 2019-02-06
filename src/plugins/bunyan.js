'use strict'

const tx = require('./util/log')

function createWrapEmit (tracer, config) {
  return function wrapEmit (emit) {
    return function emitWithTrace (rec, noemit) {
      tx.correlate(tracer, rec)

      return emit.apply(this, arguments)
    }
  }
}

module.exports = {
  name: 'bunyan',
  versions: ['>=1'],
  patch (Logger, tracer, config) {
    if (!tracer._logInjection) return
    this.wrap(Logger.prototype, '_emit', createWrapEmit(tracer, config))
  },
  unpatch (Logger) {
    this.unwrap(Logger.prototype, '_emit')
  }
}
