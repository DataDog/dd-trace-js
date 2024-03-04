'use strict'

const TracingPlugin = require('../../../dd-trace/src/plugins/tracing')
const { storage } = require('../../../datadog-core')

class ApolloGatewayFetchPlugin extends TracingPlugin {
  static get id () { return 'apollo.gateway' }
  static get operation () { return 'fetch' }
  static get type () { return 'web' }
  static get kind () { return 'server' }

  static get prefix () {
    return 'tracing:apm:apollo:gateway:fetch'
  }

  bindStart (ctx) {
    const store = storage.getStore()
    const childOf = store ? store.span : null

    const spanData = {
      childOf,
      service: this.serviceName(
        { id: `${this.constructor.id}.${this.constructor.operation}`, pluginConfig: this.config }),
      type: this.constructor.type,
      meta: {}
    }

    const serviceName = ctx?.attributes?.service

    if (serviceName) { spanData.meta['serviceName'] = serviceName }

    const span = this.startSpan(this.operationName({ id: `${this.constructor.id}.${this.constructor.operation}` })
      , spanData, false)

    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }
}

module.exports = ApolloGatewayFetchPlugin
