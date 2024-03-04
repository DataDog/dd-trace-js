'use strict'

const TracingPlugin = require('../../../dd-trace/src/plugins/tracing')
const { storage } = require('../../../datadog-core')

class ApolloGatewayValidatePlugin extends TracingPlugin {
  static get id () { return 'apollo.gateway' }
  static get operation () { return 'validate' }
  static get type () { return 'web' }
  static get kind () { return 'server' }
  static get prefix () {
    return 'tracing:apm:apollo:gateway:validate'
  }

  bindStart (ctx) {
    const store = storage.getStore()
    const childOf = store ? store.span : null

    const span = this.startSpan(this.operationName({ id: `${this.constructor.id}.${this.constructor.operation}` }), {
      childOf,
      service: this.serviceName(
        { id: `${this.constructor.id}.${this.constructor.operation}`, pluginConfig: this.config }),
      type: this.constructor.type,
      kind: this.constructor.kind,
      meta: {}
    }, false)

    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    ctx.currentStore.span.finish()
    return ctx.parentStore
  }

  end (ctx) {
    const result = ctx.result
    if (result instanceof Array &&
      result[result.length - 1] && result[result.length - 1].stack && result[result.length - 1].message) {
      ctx.currentStore.span.setTag('error', result[result.length - 1])
    }
    ctx.currentStore.span.finish()
  }
}

module.exports = ApolloGatewayValidatePlugin
