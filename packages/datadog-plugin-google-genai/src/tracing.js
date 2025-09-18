'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')
const tags = require('../../../ext/tags.js')

// const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
console.log('in the plugin')
class GenAiTracingPlugin extends TracingPlugin {
  static id = 'genai'
  static operation = 'request'

  static prefix = 'tracing:apm:google:genai:request'

  static get type () { return 'web' }
  static get kind () { return 'client' }
  bindStart (ctx) {
    const { methodName, inputs, promptText, model } = ctx

    const service = this.serviceName({ pluginConfig: this.config })

    const span = this.startSpan('google_genai.request', {
      service,
      resource: methodName,
      type: 'genai',
      kind: 'client',
      meta: {
        'google_genai.request.model': model
      }
    }, ctx)
    ctx.span = span

    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    // console.log('bind async return')
    return ctx.parentStore
  }

  asyncStart (ctx) {
    ctx.span.finish()
  }

  end (ctx) {
    ctx.span.finish()
  }
}

module.exports = GenAiTracingPlugin
