'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const { channel, tracingChannel } = require('dc-polyfill')
const toolCreationChannel = channel('dd-trace:vercel-ai:tool')

const TRACED_FUNCTIONS = {
  generateText: wrapWithTracer,
  streamText: wrapWithTracer,
  generateObject: wrapWithTracer,
  streamObject: wrapWithTracer,
  embed: wrapWithTracer,
  embedMany: wrapWithTracer,
  tool: wrapTool
}

const vercelAiTracingChannel = tracingChannel('dd-trace:vercel-ai')
const vercelAiSpanSetAttributesChannel = channel('dd-trace:vercel-ai:span:setAttributes')

const noopTracer = {
  startActiveSpan () {
    const fn = arguments[arguments.length - 1]

    const span = {
      spanContext () {
        return { traceId: '', spanId: '', traceFlags: 0 }
      },
      setAttribute () {
        return this
      },
      setAttributes () {
        return this
      },
      addEvent () {
        return this
      },
      addLink () {
        return this
      },
      addLinks () {
        return this
      },
      setStatus () {
        return this
      },
      updateName () {
        return this
      },
      end () {
        return this
      },
      isRecording () {
        return false
      },
      recordException () {
        return this
      }
    }

    return fn(span)
  }
}

function wrapTracer (tracer) {
  shimmer.wrap(tracer, 'startActiveSpan', function (startActiveSpan) {
    return function () {
      const name = arguments[0]
      const cb = arguments[arguments.length - 1]

      let options = {}
      if (arguments.length === 3) {
        options = arguments[1]
      } else if (arguments.length === 4) {
        options = arguments[2]
      }

      const ctx = {
        name,
        attributes: options.attributes ?? {}
      }

      arguments[arguments.length - 1] = shimmer.wrapFunction(cb, function (originalCb) {
        return function (span) {
          shimmer.wrap(span, 'end', function (spanEnd) {
            return function () {
              vercelAiTracingChannel.asyncEnd.publish(ctx)
              return spanEnd.apply(this, arguments)
            }
          })

          shimmer.wrap(span, 'setAttributes', function (setAttributes) {
            return function (attributes) {
              vercelAiSpanSetAttributesChannel.publish({ ctx, attributes })
              return setAttributes.apply(this, arguments)
            }
          })

          shimmer.wrap(span, 'recordException', function (recordException) {
            return function (exception) {
              ctx.error = exception
              vercelAiTracingChannel.error.publish(ctx)
              return recordException.apply(this, arguments)
            }
          })

          return originalCb.apply(this, arguments)
        }
      })

      return vercelAiTracingChannel.start.runStores(ctx, () => {
        const result = startActiveSpan.apply(this, arguments)
        vercelAiTracingChannel.end.publish(ctx)
        return result
      })
    }
  })
}

function wrapWithTracer (fn) {
  return function () {
    const options = arguments[0]

    options.experimental_telemetry ??= { isEnabled: true, tracer: noopTracer }
    wrapTracer(options.experimental_telemetry.tracer)

    return fn.apply(this, arguments)
  }
}

function wrapTool (tool) {
  return function () {
    const args = arguments[0]
    toolCreationChannel.publish(args)

    return tool.apply(this, arguments)
  }
}

// CJS exports
addHook({
  name: 'ai',
  versions: ['>=4.0.0'],
}, exports => {
  // the exports from this package are not configurable
  // to return wrapped functions with the tracer provided above,
  // we need to copy the exports
  const wrappedExports = {}

  for (const [fnName, patchingFn] of Object.entries(TRACED_FUNCTIONS)) {
    const original = exports[fnName]
    wrappedExports[fnName] = shimmer.wrapFunction(original, patchingFn)
  }

  Object.getOwnPropertyNames(exports).forEach(prop => {
    if (!Object.keys(TRACED_FUNCTIONS).includes(prop)) {
      wrappedExports[prop] = exports[prop]
    }
  })

  return wrappedExports
})

// ESM exports
addHook({
  name: 'ai',
  versions: ['>=4.0.0'],
  file: 'dist/index.mjs'
}, exports => {
  for (const [fnName, patchingFn] of Object.entries(TRACED_FUNCTIONS)) {
    const original = exports[fnName]
    exports[fnName] = shimmer.wrapFunction(original, patchingFn)
  }

  return exports
})
