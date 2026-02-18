'use strict'

const { channel, tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks } = require('./helpers/instrument')

const loadChannel = channel('dd-trace:instrumentation:load')
loadChannel.publish({ name: 'ai' }) // we do not add hooks for direct imports, we need this publish explicitly

const vercelAiTracingChannel = tracingChannel('dd-trace:vercel-ai')
const vercelAiSpanSetAttributesChannel = channel('dd-trace:vercel-ai:span:setAttributes')

const tracers = new WeakSet()

function wrapTracer (tracer) {
  if (tracers.has(tracer)) {
    return
  }

  tracers.add(tracer)

  shimmer.wrap(tracer, 'startActiveSpan', function (startActiveSpan) {
    return function () {
      const name = arguments[0]
      const options = arguments.length > 2 ? (arguments[1] ?? {}) : {} // startActiveSpan(name, fn)
      const cb = arguments[arguments.length - 1]

      const ctx = {
        name,
        attributes: options.attributes ?? {},
      }

      arguments[arguments.length - 1] = shimmer.wrapFunction(cb, function (originalCb) {
        return function (span) {
          // the below is necessary in the case that the span is vercel ai's noopSpan.
          // while we don't want to patch the noopSpan more than once, we do want to treat each as a
          // fresh instance. However, this is really not necessary for non-noop spans, but not sure
          // how to differentiate.
          const freshSpan = Object.create(span) // TODO: does this cause memory leaks?

          shimmer.wrap(freshSpan, 'end', function (spanEnd) {
            return function () {
              vercelAiTracingChannel.asyncEnd.publish(ctx)
              return spanEnd.apply(this, arguments)
            }
          })

          shimmer.wrap(freshSpan, 'setAttributes', function (setAttributes) {
            return function (attributes) {
              vercelAiSpanSetAttributesChannel.publish({ ctx, attributes })
              return setAttributes.apply(this, arguments)
            }
          })

          shimmer.wrap(freshSpan, 'recordException', function (recordException) {
            return function (exception) {
              ctx.error = exception
              vercelAiTracingChannel.error.publish(ctx)
              return recordException.apply(this, arguments)
            }
          })

          return originalCb.call(this, freshSpan)
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

for (const hook of getHooks('ai')) {
  if (hook.file === 'dist/index.js') {
    delete hook.file
  }
  addHook(hook, exports => {
    const getTracerChannel = tracingChannel('orchestrion:ai:getTracer')
    getTracerChannel.subscribe({
      end (ctx) {
        const { arguments: args, result: tracer } = ctx
        const { isEnabled } = args[0] ?? {}

        if (isEnabled !== false) {
          wrapTracer(tracer)
        }
      },
    })

    /**
     * We patch this function to ensure that the telemetry attributes/tags are set always,
     * even when telemetry options are not specified. This is to ensure easy use of this integration.
     *
     * If it is explicitly disabled, however, we will not change the options.
     */
    const selectTelemetryAttributesChannel = tracingChannel('orchestrion:ai:selectTelemetryAttributes')
    selectTelemetryAttributesChannel.subscribe({
      start (ctx) {
        const { arguments: args } = ctx
        const options = args[0]

        if (options.telemetry?.isEnabled !== false) {
          args[0] = {
            ...options,
            telemetry: {
              ...options.telemetry,
              isEnabled: true,
            },
          }
        }
      },
    })

    return exports
  })
}
