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
  shimmer.wrap(EventHubProducerClient.prototype, 'sendBatch', wrapMethod)
  shimmer.wrap(EventHubProducerClient.prototype, 'createBatch',
    createBatch => async function (name, arg) {
      const batch = await createBatch.apply(this, arguments)
      shimmer.wrap(batch, 'tryAdd', tryAdd => function (eventData) {
        const ctx = { name, arg, eventData }
        return producerCh.tracePromise(tryAdd, ctx, this, ...arguments)
      })
      return batch
    })
  return obj
})

function wrapMethod (method) {
  return function(name, arg) {
    console.log('wrapMethod called with name:', name, 'arg:', arg)
    const methodName = method.name
    const ctx = {name, arg, methodName}
    return producerCh.tracePromise(method, { ctx }, this, ...arguments)
  }
}
