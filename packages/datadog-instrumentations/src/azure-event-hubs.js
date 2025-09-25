'use strict'

const {
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const dc = require('dc-polyfill')

const producerCh = dc.tracingChannel('apm:azure-event-hubs:send')

addHook({
  name: '@azure/event-hubs',
  versions: ['>=6.0.0']
}, obj => {
  const EventHubProducerClient = obj.EventHubProducerClient
  shimmer.wrap(EventHubProducerClient.prototype, 'createBatch',
    createBatch => async function () {
      const batch = await createBatch.apply(this, arguments)
      shimmer.wrap(batch, 'tryAdd',
        tryAdd => function (eventData) {
          const config = this._context.config
          const functionName = tryAdd.name
          return producerCh.tracePromise(
            tryAdd,
            { functionName, eventData, batch: this, config },
            this, ...arguments)
        })
      return batch
    })
  shimmer.wrap(EventHubProducerClient.prototype, 'sendBatch',
    sendBatch => function (eventData) {
      const config = this._context.config
      const functionName = sendBatch.name
      return producerCh.tracePromise(sendBatch, { functionName, eventData, config }, this, ...arguments)
    })
  return obj
})
