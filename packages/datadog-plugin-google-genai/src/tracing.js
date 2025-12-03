'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')

class GenAiTracingPlugin extends TracingPlugin {
  static id = 'google-genai'
  static operation = 'request'
  static prefix = 'tracing:apm:google:genai:request'

  static get type () { return 'web' }
  static get kind () { return 'client' }

  bindStart (ctx) {
    const { args, methodName } = ctx

    const inputs = args[0]
    const model = inputs?.model || 'unknown'

    this.startSpan('google_genai.request', {
      meta: {
        'resource.name': methodName,
        'google_genai.request.model': model,
        'google_genai.request.provider': 'google'
      }
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const { span } = ctx.currentStore
    if (!span) return

    if (ctx.result) {
      span.setTag('google_genai.response.model', ctx.result.modelVersion || ctx.inputs?.model)
    }
    span.finish()
  }
}

module.exports = GenAiTracingPlugin
