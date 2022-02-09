'use strict'

const { LOG } = require('../../../ext/formats')

function chunkProxy (chunk, holder) {
  return new Proxy(chunk, {
    get (target, p, receiver) {
      switch (p) {
        case Symbol.toStringTag:
          return Object.prototype.toString.call(target).slice(8, -1)
        case 'dd':
          return holder.dd
        default:
          return Reflect.get(target, p, receiver)
      }
    },
    ownKeys (target) {
      const ownKeys = Reflect.ownKeys(target)
      return ownKeys.includes('dd') ? ownKeys : ['dd', ...ownKeys]
    },
    getOwnPropertyDescriptor (target, p) {
      return Reflect.getOwnPropertyDescriptor(p === 'dd' ? holder : target, p)
    }
  })
}

function createWrapWrite (tracer, config) {
  return function wrapWrite (write) {
    return function writeWithTrace (chunk, encoding, callback) {
      const span = tracer.scope().active()

      const holder = {}
      tracer.inject(span, LOG, holder)
      arguments[0] = chunkProxy(chunk, holder)

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

      const holder = {}
      tracer.inject(span, LOG, holder)

      arguments[2] = chunkProxy(meta, holder)

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
