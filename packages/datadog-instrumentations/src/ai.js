'use strict'

const { channel, tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks } = require('./helpers/instrument')

const vercelAiTracingChannel = tracingChannel('dd-trace:vercel-ai')
const vercelAiSpanSetAttributesChannel = channel('dd-trace:vercel-ai:span:setAttributes')
const doGenerateBeforeChannel = channel('dd-trace:vercel-ai:doGenerate:before')
const doGenerateAfterChannel = channel('dd-trace:vercel-ai:doGenerate:after')
const doStreamBeforeChannel = channel('dd-trace:vercel-ai:doStream:before')
const doStreamAfterChannel = channel('dd-trace:vercel-ai:doStream:after')

const tracers = new WeakSet()
const wrappedModels = new WeakSet()

/**
 * Publishes a provider-native lifecycle payload to a cancelable lifecycle channel.
 *
 * Subscribers push async work into `pending` synchronously during publication and
 * abort `abortController` with an error before the pushed promise resolves to block.
 *
 * @param {object} lifecycleChannel
 * @param {object} payload
 * @returns {Promise<void>}
 */
function publishLifecycle (lifecycleChannel, payload) {
  const abortController = new AbortController()
  const ctx = { ...payload, abortController, pending: [] }

  lifecycleChannel.publish(ctx)

  return Promise.all(ctx.pending).then(() => {
    if (abortController.signal.aborted) {
      throw abortController.signal.reason
    }
  })
}

/**
 * Wraps a Vercel AI language model's doGenerate and doStream lifecycle methods.
 *
 * @param {object} model - A Vercel AI language model instance
 */
function wrapModelWithLifecycle (model) {
  if (!model || wrappedModels.has(model)) return
  wrappedModels.add(model)

  if (typeof model.doGenerate === 'function') {
    shimmer.wrap(model, 'doGenerate', function (original) {
      return function (options) {
        const originalResult = original.call(this, options)

        if (!doGenerateBeforeChannel.hasSubscribers && !doGenerateAfterChannel.hasSubscribers) return originalResult
        if (!options.prompt?.length) return originalResult

        const beforeEvaluation = doGenerateBeforeChannel.hasSubscribers
          ? publishLifecycle(doGenerateBeforeChannel, { prompt: options.prompt, options })
          : Promise.resolve()

        return Promise.all([beforeEvaluation, originalResult])
          .then(([, result]) => {
            if (!doGenerateAfterChannel.hasSubscribers || !result.content?.length) return result
            const payload = { prompt: options.prompt, options, result }
            return publishLifecycle(doGenerateAfterChannel, payload).then(() => result)
          })
      }
    })
  }

  if (typeof model.doStream === 'function') {
    shimmer.wrap(model, 'doStream', function (original) {
      return function (options) {
        const originalResult = original.call(this, options)

        if (!doStreamBeforeChannel.hasSubscribers && !doStreamAfterChannel.hasSubscribers) return originalResult
        if (!options.prompt?.length) return originalResult

        const beforeEvaluation = doStreamBeforeChannel.hasSubscribers
          ? publishLifecycle(doStreamBeforeChannel, { prompt: options.prompt, options })
          : Promise.resolve()

        return Promise.all([beforeEvaluation, originalResult])
          .then(([, result]) => {
            if (!doStreamAfterChannel.hasSubscribers) return result

            const chunks = []
            const reader = result.stream.getReader()

            function readAll () {
              return reader.read().then(({ done, value }) => {
                if (done) return
                chunks.push(value)
                return readAll()
              })
            }

            return readAll().then(() => {
              return publishLifecycle(doStreamAfterChannel, { prompt: options.prompt, options, chunks })
                .then(() => {
                  // eslint-disable-next-line n/no-unsupported-features/node-builtins
                  const stream = new ReadableStream({
                    start (controller) {
                      for (const chunk of chunks) {
                        controller.enqueue(chunk)
                      }
                      controller.close()
                    },
                  })
                  return { ...result, stream }
                })
            })
          })
      }
    })
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
      const cb = args[args.length - 1]

      const ctx = {
        name,
        attributes: options.attributes ?? {},
      }

      args[args.length - 1] = shimmer.wrapFunction(cb, function (originalCb) {
        return function (span) {
          // A plain delegating wrapper is used instead of Object.create(span) because
          // Object.create (and Proxy) cannot cross private-field brand checks — any span
          // method that reads a private field (e.g. BridgeSpanBase#statusCode) would throw
          // "Cannot read private member" on a prototype clone. Every method here calls
          // through to the real span instance so private fields always resolve correctly.
          const freshSpan = {
            spanContext () { return span.spanContext() },
            setAttribute (key, value) { span.setAttribute(key, value); return freshSpan },
            setAttributes (attributes) {
              vercelAiSpanSetAttributesChannel.publish({ ctx, attributes })
              span.setAttributes(attributes)
              return freshSpan
            },
            addEvent (name, attributesOrStartTime, startTime) {
              span.addEvent(name, attributesOrStartTime, startTime)
              return freshSpan
            },
            addLink (link, attrs) { span.addLink(link, attrs); return freshSpan },
            addLinks (links) { span.addLinks(links); return freshSpan },
            setStatus (status) { span.setStatus(status); return freshSpan },
            updateName (spanName) { span.updateName(spanName); return freshSpan },
            isRecording () { return span.isRecording() },
            recordException (exception, timeInput) {
              ctx.error = exception
              vercelAiTracingChannel.error.publish(ctx)
              span.recordException(exception, timeInput)
            },
            end (...endArgs) {
              vercelAiTracingChannel.asyncEnd.publish(ctx)
              span.end(...endArgs)
            },
          }

          return originalCb.call(this, freshSpan)
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
        wrapModelWithLifecycle(ctx.result)
      },
    })

    return exports
  })
}

module.exports = { wrapModelWithLifecycle, wrapTracer }
