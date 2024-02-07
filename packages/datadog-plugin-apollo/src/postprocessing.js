'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')

class ApolloGatewayPostProcessingPlugin extends TracingPlugin {
  static get id () { return 'apollo' }
  static get operation () { return 'postprocessing' }
  static get type () { return 'apollo' }
  static get kind () { return 'server' }

  bindStart (ctx) {
    console.log(1)
    const store = storage.getStore()
    const childOf = store ? store.span : null

    const span = this.startSpan(this.constructor.operation, {
      childOf,
      service: 'test',
      type: 'apollo-gateway',
      kind: this.constructor.type,
      resource: 'execute',
      meta: {
      }
    }, false)

    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    console.log(2)
    ctx.currentStore.span.finish()
    return ctx.parentStore
  }

  end (ctx) {
    console.log(3)
    if (ctx.result) {
      ctx.currentStore.span.finish()
    }
  }

  error (ctx) {
    console.log(4)
    let error = ctx.error
    const span = ctx.currentStore.span
    // console.log(33, span._duration)
    if (!span._spanContext._tags['error']) {
      // Errors may be wrapped in a context.
      error = (error && error.error) || error
      span.setTag('error', error || 1)
    }
  }
}

module.exports = ApolloGatewayPostProcessingPlugin
