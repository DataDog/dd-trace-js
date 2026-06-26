'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { getModelProvider, parseModelProvider } = require('./utils')

class DdTelemetryPlugin extends TracingPlugin {
  static id = 'ai_tracing_dd_telemetry'
  static prefix = 'tracing:dd-trace:vercel-ai'

  bindStart (ctx) {
    const { attributes, name } = ctx

    const model = attributes['ai.model.id']
    const modelProvider = getModelProvider(attributes)

    this.startSpan(name, {
      meta: {
        'resource.name': attributes['resource.name'] ?? name,
        'ai.request.model': model,
        'ai.request.model_provider': modelProvider,
      },
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    span?.finish()
  }
}

class VercelAiTelemetryPlugin extends TracingPlugin {
  static id = 'ai_tracing_vercel_telemetry'
  static prefix = 'tracing:ai:telemetry'

  #streamedCalls = new Set()

  constructor () {
    super(...arguments)

    this.addSub('dd-trace:vercel-ai:chunk', ({ ctx, chunk, done }) => {
      ctx.streamConsumed = done
    })
  }

  bindStart (ctx) {
    const { type: name, event } = ctx
    const model = event.modelId
    const modelProvider = parseModelProvider(event.provider, model)

    let isStream = this.#streamedCalls.has(event.callId)
    if (name.includes('stream')) {
      this.#streamedCalls.add(event.callId)
      isStream = true

      ctx.streamConsumed = false
    }

    ctx.isStream = isStream

    this.startSpan(name, {
      meta: {
        'resource.name': event.functionId ?? name,
        'ai.request.model': model,
        'ai.request.model_provider': modelProvider,
      },
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    // check if isStreamed and stream resolved
    // this event will fire multiple times for the same channel
    if (ctx.isStream && ctx.result?.stream && !ctx.streamConsumed) return

    if (ctx.type?.includes('stream')) {
      this.#streamedCalls.add(ctx.event?.callId)
    }

    const span = ctx.currentStore?.span
    span?.finish()
  }
}

class VercelAITracingPlugin extends CompositePlugin {
  static id = 'ai_tracing'
  static plugins = {
    dd: DdTelemetryPlugin,
    ai: VercelAiTelemetryPlugin,
  }
}

module.exports = VercelAITracingPlugin
