'use strict'

const {
  addHook
} = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')
const dc = require('dc-polyfill')

const producerCh = dc.tracingChannel('apm:azure-service-bus:send')
const isItDefault = new WeakSet()

addHook({ name: '@azure/service-bus', versions: ['>=7.9.2'] }, (obj) => {
  const ServiceBusClient = obj.ServiceBusClient
  shimmer.wrap(ServiceBusClient.prototype, 'createSender',
    createSender => function (queueOrTopicName) {
      const sender = createSender.apply(this, arguments)
      const senderPrototype = sender.constructor.prototype
      const senderSenderPrototype = sender._sender.constructor.prototype

      if (!isItDefault.has(senderPrototype)) {
        isItDefault.add(senderPrototype)

        shimmer.wrap(senderPrototype, 'scheduleMessages', scheduleMessages =>
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

        shimmer.wrap(senderPrototype, 'createMessageBatch', createMessageBatch => async function () {
          const batch = await createMessageBatch.apply(this, arguments)
          shimmer.wrap(batch, 'tryAddMessage', tryAddMessage => function (msg) {
            const functionName = tryAddMessage.name
            const config = this._context.config
            return producerCh.tracePromise(
              tryAddMessage, { config, functionName, batch, msg }, this, ...arguments)
          })
          return batch
        })
      }

      if (!isItDefault.has(senderSenderPrototype)) {
        isItDefault.add(senderSenderPrototype)

        shimmer.wrap(senderSenderPrototype, 'send', send => function (msg) {
          const functionName = send.name
          const config = this._context.config
          const entityPath = this.entityPath
          return producerCh.tracePromise(
            send, { config, entityPath, functionName, msg }, this, ...arguments
          )
        })

        shimmer.wrap(senderSenderPrototype, 'sendBatch', sendBatch => function (msg) {
          const functionName = sendBatch.name
          const config = this._context.config
          const entityPath = this.entityPath
          return producerCh.tracePromise(
            sendBatch, { config, entityPath, functionName, msg }, this, ...arguments
          )
        })
      }
      return sender
    })
  return obj
})
