'use strict'

const shimmer = require('../../datadog-shimmer')

const methods = ['log', 'info', 'debug', 'error', 'warn', 'trace']
const wrapped = Symbol.for('dd-trace.lambda.console')

/** @typedef {import('node:console').Console} Console */
/** @typedef {import('../../dd-trace/src/opentracing/span_context')} TraceContext */

/**
 * @param {Console} target Console whose bound runtime methods cannot be rewritten at source.
 * @param {() => TraceContext|null|undefined} getContext Invocation-scoped context reader.
 */
function patchConsole (target, getContext) {
  for (const method of methods) {
    const original = target[method]
    if (original[wrapped]) continue
    // Console methods are created/bound at runtime. Preserve the shim's argument transformation.
    const replacement = shimmer.wrapFunction(original, original => {
      let isLogging = false
      return function () {
        if (isLogging) return original.apply(this, arguments)
        isLogging = true
        try {
          const context = getContext()
          if (context) {
            const traceId = context.toTraceId()
            const spanId = context.toSpanId()
            if (arguments.length === 0) {
              arguments.length = 1
              arguments[0] = `[dd.trace_id=${traceId} dd.span_id=${spanId}]`
            } else if (arguments.length === 1 && isJsonStyleLog(arguments[0])) {
              const value = arguments[0]
              const dd = value.dd
              arguments[0] = {
                ...value,
                dd: {
                  ...(dd !== null && typeof dd === 'object' && !Array.isArray(dd) ? dd : {}),
                  trace_id: traceId,
                  span_id: spanId,
                },
              }
            } else {
              arguments[0] = `[dd.trace_id=${traceId} dd.span_id=${spanId}] ${arguments[0]}`
            }
          }
        } catch {
          // Context/formatting failures must not suppress the customer's log call.
        }
        isLogging = false
        return original.apply(this, arguments)
      }
    })
    Object.defineProperty(replacement, wrapped, { value: { original, replacement } })
    target[method] = replacement
  }
}

/** @param {Console} target Console patched by the Lambda plugin. */
function unpatchConsole (target) {
  for (const method of methods) {
    const record = target[method][wrapped]
    // Keep wrappers installed by other instrumentation after ours.
    if (record?.replacement === target[method]) target[method] = record.original
  }
}

/** @param {unknown} value First log argument. */
function isJsonStyleLog (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

module.exports = { patchConsole, unpatchConsole }
