'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { moleculerTags } = require('./util')

class MoleculerClientPlugin extends ClientPlugin {
  static id = 'moleculer'
  static operation = 'call'

  bindStart (ctx) {
    const { actionName, opts } = ctx

    const { name: schemaServiceName, source: schemaServiceSource } = this.serviceName()
    const service = this.config.service || schemaServiceName
    const serviceSource = this.config.service ? () => 'opt.plugin' : schemaServiceSource
    const span = this.startSpan(this.operationName(), {
      service,
      serviceSource,
      resource: actionName,
      kind: 'client',
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
