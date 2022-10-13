'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { moleculerTags } = require('./util')

class MoleculerServerPlugin extends ServerPlugin {
  static get name () { return 'moleculer' }
  static get operation () { return 'action' }

  start ({ action, ctx, broker }) {
    const followsFrom = this.tracer.extract('text_map', ctx.meta)

    this.startSpan('moleculer.action', {
      childOf: followsFrom || this.activeSpan,
      service: this.config.service,
      resource: action.name,
      kind: 'server',
      type: 'web',
      meta: {
        'resource.name': action.name,
        ...moleculerTags(broker, ctx, this.config)
      }
    })
  }
}

module.exports = MoleculerServerPlugin
