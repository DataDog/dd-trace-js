'use strict'

const { moleculerTags } = require('./util')

function createWrapCall (tracer, config) {
  return function wrapCall (call) {
    return function callWithTrace (actionName, params, opts) {
      const options = {
        service: config.service,
        resource: actionName,
        tags: {
          'span.kind': 'client'
        }
      }

      opts = arguments[2] = opts || {}
      opts.meta = opts.meta || {}

      arguments.length = Math.max(3, arguments.length)

      return tracer.trace('moleculer.call', options, () => {
        const span = tracer.scope().active()

        tracer.inject(span, 'text_map', opts.meta)

        const promise = call.apply(this, arguments)

        if (promise.ctx) {
          const endpoint = promise.ctx.endpoint || {}
          const node = endpoint.node || {}

          span.addTags({
            'out.host': node.hostname,
            'out.port': node.port,
            ...moleculerTags(this, promise.ctx, config)
          })
        }

        return promise
      })
    }
  }
}

module.exports = [
  {
    name: 'moleculer',
    versions: ['>=0.14'],
    patch ({ ServiceBroker }, tracer, config) {
      if (config.client === false) return

      config = Object.assign({}, config, config.client)

      this.wrap(ServiceBroker.prototype, 'call', createWrapCall(tracer, config))
    },
    unpatch ({ ServiceBroker }) {
      this.unwrap(ServiceBroker.prototype, 'call')
    }
  }
]
