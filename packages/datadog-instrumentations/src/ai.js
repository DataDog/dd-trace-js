'use strict'

const { channel, tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks } = require('./helpers/instrument')
const { convertVercelPromptToMessages, buildOutputMessages } = require('./helpers/ai-messages')

const vercelAiTracingChannel = tracingChannel('dd-trace:vercel-ai')
const vercelAiSpanSetAttributesChannel = channel('dd-trace:vercel-ai:span:setAttributes')
const aiguardChannel = channel('dd-trace:ai:aiguard')

const tracers = new WeakSet()
const wrappedModels = new WeakSet()

/**
 * Publishes already-converted AI guard style messages to the AIGuard channel.
 *
 * @param {Array<object>} messages - AI guard style messages to evaluate
 * @returns {Promise<void>}
 */
function publishToAIGuard (messages) {
  return new Promise((resolve, reject) => {
    aiguardChannel.publish({ messages, resolve, reject })
  })
}

/**
 * Wraps a Vercel AI language model's doGenerate and doStream methods to evaluate
 * messages with AIGuard.
 *
 * @param {object} model - A Vercel AI language model instance
 */
function wrapModelWithAIGuard (model) {
  if (!model || wrappedModels.has(model)) return
  wrappedModels.add(model)

  if (typeof model.doGenerate === 'function') {
    shimmer.wrap(model, 'doGenerate', function (original) {
      return function (options) {
        const originalResult = original.call(this, options)

        if (!aiguardChannel.hasSubscribers) return originalResult
        if (!options.prompt?.length) return originalResult

        const inputMessages = convertVercelPromptToMessages(options.prompt)
        if (!inputMessages.length) return originalResult

        // Run AI Guard input evaluation and LLM call in parallel.
        // The LLM has no side effects so it is safe to discard its result if AI Guard blocks.
        return Promise.all([publishToAIGuard(inputMessages), originalResult])
          .then(([, result]) => {
            if (!result.content?.length) return result
            return publishToAIGuard(buildOutputMessages(inputMessages, result.content))
              .then(() => result)
          })
      }
    })
  }

  if (typeof model.doStream === 'function') {
    shimmer.wrap(model, 'doStream', function (original) {
      return function (options) {
        const originalResult = original.call(this, options)

        if (!aiguardChannel.hasSubscribers) return originalResult
        if (!options.prompt?.length) return originalResult

        const inputMessages = convertVercelPromptToMessages(options.prompt)
        if (!inputMessages.length) return originalResult

        // Run AI Guard input evaluation and LLM call in parallel.
        // The LLM has no side effects so it is safe to discard its result if AI Guard blocks.
        return Promise.all([publishToAIGuard(inputMessages), originalResult])
          .then(([, result]) => {
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
              const toolCalls = chunks.filter(c => c?.type === 'tool-call')
              const text = chunks.filter(c => c?.type === 'text-delta').map(c => c.textDelta).join('')
              const content = toolCalls.length ? toolCalls : text ? [{ type: 'text', text }] : []

              const evaluate = content.length
                ? publishToAIGuard(buildOutputMessages(inputMessages, content))
                : Promise.resolve()

              return evaluate.then(() => {
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
        wrapModelWithAIGuard(ctx.result)
      },
    })

    return exports
  })
}

module.exports = { wrapModelWithAIGuard }
