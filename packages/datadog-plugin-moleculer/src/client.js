'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { moleculerTags } = require('./util')

class MoleculerClientPlugin extends ClientPlugin {
  static get id () { return 'moleculer' }
  static get operation () { return 'call' }

  start ({ actionName, opts }) {
    const span = this.startSpan(this.operationName(), {
      service: this.config.service || this.serviceName(),
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

    super.finish()
  }
}

module.exports = MoleculerClientPlugin
