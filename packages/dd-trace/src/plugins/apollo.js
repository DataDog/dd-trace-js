'use strict'

const { storage } = require('../../../datadog-core')
const TracingPlugin = require('./tracing')

class ApolloBasePlugin extends TracingPlugin {
  static id = 'apollo.gateway'
  static type = 'web'
  static kind = 'server'

  bindStart (ctx) {
    const store = storage('legacy').getStore()
    const childOf = store ? /** @type {import('../opentracing/span') | undefined} */ (store.span) : null

    const span = this.startSpan(this.getOperationName(), {
      childOf,
      service: this.getServiceName(),
      type: this.constructor.type,
      kind: this.constructor.kind,
      meta: {},
    }, false)

    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  end (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return
    this.onEnd(ctx)
    ctx?.currentStore?.span?.finish()
  }

  asyncStart (ctx) {
    this.onAsyncStart(ctx)
    ctx?.currentStore?.span?.finish()
    return ctx.parentStore
  }

  onEnd (ctx) {}

  onAsyncStart (ctx) {}

  getServiceName () {
    return this.serviceName({
      id: `${this.constructor.id}.${this.constructor.operation}`,
      pluginConfig: this.config,
    })
  }

  getOperationName () {
    return this.operationName({
      id: `${this.constructor.id}.${this.constructor.operation}`,
    })
  }
}

module.exports = ApolloBasePlugin
