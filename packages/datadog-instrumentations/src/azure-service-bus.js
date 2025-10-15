'use strict'

const {
  addHook
} = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')
const dc = require('dc-polyfill')

const producerCh = dc.tracingChannel('apm:azure-service-bus:send')

addHook({ name: '@azure/service-bus', versions: ['>=7.9.2'], patchDefault: false }, (obj) => {
  const ServiceBusClient = obj.ServiceBusClient
  shimmer.wrap(ServiceBusClient.prototype, 'createSender',
    createSender => function (queueOrTopicName) {
      const sender = createSender.apply(this, arguments)
      const config = sender._context.config
      const entityPath = sender._entityPath

      shimmer.wrap(sender, 'scheduleMessages', scheduleMessages =>
        function (msg, scheduledEnqueueTimeUtc) {
          const functionName = scheduleMessages.name
          return producerCh.tracePromise(
            scheduleMessages,
            { config, entityPath, functionName, msg, scheduledEnqueueTimeUtc },
            this, ...arguments
          )
        })

      shimmer.wrap(sender, 'createMessageBatch', createMessageBatch => async function () {
        const batch = await createMessageBatch.apply(this, arguments)
        shimmer.wrap(batch, 'tryAddMessage', tryAddMessage => function (msg) {
          const functionName = tryAddMessage.name
          return producerCh.tracePromise(
            tryAddMessage, { config, entityPath, functionName, batch, msg }, this, ...arguments)
        })
        return batch
      })

      shimmer.wrap(sender._sender, 'send', send => function (msg) {
        const functionName = send.name
        return producerCh.tracePromise(
          send, { config, entityPath, functionName, msg }, this, ...arguments
        )
      })

      shimmer.wrap(sender._sender, 'sendBatch', sendBatch => function (msg) {
        const functionName = sendBatch.name
        return producerCh.tracePromise(
          sendBatch, { config, entityPath, functionName, msg }, this, ...arguments
        )
      })

      return sender
    })
  return obj
})
