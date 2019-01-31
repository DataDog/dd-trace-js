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

function createWrapGenLog (tracer, config) {
  return function wrapGenLog (genLog) {
    return function genLogWithTrace (z) {
      const log = genLog(z)

      return function logWithTrace (a, b, c, d, e, f, g, h, i, j, k) {
        const args = [a, b, c, d, e, f, g, h, i, j, k]

        if (!a) {
          args[0] = {}
        } else if (typeof a !== 'object') {
          args.unshift({})
        }

        tx.correlate(tracer, args[0])

        return log.apply(this, args)
      }
    }
  }
}

module.exports = [
  {
    name: 'pino',
    versions: ['>=5'],
    patch (pino, tracer, config) {
      if (!tracer._logInjection) return
      this.wrap(Object.getPrototypeOf(pino()), pino.symbols.writeSym, createWrapWrite(tracer, config))
    },
    unpatch (pino) {
      this.unwrap(Object.getPrototypeOf(pino()), pino.symbols.writeSym)
    }
  },
  {
    name: 'pino',
    versions: ['4'],
    file: 'lib/tools.js',
    patch (tools, tracer, config) {
      if (!tracer._logInjection) return
      this.wrap(tools, 'genLog', createWrapGenLog(tracer, config))
    },
    unpatch (tools) {
      this.unwrap(tools, 'genLog')
    }
  },
  {
    name: 'pino',
    versions: ['2 - 3'],
    patch (pino, tracer, config) {
      if (!tracer._logInjection) return
      this.wrap(Object.getPrototypeOf(pino()), 'asJson', createWrapWrite(tracer, config))
    },
    unpatch (pino) {
      this.unwrap(Object.getPrototypeOf(pino()), 'asJson')
    }
  }
]
