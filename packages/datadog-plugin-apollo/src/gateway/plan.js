
'use strict'

const TracingPlugin = require('../../../dd-trace/src/plugins/tracing')
const { storage } = require('../../../datadog-core')

class ApolloGatewayPlanPlugin extends TracingPlugin {
  static get id () { return 'apollo.gateway' }
  static get operation () { return 'plan' }
  static get type () { return 'web' }
  static get kind () { return 'server' }

  static get prefix () {
    return 'tracing:apm:apollo:gateway:plan'
  }

  bindStart (ctx) {
    const store = storage.getStore()
    const childOf = store ? store.span : null

    const spanData = {
      childOf,
      service: this.config.service,
      type: this.constructor.type,
      kind: this.constructor.kind,
      meta: {}
    }

    const span = this.startSpan(`${this.constructor.id}.${this.constructor.operation}`, spanData, false)
    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  end (ctx) {
    ctx?.currentStore?.span.finish()
  }
}

module.exports = ApolloGatewayPlanPlugin
