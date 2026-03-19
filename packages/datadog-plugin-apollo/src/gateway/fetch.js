'use strict'

const { storage } = require('../../../datadog-core')
const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayFetchPlugin extends ApolloBasePlugin {
  static operation = 'fetch'
  static prefix = 'tracing:apm:apollo:gateway:fetch'

  bindStart (ctx) {
    const store = storage('legacy').getStore()
    const childOf = store ? store.span : null

    const { name: service, source: serviceSource } = this.getServiceName()
    const spanData = {
      childOf,
      service,
      serviceSource,
      type: this.constructor.type,
      meta: {},
    }

    const serviceName = ctx?.attributes?.service

    if (serviceName) { spanData.meta.serviceName = serviceName }

    const span = this.startSpan(this.getOperationName(), spanData, false)

    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  onAsyncStart (ctx) {
    const span = ctx?.currentStore?.span
    this.config.hooks.fetch(span, ctx)
  }
}

module.exports = ApolloGatewayFetchPlugin
