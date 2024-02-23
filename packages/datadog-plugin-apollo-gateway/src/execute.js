'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')

class ApolloGatewayExecutePlugin extends TracingPlugin {
  static get id () { return 'apollo-gateway' }
  static get operation () { return 'execute' }
  static get type () { return 'apollo-gateway' }

  static get prefix () {
    return 'tracing:apm:apollo-gateway:execute'
  }

  bindStart (ctx) {
    const store = storage.getStore()
    const childOf = store ? store.span : null

    const span = this.startSpan(`${this.constructor.id}.${this.constructor.operation}`, {
      childOf,
      service: this.config.service,
      type: this.constructor.type,
      meta: {}
    }, false)

    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  asyncStart (ctx) {
    ctx.currentStore.span.finish()
    return ctx.parentStore
  }

  error (ctx) {
    ctx.currentStore.span.setTag('error', ctx.error)
  }
}

module.exports = ApolloGatewayExecutePlugin
