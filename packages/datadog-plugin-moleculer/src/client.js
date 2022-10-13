'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { moleculerTags } = require('./util')

class MoleculerClientPlugin extends ClientPlugin {
  static get name () { return 'moleculer' }
  static get operation () { return 'call' }

  start ({ actionName, opts }) {
    const span = this.startSpan('moleculer.call', {
      service: this.config.service,
      resource: actionName,
      kind: 'client'
    })

    this.tracer.inject(span, 'text_map', opts.meta)
  }

  finish ({ broker, ctx }) {
    const span = this.activeSpan

    if (ctx) {
      const endpoint = ctx.endpoint || {}
      const node = endpoint.node || {}

      this.addHost(node.hostname, node.port)

      span.addTags(moleculerTags(broker, ctx, this.config))
    }

    span.finish()
  }
}

module.exports = MoleculerClientPlugin
