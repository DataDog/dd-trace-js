'use strict'

const tx = require('./util/log')

function createWrapWrite (tracer, config) {
  return function wrapWrite (write) {
    return function writeWithTrace (obj, msg, num) {
      arguments[0] = obj = obj || {}

      tx.correlate(tracer, obj)

      return write.apply(this, arguments)
    }
  }
}

module.exports = [
  {
    name: 'pino',
    versions: ['5'],
    patch (pino, tracer, config) {
      if (!config.correlate) return

      const logger = pino()

      this.wrap(Object.getPrototypeOf(logger), pino.symbols.writeSym, createWrapWrite(tracer, config))
    },
    unpatch (pino) {
      const logger = pino()

      this.unwrap(Object.getPrototypeOf(logger), pino.symbols.writeSym)
    }
  }
]
