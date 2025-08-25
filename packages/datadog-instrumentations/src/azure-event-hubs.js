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
  shimmer.wrap(EventHubProducerClient.prototype, 'sendBatch',
    sendBatch => function (eventData) {
      const functionName = sendBatch.name
      return producerCh.tracePromise(sendBatch, { functionName, eventData }, this, ...arguments)
    })
  return obj
})

addHook({
  name: '@azure/event-hubs',
  versions: ['>=6.0.0'],
  file: 'dist/commonjs/eventDataBatch.js'
}, obj => {
  const eventDataBatchImpl = obj.EventDataBatchImpl
  shimmer.wrap(eventDataBatchImpl.prototype, 'tryAdd', tryAdd =>
    function (eventData, options) {
      const functionName = tryAdd.name
      return producerCh.tracePromise(
        tryAdd,
        { functionName, eventData, options },
        this, ...arguments)
    })
  return obj
})
