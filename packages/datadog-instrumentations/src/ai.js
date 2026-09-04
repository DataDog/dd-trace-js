'use strict'

const { channel, tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks } = require('./helpers/instrument')

const vercelAiTracingChannel = tracingChannel('dd-trace:vercel-ai')
const vercelAiSpanSetAttributesChannel = channel('dd-trace:vercel-ai:span:setAttributes')

// Published synchronously per model call with the native call data. A subscriber may set either
// callback and this instrumentation applies it, so the wrapping stays here and only the policy
// lives outside:
//   beforeResult () => Promise<void>|undefined     holds the result back until it settles
//   onResult (result) => unknown|Promise<unknown>  inspects or replaces the delivered result
const modelInterceptChannel = channel('dd-trace:vercel-ai:model:intercept')

const INTERCEPTED_MODEL_METHODS = ['doGenerate', 'doStream']

const tracers = new WeakSet()
const wrappedModels = new WeakSet()

/**
 * Wraps a language model's call methods so subscribers can interpose on each call.
 *
 * @param {object} model
 */
function wrapModel (model) {
  if (!model || wrappedModels.has(model)) return
  wrappedModels.add(model)

  for (const method of INTERCEPTED_MODEL_METHODS) {
    if (typeof model[method] !== 'function') continue

    shimmer.wrap(model, method, original => function (...args) {
      const result = original.apply(this, args)
      if (!modelInterceptChannel.hasSubscribers) return result

      const interceptCtx = { method, arguments: args }
      modelInterceptChannel.publish(interceptCtx)

      if (!interceptCtx.beforeResult && !interceptCtx.onResult) return result

      // A model may return any thenable, so normalize before attaching handlers.
      const settled = Promise.resolve(result)
      // The interceptor's rejection wins over an earlier SDK rejection.
      settled.catch(() => {})

      return Promise.resolve(interceptCtx.beforeResult?.())
        .then(() => settled)
        .then(value => (interceptCtx.onResult ? interceptCtx.onResult(value) : value))
    })
  }
}

/**
 * Wraps an OTel span without changing its method receivers.
 *
 * OTel spans may use private fields, so methods must run against the original
 * span. A per-invocation wrapper also preserves `ctx` without mutating the AI
 * SDK's shared no-op span.
 *
 * @param {import('@opentelemetry/api').Span} span
 * @param {object} ctx
 * @returns {import('@opentelemetry/api').Span}
 */
function createDelegatingSpan (span, ctx) {
  return {
    spanContext () {
      return span.spanContext.apply(span, arguments)
    },
    setAttribute () {
      span.setAttribute.apply(span, arguments)
      return this
    },
    setAttributes (attributes) {
      vercelAiSpanSetAttributesChannel.publish({ ctx, attributes })
      span.setAttributes.apply(span, arguments)
      return this
    },
    addEvent () {
      span.addEvent.apply(span, arguments)
      return this
    },
    addLink () {
      span.addLink.apply(span, arguments)
      return this
    },
    addLinks () {
      span.addLinks.apply(span, arguments)
      return this
    },
    setStatus () {
      span.setStatus.apply(span, arguments)
      return this
    },
    updateName () {
      span.updateName.apply(span, arguments)
      return this
    },
    isRecording () {
      return span.isRecording.apply(span, arguments)
    },
    recordException (exception) {
      ctx.error = exception
      vercelAiTracingChannel.error.publish(ctx)
      return span.recordException.apply(span, arguments)
    },
    end () {
      vercelAiTracingChannel.asyncEnd.publish(ctx)
      return span.end.apply(span, arguments)
    },
  }
}

function wrapTracer (tracer) {
  if (tracers.has(tracer)) {
    return
  }

  tracers.add(tracer)

  shimmer.wrap(tracer, 'startActiveSpan', function (startActiveSpan) {
    return function (...args) {
      const name = args[0]
      const options = args.length > 2 ? (args[1] ?? {}) : {} // startActiveSpan(name, fn)
      const cb = args.at(-1)

      const ctx = {
        name,
        attributes: options.attributes ?? {},
      }

      args[args.length - 1] = shimmer.wrapFunction(cb, function (originalCb) {
        return function (span) {
          return originalCb.call(this, createDelegatingSpan(span, ctx))
        }
      })

      return vercelAiTracingChannel.start.runStores(ctx, () => {
        const result = startActiveSpan.apply(this, args)
        vercelAiTracingChannel.end.publish(ctx)
        return result
      })
    }
  })
}

for (const hook of getHooks('ai')) {
  if (hook.file === 'dist/index.js') {
    // if not removed, the below hook will never match correctly
    // however, it is still needed in the orchestrion definition
    hook.file = null
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

    // resolveLanguageModel is called by all LLM entry points (generateText, streamText,
    // generateObject, streamObject)
    tracingChannel('orchestrion:ai:resolveLanguageModel').subscribe({
      end (ctx) {
        const model = ctx.arguments[0]

        // The SDK builds a model from a string id, in which case only the resolved instance is
        // worth wrapping; when the caller passed an instance, that is the one the SDK calls.
        if (typeof model !== 'string' && model !== ctx.result) {
          wrapModel(model)
          wrappedModels.add(ctx.result)
        } else {
          wrapModel(ctx.result)
        }
      },
    })

    return exports
  })
}

const aiSdkTelemetryChannel = tracingChannel('ai:telemetry')
const aiSdkTelemetryStreamedChunkChannel = channel('dd-trace:vercel-ai:chunk')

// for testing, and possibly actual instrumentation use, we want to
// guard against double-subscribing to the asyncEnd channel of the
// vercel ai-provided tracingChannel
let subscribed = false

// as of the v7 release, the ai sdk does not automatically aggregate streamed responses
// we will handle emitting the chunks directly for products to handle
addHook({ name: 'ai', versions: ['>=7.0.0'] }, exports => {
  if (subscribed) return exports
  subscribed = true

  // ai sdk v7 only supported on node.js 22+
  // inlining this import here so we only import in those cases
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  const { TransformStream } = require('node:stream/web')

  aiSdkTelemetryChannel.subscribe({
    asyncEnd (ctx) {
      // guard against this event being re-emitted.
      if (!ctx.isStream || !ctx.result?.stream || ctx.streamConsumed) return

      const transform = new TransformStream({
        transform (chunk, controller) {
          const done = chunk.type === 'finish'

          aiSdkTelemetryStreamedChunkChannel.publish({ ctx, chunk, done })

          if (done) {
            aiSdkTelemetryChannel.asyncEnd.publish(ctx)
          }

          controller.enqueue(chunk) // pass through value
        },
      })

      ctx.result.stream = ctx.result.stream.pipeThrough(transform)
    },
  })

  return exports
})
