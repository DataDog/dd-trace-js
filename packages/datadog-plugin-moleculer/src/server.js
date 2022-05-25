'use strict'

const { storage } = require('../../datadog-core')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const { moleculerTags } = require('./util')

class MoleculerServerPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.addSub('apm:moleculer:action:start', ({ action, ctx, broker }) => {
      const store = storage.getStore()
      const followsFrom = this.tracer.extract('text_map', ctx.meta)
      const span = this.tracer.startSpan('moleculer.action', {
        childOf: followsFrom || (store && store.span),
        tags: {
          'service.name': this.config.service || this.tracer._service,
          'span.type': 'web',
          'span.kind': 'server',
          'resource.name': action.name,
          ...moleculerTags(broker, ctx, this.config)
        }
      })

      this.enter(span, store)
    })

    this.addSub('apm:moleculer:action:finish', () => {
      const store = storage.getStore()
      const span = store.span

      span.finish()
    })

    this.addSub('apm:moleculer:action:error', this.addError)
  }
}

module.exports = MoleculerServerPlugin
