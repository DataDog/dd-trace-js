'use strict'

const { channel, addHook } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const startChannel = channel('apm:moleculer:call:start')
const finishChannel = channel('apm:moleculer:call:finish')
const errorChannel = channel('apm:moleculer:call:error')

function wrapCall (call) {
  return function (actionName, params, opts) {
    opts = arguments[2] = opts || {}
    opts.meta = opts.meta || {}

    arguments.length = Math.max(3, arguments.length)

    const ctx = { actionName, params, opts }
    return startChannel.runStores(ctx, () => {
      const promise = call.apply(this, arguments)
      const broker = this
      ctx.promiseCtx = promise.ctx
      ctx.broker = broker

      return promise
        .then(
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
    })
  }
}

addHook({ name: 'moleculer', versions: ['>=0.14'] }, moleculer => {
  shimmer.wrap(moleculer.ServiceBroker.prototype, 'call', wrapCall)

  return moleculer
})
