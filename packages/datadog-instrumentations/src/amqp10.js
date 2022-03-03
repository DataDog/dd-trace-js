'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'amqp10', file: 'lib/sender_link.js', versions: ['>=3'] }, SenderLink => {
  const startCh = channel('apm:amqp10:send:start')
  const asyncEndCh = channel('apm:amqp10:send:async-end')
  const endCh = channel('apm:amqp10:send:end')
  const errorCh = channel('apm:amqp10:send:error')
  shimmer.wrap(SenderLink.prototype, 'send', send => function (msg, options) {
    if (!startCh.hasSubscribers) {
      return send.apply(this, arguments)
    }
    startCh.publish({ link: this })
    try {
      const promise = send.apply(this, arguments)

      if (!promise) {
        finish(asyncEndCh, errorCh)
        return promise
      }

      promise.then(() => AsyncResource.bind(finish(asyncEndCh, errorCh)), e => AsyncResource.bind(finish(asyncEndCh, errorCh, e)))

      return promise
    } catch (err) {
      finish(asyncEndCh, errorCh, err)
      throw err
    } finally {
      endCh.publish(undefined)
    }
  })
  return SenderLink
})

addHook({ name: 'amqp10', file: 'lib/receiver_link.js', versions: ['>=3'] }, ReceiverLink => {
  const startCh = channel('apm:amqp10:receive:start')
  const endCh = channel('apm:amqp10:receive:end')
  const errorCh = channel('apm:amqp10:receive:error')
  shimmer.wrap(ReceiverLink.prototype, '_messageReceived', messageReceived => function (transferFrame) {
    if (!transferFrame || transferFrame.aborted || transferFrame.more) {
      return messageReceived.apply(this, arguments)
    }
    startCh.publish({ link: this })
    try {
      return messageReceived.apply(this, arguments)
    } catch (err) {
      errorCh.publish(err)
      throw err
    } finally {
      endCh.publish(undefined)
    }
  })
  return ReceiverLink
})

function finish (asyncEndCh, errorCh, error) {
  if (error) {
    errorCh.publish(error)
  }
  asyncEndCh.publish(undefined)
}
