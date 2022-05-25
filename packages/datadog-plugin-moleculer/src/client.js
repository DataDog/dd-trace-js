'use strict'

const { storage } = require('../../datadog-core')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const { moleculerTags } = require('./util')

class MoleculerClientPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.addSub('apm:moleculer:call:start', ({ actionName, params, opts }) => {
      const store = storage.getStore()
      const childOf = store && store.span
      const span = this.tracer.startSpan('moleculer.call', {
        childOf,
        tags: {
          'service.name': this.config.service || this.tracer._service,
          'span.kind': 'client',
          'resource.name': actionName
        }
      })

      this.tracer.inject(span, 'text_map', opts.meta)

      this.enter(span, store)
    })

    this.addSub('apm:moleculer:call:finish', ({ broker, ctx }) => {
      const store = storage.getStore()
      const span = store.span

      if (ctx) {
        const endpoint = ctx.endpoint || {}
        const node = endpoint.node || {}

        span.addTags({
          'out.host': node.hostname,
          'out.port': node.port,
          ...moleculerTags(broker, ctx, this.config)
        })
      }

      span.finish()
    })

    this.addSub('apm:moleculer:call:error', this.addError)
  }
}

module.exports = MoleculerClientPlugin
