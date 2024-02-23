'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')

class ApolloGatewayFetchPlugin extends TracingPlugin {
  static get id () { return 'apollo-gateway' }
  static get operation () { return 'fetch' }
  static get type () { return 'apollo-gateway' }
  static get kind () { return 'server' }

  start (ctx) {
    const store = storage.getStore()
    const childOf = store ? store.span : null

    if (childOf._name === `${this.constructor.id}.execute`) {
      const spanData = {
        childOf,
        service: this.config.service,
        type: this.constructor.type,
        kind: this.constructor.kind,
        meta: {}
      }

      if (ctx?.properties?.serviceName) { spanData.meta['serviceName'] = ctx.properties.serviceName }
      this.startSpan(`${this.constructor.id}.${this.constructor.operation}`, spanData)
    }
  }

  end (ctx) {
    super.finish()
  }
}

module.exports = ApolloGatewayFetchPlugin
