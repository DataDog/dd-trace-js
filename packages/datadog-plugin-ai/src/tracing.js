'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { getModelProvider } = require('./utils')

class VercelAITracingPlugin extends TracingPlugin {
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
        'ai.request.model_provider': modelProvider
      }
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    span?.finish()
  }
}

module.exports = VercelAITracingPlugin
