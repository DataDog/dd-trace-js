'use strict'

const { LOG } = require('../../../ext/formats')

function createWrapEmit (tracer, config) {
  return function wrapEmit (emit) {
    return function emitWithTrace (rec, noemit) {
      const span = tracer.scope().active()

      tracer.inject(span, LOG, rec)

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
