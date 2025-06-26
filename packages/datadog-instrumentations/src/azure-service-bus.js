'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')

const producerStartCh = channel('apm:azure:service-bus:produce:start')
const producerErrorCh = channel('apm:azure:service-bus:produce:error')
const producerFinishCh = channel('apm:azure:service-bus:produce:finish')

addHook({ name: '@azure/service-bus', versions: ['>=6'] }, (obj) => {
  const ServiceBusClient = obj.ServiceBusClient
  shimmer.wrap(ServiceBusClient.prototype, 'createSender', createSender => function (queueName) {
    const sender = createSender.apply(this, arguments)
    shimmer.wrap(sender._sender, 'send', send => function (msg) {
      const ctx = { sender, msg }
      return producerStartCh.runStores(ctx, () => {
        return send.apply(this, arguments)
          .then(
            response => {
              producerFinishCh.publish(ctx)
              console.log("Message sent successfully")
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
})
