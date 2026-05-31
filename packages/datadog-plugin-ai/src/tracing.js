'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { getModelProvider } = require('./utils')

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
    console.log('bindStart', ctx.type)
  }

  asyncEnd (ctx) {
    console.log('asyncEnd', ctx.type)
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
