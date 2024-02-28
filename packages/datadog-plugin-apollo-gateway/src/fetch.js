'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')

class ApolloGatewayFetchPlugin extends TracingPlugin {
  static get id () { return 'apollo-gateway' }
  static get operation () { return 'fetch' }
  static get type () { return 'apollo-gateway' }
  static get kind () { return 'server' }

  static get prefix () {
    return 'tracing:apm:apollo-gateway:fetch'
  }

  bindStart (ctx) {
    const store = storage.getStore()
    const childOf = store ? store.span : null

    const spanData = {
      childOf,
      service: this.config.service,
      type: this.constructor.type,
      meta: {}
    }

    if (ctx?.attributes?.service) { spanData.meta['serviceName'] = ctx?.attributes?.service }

    const span = this.startSpan(`${this.constructor.id}.${this.constructor.operation}`, spanData, false)

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

module.exports = ApolloGatewayFetchPlugin
