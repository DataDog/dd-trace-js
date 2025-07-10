'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')

const producerStartCh = channel('apm:azure-service-bus:send:start')
const producerErrorCh = channel('apm:azure-service-bus:send:error')
const producerFinishCh = channel('apm:azure-service-bus:send:finish')

addHook({ name: '@azure/service-bus', versions: ['>=7.9.2'] }, (obj) => {
  const ServiceBusClient = obj.ServiceBusClient
  shimmer.wrap(ServiceBusClient.prototype, 'createSender', createSender => function (queueOrTopicName) {
    const sender = createSender.apply(this, arguments)
    shimmer.wrap(sender._sender, 'send', send => function (msg) {
      const ctx = { sender, msg }
      return producerStartCh.runStores(ctx, () => {
        return send.apply(this, arguments)
          .then(
            response => {
              producerFinishCh.publish(ctx)
            },
            error => {
              ctx.error = error
              producerErrorCh.publish(ctx)
              producerFinishCh.publish(ctx)
              throw error
            }
          )
      })
    })
    return sender
  })
  return obj
})
