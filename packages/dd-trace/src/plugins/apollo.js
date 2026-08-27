'use strict'

const { storage } = require('../../../datadog-core')
const {
  configuredService,
  optionServiceSource,
} = require('../service-naming/helpers')
const TracingPlugin = require('./tracing')

const legacyStorage = storage('legacy')

/**
 * @param {import('./tracing').NamingOptions} options
 */
function operationName ({ operation }) {
  return `apollo.gateway.${operation}`
}

/** @type {import('./tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName,
    serviceName: configuredService,
    serviceSource: optionServiceSource,
  },
  v1: {
    operationName,
    serviceName: configuredService,
    serviceSource: optionServiceSource,
  },
}

class ApolloBasePlugin extends TracingPlugin {
  static id = 'apollo.gateway'
  static type = 'web'
  static kind = 'server'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

  bindStart (ctx) {
    const store = legacyStorage.getStore()
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
      pluginConfig: this.config,
    })
  }

  getOperationName () {
    return this.operationName({
      operation: this.constructor.operation,
    })
  }
}

module.exports = ApolloBasePlugin
