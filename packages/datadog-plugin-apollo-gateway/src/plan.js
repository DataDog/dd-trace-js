
'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')

class ApolloGatewayPlanPlugin extends TracingPlugin {
  static get id () { return 'apollo-gateway' }
  static get operation () { return 'plan' }
  static get type () { return 'apollo-gateway' }
  static get kind () { return 'server' }

  start () {
    const store = storage.getStore()
    const childOf = store ? store.span : null

    if (childOf._name === 'apollo-gateway.request') {
      const spanData = {
        childOf,
        service: this.config.service,
        type: this.constructor.type,
        kind: this.constructor.kind,
        meta: {}
      }

      this.startSpan(`${this.constructor.id}.${this.constructor.operation}`, spanData)
    }
  }
  error (ctx) {
    const { span } = storage.getStore()
    span.setTag('error', ctx.error)
  }
  end () {
    super.finish()
  }
}

module.exports = ApolloGatewayPlanPlugin
