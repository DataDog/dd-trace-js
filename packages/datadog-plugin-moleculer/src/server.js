'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { moleculerTags } = require('./util')

class MoleculerServerPlugin extends ServerPlugin {
  static id = 'moleculer'
  static operation = 'action'

  bindStart (ctx) {
    const { action, middlewareCtx, broker } = ctx

    const followsFrom = this.tracer.extract('text_map', middlewareCtx.meta)
    const snOpts = {}
    const service = this.config.service || this.serviceName(snOpts)
    const srvSrc = this.config.service
      ? (this.config.serviceFromMapping ? 'opt.mapping' : 'm')
      : snOpts.srvSrc

    this.startSpan(this.operationName(), {
      childOf: followsFrom || ctx?.currentStore?.span || this.activeSpan,
      service,
      srvSrc,
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
