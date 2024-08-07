const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')
class AzureFunctionsPlugin extends TracingPlugin {
  static get id () {
    return 'azure-functions'
  }

  static get prefix () { return 'tracing:datadog:azure-functions:http' }

  bindStart (ctx) {
    const { name, options } = ctx
    console.log('==== starting span =====')
    const span = this.startSpan('azure-inbound-web', {
      service: this.config.service || this._tracerConfig.service,
      resource: name,
      type: 'system',
      meta: {
        'azure-functions.name': name,
        'azure-functions.trigger': options.trigger
      }
    }, false)

    const store = storage.getStore()
    ctx.parentStore = store
    ctx.currentStore = { ...store, span }
    return ctx.currentStore
  }

  end () {
    // this.activeSpan?.finish()
  }

  error (ctx) {
    if (ctx.error) {
      const error = ctx.error
      const span = ctx.currentStore.span
      console.log('!!! ctx context error: ', error)
      span.setTag('error', error)
    }
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore.span
    // console.log('--- active span: ', span)
    console.log('async end')
    span.finish()
  }
}

module.exports = AzureFunctionsPlugin
