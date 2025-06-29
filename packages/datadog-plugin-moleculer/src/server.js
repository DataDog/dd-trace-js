'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { moleculerTags } = require('./util')

class MoleculerServerPlugin extends ServerPlugin {
  static get id () { return 'moleculer' }
  static get operation () { return 'action' }

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
        ...moleculerTags(broker, middlewareCtx, this.config)
      }
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = MoleculerServerPlugin
