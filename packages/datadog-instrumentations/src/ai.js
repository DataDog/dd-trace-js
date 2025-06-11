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

function createTracer () {
  const tracer = {
    startActiveSpan (name, options, fn) { // although this can take 4 args, vercel-ai only uses 3
      const ctx = {
        name,
        attributes: options.attributes ?? {}
      }

      const span = {
        end () {
          vercelAiTracingChannel.asyncEnd.publish(ctx)
        },
        setAttributes (attributes) {
          vercelAiSpanSetAttributesChannel.publish({ ctx, attributes })
          return this
        },
        addEvent () { return this },
        recordException (exception) {
          ctx.error = exception
          vercelAiTracingChannel.error.publish(ctx)
        },
        setStatus ({ code, message }) {
          if (code === 2) {
            ctx.error = new Error(message)
          }
          vercelAiTracingChannel.error.publish(ctx)
          return this
        }
      }

      return vercelAiTracingChannel.start.runStores(ctx, () => {
        const result = fn(span)
        vercelAiTracingChannel.end.publish(ctx)
        return result
      })
    }
  }

  return tracer
}

function wrapWithTracer (fn) {
  return function () {
    const options = arguments[0]
    if (options.experimental_telemetry != null) return fn.apply(this, arguments)

    options.experimental_telemetry = {
      isEnabled: true,
      tracer: createTracer()
    }

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
