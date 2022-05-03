'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const producerStartCh = channel('apm:kafkajs:produce:start')
const producerFinishCh = channel('apm:kafkajs:produce:finish')
const producerErrorCh = channel('apm:kafkajs:produce:error')

const consumerStartCh = channel('apm:kafkajs:consume:start')
const consumerFinishCh = channel('apm:kafkajs:consume:finish')
const consumerErrorCh = channel('apm:kafkajs:consume:error')

addHook({ name: 'kafkajs', versions: ['>=1.4'] }, (obj) => {
  const Kafka = obj.Kafka
  shimmer.wrap(Kafka.prototype, 'producer', createProducer => function () {
    const producer = createProducer.apply(this, arguments)
    const send = producer.send

    producer.send = function () {
      const innerAsyncResource = new AsyncResource('bound-anonymous-fn')

      return innerAsyncResource.runInAsyncScope(() => {
        if (!producerStartCh.hasSubscribers) {
          return send.apply(this, arguments)
        }

        try {
          const { topic, messages = [] } = arguments[0]
          for (const message of messages) {
            if (typeof message === 'object') {
              message.headers = message.headers || {}
            }
          }
          producerStartCh.publish({ topic, messages })

          const result = send.apply(this, arguments)

          result.then(
            innerAsyncResource.bind(() => producerFinishCh.publish(undefined)),
            innerAsyncResource.bind(err => {
              if (err) {
                producerErrorCh.publish(err)
              }
              producerFinishCh.publish(undefined)
            })
          )

          return result
        } catch (e) {
          producerErrorCh.publish(e)
          producerFinishCh.publish(undefined)
          throw e
        }
      })
    }
    return producer
  })

  shimmer.wrap(Kafka.prototype, 'consumer', createConsumer => function () {
    if (!consumerStartCh.hasSubscribers) {
      return createConsumer.apply(this, arguments)
    }

    const consumer = createConsumer.apply(this, arguments)
    const run = consumer.run

    consumer.run = function ({ eachMessage, ...runArgs }) {
      if (typeof eachMessage !== 'function') return run({ eachMessage, ...runArgs })

      return run({
        eachMessage: function (...eachMessageArgs) {
          const innerAsyncResource = new AsyncResource('bound-anonymous-fn')
          return innerAsyncResource.runInAsyncScope(() => {
            const { topic, partition, message } = eachMessageArgs[0]
            consumerStartCh.publish({ topic, partition, message })
            try {
              const result = eachMessage.apply(this, eachMessageArgs)

              if (result && typeof result.then === 'function') {
                result.then(
                  innerAsyncResource.bind(() => consumerFinishCh.publish(undefined)),
                  innerAsyncResource.bind(err => {
                    if (err) {
                      consumerErrorCh.publish(err)
                    }
                    consumerFinishCh.publish(undefined)
                  })
                )
              } else {
                consumerFinishCh.publish(undefined)
              }

              return result
            } catch (e) {
              consumerErrorCh.publish(e)
              consumerFinishCh.publish(undefined)
              throw e
            }
          })
        },
        ...runArgs
      })
    }
    return consumer
  })
  return obj
})
