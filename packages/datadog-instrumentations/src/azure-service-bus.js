/* eslint-disable n/no-unpublished-require */
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

      shimmer.wrap(sender, 'sendMessages', sendMessages => function (msg) {
        const functionName = sendMessages.name
        return producerCh.tracePromise(
          sendMessages, { config, entityPath, functionName, msg }, this, ...arguments
        )
      })

      shimmer.wrap(sender, 'createMessageBatch', createMessageBatch => async function () {
        const batch = await createMessageBatch.apply(this, arguments)
        shimmer.wrap(batch, 'tryAddMessage', tryAddMessage => function (msg) {
          const functionName = tryAddMessage.name
          return producerCh.tracePromise(
            tryAddMessage, { config, entityPath, functionName, batch: this, msg }, this, ...arguments)
        })
        return batch
      })
      return sender
    })
  return obj
})
