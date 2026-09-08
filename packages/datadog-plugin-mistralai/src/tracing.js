'use strict'

const { getModelProvider } = require('../../dd-trace/src/llmobs/plugins/mistralai/util')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class MistralAITracingPlugin extends TracingPlugin {
  static id = 'mistralai'
  static operation = 'request'
  static system = 'mistralai'
  static prefix = 'tracing:apm:mistralai:request'

  bindStart (ctx) {
    const { resource, request, serverURL } = ctx

    this.startSpan('mistralai.request', {
      meta: {
        'resource.name': resource,
        'mistralai.request.model': request?.model,
        'mistralai.request.provider': getModelProvider(serverURL),
      },
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    span?.finish()
  }
}

module.exports = MistralAITracingPlugin
