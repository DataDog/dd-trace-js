'use strict'

const {
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const tracingChannel = require('dc-polyfill').tracingChannel

const producerCh = tracingChannel('apm:azure-event-hub:send')

addHook({ name: '@azure/event-hubs', versions: ['>=5.0.0'] }, (obj) => {
  const EventHubProducerClient = obj.EventHubProducerClient
  shimmer.wrap(EventHubProducerClient.prototype, 'sendBatch', sendBatch => function (batch, options) {
    return producerCh.runStores(batch, this, ...arguments)
  })
})
