'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')

class GenAiTracingPlugin extends TracingPlugin {
  static id = 'genai'
  static operation = 'request'
  static prefix = 'tracing:apm:google:genai:request'

  static get type () { return 'web' }
  static get kind () { return 'client' }

  bindStart (ctx) {
    const { methodName, inputs, promptText, model } = ctx

    const service = this.serviceName({ pluginConfig: this.config })

    this.startSpan('google_genai.request', {
      service,
      resource: methodName,
      type: 'genai',
      kind: 'client',
      meta: {
        'google_genai.request.model': model,
        'google_genai.request.provider': 'google'
      }
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    if (ctx.result) {
      ctx.currentStore.span.setTag('google_genai.response.model', ctx.result.modelVersion || ctx.inputs?.model)
    }
    if (ctx.currentStore.span) {
      ctx.currentStore.span.finish()
    }
  }
}

module.exports = GenAiTracingPlugin
