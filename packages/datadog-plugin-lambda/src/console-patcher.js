'use strict'

const shimmer = require('../../datadog-shimmer')

const methods = ['log', 'info', 'debug', 'error', 'warn', 'trace']

/**
 * @param {Function} getActiveSpan - returns the current active span or null
 */
function patchConsole (getActiveSpan) {
  for (const method of methods) {
    patchMethod(console, method, getActiveSpan)
  }
}

function unpatchConsole () {
  for (const method of methods) {
    if (console[method].__wrapped) {
      shimmer.unwrap(console, method)
    }
  }
}

function isJsonStyleLog (value) {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function getExistingDdContext (logObject) {
  return isPlainObject(logObject.dd) ? logObject.dd : {}
}

function patchMethod (mod, method, getActiveSpan) {
  if (mod[method].__wrapped) return

  shimmer.wrap(mod, method, function (original) {
    let isLogging = false
    return function emitWithContext () {
      if (isLogging) {
        return original.apply(this, arguments)
      }
      isLogging = true

      try {
        const span = getActiveSpan()
        if (span) {
          const spanContext = span.context()
          const traceId = spanContext.toTraceId()
          const spanId = spanContext.toSpanId()

          if (arguments.length === 0) {
            arguments.length = 1
            arguments[0] = `[dd.trace_id=${traceId} dd.span_id=${spanId}]`
          } else if (arguments.length === 1 && isJsonStyleLog(arguments[0])) {
            arguments[0] = Object.assign({}, arguments[0], {
              dd: Object.assign({}, getExistingDdContext(arguments[0]), {
                trace_id: traceId,
                span_id: spanId,
              }),
            })
          } else {
            arguments[0] = `[dd.trace_id=${traceId} dd.span_id=${spanId}] ${arguments[0]}`
          }
        }
      } catch (e) {
        // Swallow - logging inside log should not break
      }

      isLogging = false
      return original.apply(this, arguments)
    }
  })
}

module.exports = {
  patchConsole,
  unpatchConsole,
}
