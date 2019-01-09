'use strict'

function createWrapWrite (tracer, config) {
  return function wrapWrite (write) {
    return function writeWithTrace (chunk, encoding, callback) {
      correlate(tracer.scopeManager().active(), chunk)

      return write.apply(this, arguments)
    }
  }
}

function createWrapLog (tracer, config) {
  return function wrapLog (log) {
    return function logWithTrace (level, msg, meta, callback) {
      const scope = tracer.scopeManager().active()

      if (!scope || arguments.length < 1) return log.apply(this, arguments)

      for (let i = 0, l = arguments.length; i < l; i++) {
        if (typeof arguments[i] !== 'object') continue

        correlate(scope, arguments[i])

        return log.apply(this, arguments)
      }

      meta = correlate(scope)
      callback = arguments[arguments.length - 1]

      const index = typeof callback === 'function'
        ? arguments.length - 1
        : arguments.length

      Array.prototype.splice.call(arguments, index, 0, meta)

      return log.apply(this, arguments)
    }
  }
}

function correlate (scope, record) {
  record = record || {}

  if (scope && record) {
    const span = scope.span()

    record['dd.trace_id'] = span.context().toTraceId()
    record['dd.span_id'] = span.context().toSpanId()
  }

  return record
}

module.exports = [
  {
    name: 'winston',
    file: 'lib/winston/logger.js',
    versions: ['3'],
    patch (Logger, tracer, config) {
      if (!config.correlate) return
      this.wrap(Logger.prototype, 'write', createWrapWrite(tracer, config))
    },
    unpatch (Logger) {
      this.unwrap(Logger.prototype, 'write')
    }
  },
  {
    name: 'winston',
    file: 'lib/winston/logger.js',
    versions: ['1 - 2'],
    patch (logger, tracer, config) {
      if (!config.correlate) return
      this.wrap(logger.Logger.prototype, 'log', createWrapLog(tracer, config))
    },
    unpatch (logger) {
      this.unwrap(logger.Logger.prototype, 'log')
    }
  }
]
