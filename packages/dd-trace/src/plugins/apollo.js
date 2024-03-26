const TracingPlugin = require('./tracing')
const { storage } = require('../../../datadog-core')

class ApolloBasePlugin extends TracingPlugin {
  static get id () { return 'apollo.gateway' }
  static get type () { return 'web' }
  static get kind () { return 'server' }

  bindStart (ctx) {
    const store = storage.getStore()
    const childOf = store ? store.span : null

    const span = this.startSpan(this.getOperationName(), {
      childOf,
      service: this.getServiceName(),
      type: this.constructor.type,
      kind: this.constructor.kind,
      meta: {}
    }, false)

    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  end (ctx) {
    // Only synchronous operations would have `result` or `error` on `end`.
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return
    ctx?.currentStore?.span?.finish()
  }

  asyncStart (ctx) {
    ctx?.currentStore?.span.finish()
    return ctx.parentStore
  }

  getServiceName () {
    return this.serviceName({
      id: `${this.constructor.id}.${this.constructor.operation}`,
      pluginConfig: this.config
    })
  }

  getOperationName () {
    return this.operationName({
      id: `${this.constructor.id}.${this.constructor.operation}`
    })
  }
}

module.exports = ApolloBasePlugin
