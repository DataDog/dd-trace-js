'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { identityService, noServiceSource } = require('../../dd-trace/src/service-naming/helpers')
const { moleculerTags } = require('./util')

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'moleculer.action',
    serviceName: identityService,
    serviceSource: noServiceSource,
  },
  v1: {
    operationName: () => 'moleculer.server.request',
    serviceName: identityService,
    serviceSource: noServiceSource,
  },
}

class MoleculerServerPlugin extends ServerPlugin {
  static id = 'moleculer'
  static operation = 'action'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

  bindStart (ctx) {
    const { action, middlewareCtx, broker } = ctx

    const followsFrom = this.tracer.extract('text_map', middlewareCtx.meta)
    this.startSpan(this.operationName(), {
      childOf: followsFrom || ctx?.currentStore?.span || this.activeSpan,
      service: this.config.service || this.serviceName(),
      resource: action.name,
      kind: 'server',
      type: 'web',
      meta: {
        'resource.name': action.name,
        ...moleculerTags(broker, middlewareCtx, this.config),
      },
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = MoleculerServerPlugin
