'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { getModelProvider } = require('./utils')

class VercelAITracingPlugin extends TracingPlugin {
  static get id () { return 'ai' }
  static get prefix () { return 'tracing:dd-trace:vercel-ai' }

  bindStart (ctx) {
    const attributes = ctx.attributes

    const model = attributes['ai.model.id']
    const modelProvider = getModelProvider(attributes)

    this.startSpan(ctx.name, {
      meta: {
        'resource.name': ctx.name,
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
