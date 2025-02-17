'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'amqp10', file: 'lib/sender_link.js', versions: ['>=3'] }, SenderLink => {
  const startCh = channel('apm:amqp10:send:start')
  const finishCh = channel('apm:amqp10:send:finish')
  const errorCh = channel('apm:amqp10:send:error')
  shimmer.wrap(SenderLink.prototype, 'send', send => function (msg, options) {
    if (!startCh.hasSubscribers) {
      return Reflect.apply(send, this, arguments)
    }
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      startCh.publish({ link: this })
      try {
        const promise = Reflect.apply(send, this, arguments)

        if (!promise) {
          finish(finishCh, errorCh)
          return promise
        }

        promise.then(asyncResource.bind(() => finish(finishCh, errorCh)),
          asyncResource.bind(e => finish(finishCh, errorCh, e)))

        return promise
      } catch (err) {
        finish(finishCh, errorCh, err)
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
      return Reflect.apply(messageReceived, this, arguments)
    }
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      startCh.publish({ link: this })
      try {
        return Reflect.apply(messageReceived, this, arguments)
      } catch (err) {
        errorCh.publish(err)
        throw err
      } finally {
        finishCh.publish()
      }
    })
  })
  return ReceiverLink
})

function finish (finishCh, errorCh, error) {
  if (error) {
    errorCh.publish(error)
  }
  finishCh.publish()
}
