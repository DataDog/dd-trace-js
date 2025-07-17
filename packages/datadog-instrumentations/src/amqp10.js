'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'amqp10', file: 'lib/sender_link.js', versions: ['>=3'] }, SenderLink => {
  const startCh = channel('apm:amqp10:send:start')
  const finishCh = channel('apm:amqp10:send:finish')
  const errorCh = channel('apm:amqp10:send:error')
  shimmer.wrap(SenderLink.prototype, 'send', send => function (msg, options) {
    if (!startCh.hasSubscribers) {
      return send.apply(this, arguments)
    }
    const ctx = { link: this }

    return startCh.runStores(ctx, () => {
      try {
        const promise = send.apply(this, arguments)

        if (!promise) {
          finish(finishCh, errorCh)
          return promise
        }

        promise.then(
          () => finish(finishCh, errorCh, null, ctx),
          e => finish(finishCh, errorCh, e, ctx)
        )
        return promise
      } catch (err) {
        finish(finishCh, errorCh, err, ctx)
        throw err
      }
    })
  })
  return SenderLink
})

addHook({ name: 'amqp10', file: 'lib/receiver_link.js', versions: ['>=3'] }, ReceiverLink => {
  const startCh = channel('apm:amqp10:receive:start')
  const finishCh = channel('apm:amqp10:receive:finish')
  const errorCh = channel('apm:amqp10:receive:error')
  shimmer.wrap(ReceiverLink.prototype, '_messageReceived', messageReceived => function (transferFrame) {
    if (!transferFrame || transferFrame.aborted || transferFrame.more) {
      return messageReceived.apply(this, arguments)
    }
    const ctx = { link: this }

    return startCh.runStores(ctx, () => {
      try {
        return messageReceived.apply(this, arguments)
      } catch (err) {
        ctx.error = err
        errorCh.publish(ctx)
        throw err
      } finally {
        finishCh.publish(ctx)
      }
    })
  })
  return ReceiverLink
})

function finish (finishCh, errorCh, error, ctx) {
  if (error) {
    ctx.error = error
    errorCh.publish(ctx)
  }
  finishCh.publish(ctx)
}
