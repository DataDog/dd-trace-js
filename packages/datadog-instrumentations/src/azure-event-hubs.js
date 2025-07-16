'use strict'

const {
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const tracingChannel = require('dc-polyfill').tracingChannel

const producerCh = tracingChannel('apm:azure-event-hub:send')

addHook({
  name: '@azure/event-hubs',
  versions: ['>=6.0.0']
}, obj => {
  const EventHubProducerClient = obj.EventHubProducerClient

  shimmer.wrap(EventHubProducerClient.prototype, 'sendBatch',
    sendBatch => async function (name, arg) {
      return producerCh.tracePromise(sendBatch, {name, arg}, this, ...arguments)
  })

  shimmer.wrap(EventHubProducerClient.prototype, 'createBatch',
    createBatch => async function (name, arg) {
      const batch = await createBatch.apply(this, arguments)
      shimmer.wrap(batch, 'tryAdd', tryAdd => function (eventData) {
        return producerCh.tracePromise(tryAdd, { name, arg, eventData }, this, ...arguments)
      })
      return batch
    })
  return obj
})
