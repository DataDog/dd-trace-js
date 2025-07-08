'use strict'

const { channel, addHook } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const startChannel = channel('apm:moleculer:action:start')
const finishChannel = channel('apm:moleculer:action:finish')
const errorChannel = channel('apm:moleculer:action:error')

function wrapRegisterMiddlewares (registerMiddlewares) {
  return function (userMiddlewares) {
    if (this.middlewares && this.middlewares.add) {
      this.middlewares.add(createMiddleware())
    }

    return registerMiddlewares.apply(this, arguments)
  }
}

function createMiddleware () {
  return {
    name: 'Datadog',

    localAction (next, action) {
      const broker = this

      return shimmer.wrapFunction(next, next => function datadogMiddleware (middlewareCtx) {
        const ctx = { action, middlewareCtx, broker }
        return startChannel.runStores(ctx, () => {
          try {
            return next(middlewareCtx).then(
              result => {
                finishChannel.publish(ctx)
                return result
              },
              error => {
                ctx.error = error
                errorChannel.publish(ctx)
                finishChannel.publish(ctx)
                throw error
              }
            )
          } catch (e) {
            ctx.error = e
            errorChannel.publish(ctx)
            finishChannel.publish(ctx)
          }
        })
      })
    }
  }
}

addHook({ name: 'moleculer', versions: ['>=0.14'] }, moleculer => {
  shimmer.wrap(moleculer.ServiceBroker.prototype, 'registerMiddlewares', wrapRegisterMiddlewares)

  return moleculer
})
