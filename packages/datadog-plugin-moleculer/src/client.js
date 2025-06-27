'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { moleculerTags } = require('./util')

class MoleculerClientPlugin extends ClientPlugin {
  static get id () { return 'moleculer' }
  static get operation () { return 'call' }

  bindStart (ctx) {
    const { actionName, opts } = ctx

    const span = this.startSpan(this.operationName(), {
      service: this.config.service || this.serviceName(),
      resource: actionName,
      kind: 'client'
    }, ctx)

    this.tracer.inject(span, 'text_map', opts.meta)

    return ctx.currentStore
  }

  finish (ctx) {
    const { promiseCtx, broker } = ctx

    const span = ctx.currentStore.span || this.activeSpan

    if (promiseCtx) {
      const endpoint = promiseCtx.endpoint || {}
      const node = endpoint.node || {}

      this.addHost({ hostname: node.hostname, port: node.port })

      span.addTags(moleculerTags(broker, promiseCtx, this.config))
    }

    super.finish(ctx)
  }
}

module.exports = MoleculerClientPlugin
