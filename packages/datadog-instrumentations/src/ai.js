'use strict'

console.log('adding hooks for ai instrumentation')

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
      spanContext () { return { traceId: '', spanId: '', traceFlags: 0 } },
      setAttribute () { return this },
      setAttributes () { return this },
      addEvent () { return this },
      addLink () { return this },
      addLinks () { return this },
      setStatus () { return this },
      updateName () { return this },
      end () { return this },
      isRecording () { return false },
      recordException () { return this }
    }

    return fn(span)
  }
}

function wrapTracer (tracer) {
  if (Object.hasOwn(tracer, Symbol.for('_dd.wrapped'))) return

  shimmer.wrap(tracer, 'startActiveSpan', function (startActiveSpan) {
    return function () {
      const name = arguments[0]
      const options = arguments.length > 2 ? (arguments[1] ?? {}) : {} // startActiveSpan(name, fn)
      const cb = arguments[arguments.length - 1]

      const ctx = {
        name,
        attributes: options.attributes ?? {}
      }

      arguments[arguments.length - 1] = shimmer.wrapFunction(cb, function (originalCb) {
        return function (span) {
          shimmer.wrap(span, 'end', function (spanEnd) {
            return function () {
              console.log('publishing end for', ctx.name)
              vercelAiTracingChannel.asyncEnd.publish(ctx)
              return spanEnd.apply(this, arguments)
            }
          })

          shimmer.wrap(span, 'setAttributes', function (setAttributes) {
            return function (attributes) {
              console.log('publishing setAttributes for', ctx.name)
              vercelAiSpanSetAttributesChannel.publish({ ctx, attributes })
              return setAttributes.apply(this, arguments)
            }
          })

          shimmer.wrap(span, 'recordException', function (recordException) {
            return function (exception) {
              console.log('publishing error for', ctx.name)
              ctx.error = exception
              vercelAiTracingChannel.error.publish(ctx)
              return recordException.apply(this, arguments)
            }
          })

          return originalCb.apply(this, arguments)
        }
      })

      console.log('how many start subscribers are there?', vercelAiTracingChannel.start._subscribers?.length, '**')

      return vercelAiTracingChannel.start.runStores(ctx, () => {
        console.log('running start subscribers')
        const result = startActiveSpan.apply(this, arguments)
        console.log('publishing end for', ctx.name)
        vercelAiTracingChannel.end.publish(ctx)
        return result
      })
    }
  })

  Object.defineProperty(tracer, Symbol.for('_dd.wrapped'), { value: true })
}

function wrapWithTracer (fn) {
  return function () {
    const options = arguments[0]

    const experimentalTelemetry = options.experimental_telemetry
    if (experimentalTelemetry?.isEnabled === false) {
      return fn.apply(this, arguments)
    }

    if (experimentalTelemetry == null) {
      options.experimental_telemetry = { isEnabled: true, tracer: noopTracer }
    } else {
      experimentalTelemetry.isEnabled = true
      experimentalTelemetry.tracer ??= noopTracer
    }

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
  console.log('patching ai functions')
  for (const [fnName, patchingFn] of Object.entries(TRACED_FUNCTIONS)) {
    exports = shimmer.wrap(exports, fnName, patchingFn, { replaceGetter: true })
  }

  return exports
})

// ESM exports
addHook({
  name: 'ai',
  versions: ['>=4.0.0'],
  file: 'dist/index.mjs'
}, exports => {
  for (const [fnName, patchingFn] of Object.entries(TRACED_FUNCTIONS)) {
    exports = shimmer.wrap(exports, fnName, patchingFn, { replaceGetter: true })
  }

  return exports
})
