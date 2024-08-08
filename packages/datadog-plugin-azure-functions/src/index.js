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
    const span = this.startSpan('azure-function', {
      service: this.config.service || this._tracerConfig.service,
      resource: name,
      type: 'system',
      meta: {
        'aas.function.name': name,
        'aas.functions.trigger': options.trigger
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
      span.setTag('error', error)
    }
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore.span
    console.log('async end')
    span.finish()
  }
}

module.exports = AzureFunctionsPlugin
