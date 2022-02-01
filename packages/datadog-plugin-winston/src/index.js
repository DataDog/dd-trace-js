'use strict'

const { LOG } = require('../../../ext/formats')

function createWrapWrite (tracer, config) {
  return function wrapWrite (write) {
    return function writeWithTrace (chunk, encoding, callback) {
      const span = tracer.scope().active()

      let newChunk
      if (chunk instanceof Error) {
        newChunk = new chunk.constructor(chunk.message)
        newChunk.stack = chunk.stack
      } else {
        newChunk = {}
      }

      arguments[0] = Object.assign(newChunk, chunk)

      tracer.inject(span, LOG, newChunk)

      return write.apply(this, arguments)
    }
  }
}

function createWrapMethod (tracer, config) {
  return function wrapMethod (method) {
    return function methodWithTrace () {
      const result = method.apply(this, arguments)

      for (const name in this.transports) {
        const transport = this.transports[name]

        if (transport._dd_patched || typeof transport.log !== 'function') continue

        transport.log = createWrapLog(tracer, config)(transport.log)
        transport._dd_patched = true
      }

      return result
    }
  }
}

function createWrapLog (tracer, config) {
  return function wrapLog (log) {
    return function logWithTrace (level, msg, meta, callback) {
      const span = tracer.scope().active()

      meta = meta || {}

      let newMeta
      if (meta instanceof Error) {
        newMeta = new meta.constructor(meta.message)
        newMeta.stack = meta.stack
      } else {
        newMeta = {}
      }

      arguments[2] = Object.assign(newMeta, meta)

      tracer.inject(span, LOG, newMeta)

      return log.apply(this, arguments)
    }
  }
}

module.exports = [
  {
    name: 'winston',
    file: 'lib/winston/logger.js',
    versions: ['>=3'],
    patch (Logger, tracer, config) {
      if (!tracer._logInjection) return
      this.wrap(Logger.prototype, 'write', createWrapWrite(tracer, config))
    },
    unpatch (Logger) {
      this.unwrap(Logger.prototype, 'write')
    }
  },
  {
    name: 'winston',
    file: 'lib/winston/logger.js',
    versions: ['2'],
    patch (logger, tracer, config) {
      if (!tracer._logInjection) return
      this.wrap(logger.Logger.prototype, 'configure', createWrapMethod(tracer, config))
      this.wrap(logger.Logger.prototype, 'add', createWrapMethod(tracer, config))
    },
    unpatch (logger) {
      this.unwrap(logger.Logger.prototype, 'configure')
      this.unwrap(logger.Logger.prototype, 'add')
    }
  },
  {
    name: 'winston',
    file: 'lib/winston/logger.js',
    versions: ['1'],
    patch (logger, tracer, config) {
      if (!tracer._logInjection) return
      this.wrap(logger.Logger.prototype, 'add', createWrapMethod(tracer, config))
    },
    unpatch (logger) {
      this.unwrap(logger.Logger.prototype, 'add')
    }
  }
]
