'use strict'

const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayFetchPlugin extends ApolloBasePlugin {
  static get operation () { return 'fetch' }
  static get prefix () {
    return 'tracing:apm:apollo:gateway:fetch'
  }

  start (ctx) {
    const store = ctx.parentStore
    const childOf = store ? store.span : null

    const spanData = {
      childOf,
      service: this.getServiceName(),
      type: this.constructor.type,
      meta: {}
    }

    const serviceName = ctx?.attributes?.service

    if (serviceName) { spanData.meta.serviceName = serviceName }

    this.startSpan(this.getOperationName(), spanData, ctx)
  }
}

module.exports = ApolloGatewayFetchPlugin
