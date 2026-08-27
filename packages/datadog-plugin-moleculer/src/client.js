'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { identityService, noServiceSource } = require('../../dd-trace/src/service-naming/helpers')
const { moleculerTags } = require('./util')

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'moleculer.call',
    serviceName: identityService,
    serviceSource: noServiceSource,
  },
  v1: {
    operationName: () => 'moleculer.client.request',
    serviceName: identityService,
    serviceSource: noServiceSource,
  },
}

class MoleculerClientPlugin extends ClientPlugin {
  static id = 'moleculer'
  static operation = 'call'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

  bindStart (ctx) {
    const { actionName, opts } = ctx

    const span = this.startSpan(this.operationName(), {
      service: this.config.service || this.serviceName(),
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
