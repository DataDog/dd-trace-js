'use strict'

const {
  addHook
} = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')
const dc = require('dc-polyfill')

const producerCh = dc.tracingChannel('apm:azure-service-bus:send')

addHook({ name: '@azure/service-bus', versions: ['>=7.9.2'], patchDefault: false }, (obj) => {
  const ServiceBusClient = obj.ServiceBusClient
  let didItShim = false
  shimmer.wrap(ServiceBusClient.prototype, 'createSender',
    createSender => function (queueOrTopicName) {
      const sender = createSender.apply(this, arguments)
      if (didItShim) return sender
      const proto = sender.constructor.prototype
      const proto2 = sender._sender.constructor.prototype
      shimmer.wrap(proto, 'scheduleMessages', scheduleMessages =>
        function (msg, scheduledEnqueueTimeUtc) {
          const functionName = scheduleMessages.name
          const config = this._context.config
          const entityPath = this._entityPath
          return producerCh.tracePromise(
            scheduleMessages,
            { config, entityPath, functionName, msg, scheduledEnqueueTimeUtc },
            this, ...arguments
          )
        })

      shimmer.wrap(proto, 'createMessageBatch', createMessageBatch => async function () {
        const batch = await createMessageBatch.apply(this, arguments)
        shimmer.wrap(batch.constructor.prototype, 'tryAddMessage', tryAddMessage => function (msg) {
          const functionName = tryAddMessage.name
          const config = this._context.config
          return producerCh.tracePromise(
            tryAddMessage, { config, functionName, batch, msg }, this, ...arguments)
        })
        return batch
      })

      shimmer.wrap(proto2, 'send', send => function (msg) {
        const functionName = send.name
        const config = this._context.config
        const entityPath = this.entityPath
        return producerCh.tracePromise(
          send, { config, entityPath, functionName, msg }, this, ...arguments
        )
      })

      shimmer.wrap(proto2, 'sendBatch', sendBatch => function (msg) {
        const functionName = sendBatch.name
        const config = this._context.config
        const entityPath = this.entityPath
        return producerCh.tracePromise(
          sendBatch, { config, entityPath, functionName, msg }, this, ...arguments
        )
      })
      didItShim = true
      return sender
    })
  return obj
})
