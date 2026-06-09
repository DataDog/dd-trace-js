'use strict'

// const { storage } = require('../../datadog-core')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { getModelProvider, parseModelProvider } = require('./utils')

class DdTelemetryPlugin extends TracingPlugin {
  static id = 'ai'
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
  static id = 'ai'
  static prefix = 'tracing:ai:telemetry'

  bindStart (ctx) {
    const { type: name, event } = ctx
    const model = event.modelId
    const modelProvider = parseModelProvider(event.provider, model)

    // console.log('parent of', name, 'is', storage('legacy').getStore()?.span._name)

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
    if (ctx.type === 'streamText') {
      // console.log(ctx)
    }
    const span = ctx.currentStore?.span
    span?.finish()
  }
}

class VercelAITracingPlugin extends CompositePlugin {
  static id = 'ai'
  static plugins = {
    dd: DdTelemetryPlugin,
    ai: VercelAiTelemetryPlugin,
  }
}

module.exports = VercelAITracingPlugin
