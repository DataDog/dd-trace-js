'use strict'

const { LOG } = require('../../../ext/formats')

function createWrapPino (tracer, config) {
  return function wrapPino (pino) {
    return function pinoWithTrace () {
      const instance = pino.apply(this, arguments)
      const asJsonSym = (pino.symbols && pino.symbols.asJsonSym) || 'asJson'

      Object.defineProperty(instance, asJsonSym, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: createWrapAsJson(tracer, config)(instance[asJsonSym])
      })

      return instance
    }
  }
}

function createWrapAsJson (tracer, config) {
  return function wrapAsJson (asJson) {
    return function asJsonWithTrace (obj, msg, num, time) {
      const span = tracer.scope().active()

      obj = arguments[0] = obj || {}

      tracer.inject(span, LOG, obj)

      const json = asJson.apply(this, arguments)

      obj && delete obj.dd

      return json
    }
  }
}

module.exports = [
  {
    name: 'pino',
    versions: ['2 - 3', '4', '>=5'],
    patch (pino, tracer, config) {
      if (!tracer._logInjection) return
      return this.wrapExport(pino, createWrapPino(tracer, config)(pino))
    },
    unpatch (pino) {
      return this.unwrapExport(pino)
    }
  }
]
