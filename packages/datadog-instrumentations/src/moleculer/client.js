'use strict'

const { channel, addHook } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const startChannel = channel('apm:moleculer:call:start')
const finishChannel = channel('apm:moleculer:call:finish')
const errorChannel = channel('apm:moleculer:call:error')
const patched = new WeakSet()

function wrapCall (call) {
  return function (actionName, params, opts) {
    opts = arguments[2] = opts || {}
    opts.meta ||= {}

    arguments.length = Math.max(3, arguments.length)

    const ctx = { actionName, params, opts }
    return startChannel.runStores(ctx, () => {
      const promise = call.apply(this, arguments)
      const broker = this
      ctx.promiseCtx = promise.ctx
      ctx.broker = broker

      promise
        .then(
          result => {
            finishChannel.publish(ctx)
          },
          error => {
            ctx.error = error
            errorChannel.publish(ctx)
            finishChannel.publish(ctx)
          }
        )
      return promise
    })
  }
}

addHook({ name: 'moleculer', versions: ['>=0.14'] }, moleculer => {
  const proto = moleculer.ServiceBroker.prototype

  if (!patched.has(proto)) {
    patched.add(proto)
    shimmer.wrap(proto, 'call', wrapCall)
  }

  return moleculer
})
