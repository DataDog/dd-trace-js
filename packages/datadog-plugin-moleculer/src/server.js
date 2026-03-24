'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { moleculerTags } = require('./util')

class MoleculerServerPlugin extends ServerPlugin {
  static id = 'moleculer'
  static operation = 'action'

  bindStart (ctx) {
    const { action, middlewareCtx, broker } = ctx

    const followsFrom = this.tracer.extract('text_map', middlewareCtx.meta)
    const { name: schemaServiceName, source: schemaServiceSource } = this.serviceName()
    const service = this.config.service || schemaServiceName
    const serviceSource = this.config.service ? 'opt.plugin' : schemaServiceSource
    this.startSpan(this.operationName(), {
      childOf: followsFrom || ctx?.currentStore?.span || this.activeSpan,
      service,
      serviceSource,
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
