'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { getModelProvider, parseModelProvider } = require('./utils')

class VercelAITracingCustomPlugin extends TracingPlugin {
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

class VercelAITracingChannelPlugin extends TracingPlugin {
  static id = 'ai'
  static prefix = 'tracing:aisdk:telemetry'

  bindStart (ctx) {
    const { type: name, event } = ctx
    const model = event.modelId
    const modelProvider = parseModelProvider(event.provider)

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
    const span = ctx.currentStore?.span
    span?.finish()
  }
}

class VercelAITracingPlugin extends CompositePlugin {
  static id = 'ai'
  static plugins = {
    custom: VercelAITracingCustomPlugin,
    tracingChannel: VercelAITracingChannelPlugin,
  }
}

module.exports = VercelAITracingPlugin
