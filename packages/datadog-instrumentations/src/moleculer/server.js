'use strict'

const { channel, addHook, AsyncResource } = require('../helpers/instrument')
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

      return function datadogMiddleware (ctx) {
        const actionResource = new AsyncResource('bound-anonymous-fn')

        return actionResource.runInAsyncScope(() => {
          startChannel.publish({ action, ctx, broker })

          try {
            return next(ctx).then(
              result => {
                finishChannel.publish()
                return result
              },
              error => {
                errorChannel.publish(error)
                finishChannel.publish()
                throw error
              }
            )
          } catch (e) {
            errorChannel.publish(e)
            finishChannel.publish()
          }
        })
      }
    }
  }
}

addHook({ name: 'moleculer', versions: ['>=0.14'] }, moleculer => {
  shimmer.wrap(moleculer.ServiceBroker.prototype, 'registerMiddlewares', wrapRegisterMiddlewares)

  return moleculer
})
