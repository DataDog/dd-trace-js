'use strict'

const { moleculerTags } = require('./util')

function createWrapRegisterMiddlewares (tracer, config) {
  return function wrapRegisterMiddlewares (registerMiddlewares) {
    return function registerMiddlewaresWithTrace (userMiddlewares) {
      if (this.middlewares && this.middlewares.add) {
        this.middlewares.add(createMiddleware(tracer, config))
      }

      return registerMiddlewares.apply(this, arguments)
    }
  }
}

function createMiddleware (tracer, config) {
  return {
    name: 'Datadog',

    localAction (next, action) {
      const broker = this

      return function datadogMiddleware (ctx) {
        const childOf = tracer.extract('text_map', ctx.meta)
        const options = {
          service: config.service,
          resource: action.name,
          type: 'web',
          tags: {
            'span.kind': 'server',
            ...moleculerTags(broker, ctx, config)
          }
        }

        if (childOf) {
          options.childOf = childOf
        }

        return tracer.trace('moleculer.action', options, () => next(ctx))
      }
    }
  }
}

module.exports = [
  {
    name: 'moleculer',
    versions: ['>=0.14'],
    patch ({ ServiceBroker }, tracer, config) {
      if (config.server === false) return

      config = Object.assign({}, config, config.server)

      this.wrap(ServiceBroker.prototype, 'registerMiddlewares', createWrapRegisterMiddlewares(tracer, config))
    },
    unpatch ({ ServiceBroker }) {
      this.unwrap(ServiceBroker.prototype, 'registerMiddlewares')
    }
  }
]
