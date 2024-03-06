'use strict'

const { storage } = require('../../../datadog-core')
const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayFetchPlugin extends ApolloBasePlugin {
  static get operation () { return 'fetch' }
  static get prefix () {
    return 'tracing:apm:apollo:gateway:fetch'
  }

  bindStart (ctx) {
    const store = storage.getStore()
    const childOf = store ? store.span : null

    const spanData = {
      childOf,
      service: this.getServiceName(),
      type: this.constructor.type,
      meta: {}
    }

    const serviceName = ctx?.attributes?.service

    if (serviceName) { spanData.meta.serviceName = serviceName }

    const span = this.startSpan(this.getOperationName(), spanData, false)

    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }
}

module.exports = ApolloGatewayFetchPlugin
