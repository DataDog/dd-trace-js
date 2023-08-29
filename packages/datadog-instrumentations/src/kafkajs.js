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

const batchConsumerStartCh = channel('apm:kafkajs:consume-batch:start')
const batchConsumerFinishCh = channel('apm:kafkajs:consume-batch:finish')
const batchConsumerErrorCh = channel('apm:kafkajs:consume-batch:error')

addHook({ name: 'kafkajs', file: 'src/index.js', versions: ['>=1.4'] }, (BaseKafka) => {
  class Kafka extends BaseKafka {
    constructor (options) {
      super(options)
      this._brokers = (options.brokers && typeof options.brokers !== 'function')
        ? options.brokers.join(',') : undefined
    }
  }

  shimmer.wrap(Kafka.prototype, 'producer', createProducer => function () {
    const producer = createProducer.apply(this, arguments)
    const send = producer.send
    const bootstrapServers = this._brokers

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
          producerStartCh.publish({ topic, messages, bootstrapServers })

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

  shimmer.wrap(
    Kafka.prototype,
    'consumer',
    (createConsumer) =>
      function () {
        if (!consumerStartCh.hasSubscribers) {
          return createConsumer.apply(this, arguments)
        }

        const consumer = createConsumer.apply(this, arguments)
        const run = consumer.run

        const groupId = arguments[0].groupId
        consumer.run = function ({ eachMessage, eachBatch, ...runArgs }) {
          return run({
            eachMessage:
              typeof eachMessage === 'function'
                ? function (...eachMessageArgs) {
                  const innerAsyncResource = new AsyncResource('bound-anonymous-fn')
                  return innerAsyncResource.runInAsyncScope(() => {
                    const { topic, partition, message } = eachMessageArgs[0]
                    consumerStartCh.publish({ topic, partition, message, groupId })

                    try {
                      const result = eachMessage.apply(this, eachMessageArgs)
                      if (result && typeof result.then === 'function') {
                        result.then(
                          innerAsyncResource.bind(() => consumerFinishCh.publish()),
                          innerAsyncResource.bind((err) => {
                            if (err) {
                              consumerErrorCh.publish(err)
                            }
                            consumerFinishCh.publish()
                          })
                        )
                      } else {
                        consumerFinishCh.publish()
                      }

                      return result
                    } catch (error) {
                      consumerErrorCh.publish(error)
                      consumerFinishCh.publish()
                      throw error
                    }
                  })
                }
                : eachMessage,
            eachBatch:
              typeof eachBatch === 'function'
                ? function (...eachBatchArgs) {
                  const innerAsyncResource = new AsyncResource('bound-anonymous-fn')
                  return innerAsyncResource.runInAsyncScope(() => {
                    const { batch } = eachBatchArgs[0]
                    const { topic, partition, messages } = batch
                    batchConsumerStartCh.publish({ topic, partition, messages, groupId })
                    try {
                      const result = eachBatch.apply(this, eachBatchArgs)
                      if (result && typeof result.then === 'function') {
                        result.then(
                          innerAsyncResource.bind(() => batchConsumerFinishCh.publish()),
                          innerAsyncResource.bind((err) => {
                            if (err) {
                              batchConsumerErrorCh.publish(err)
                            }
                            batchConsumerFinishCh.publish()
                          })
                        )
                      } else {
                        batchConsumerFinishCh.publish()
                      }

                      return result
                    } catch (error) {
                      batchConsumerErrorCh.publish(error)
                      batchConsumerFinishCh.publish()
                      throw error
                    }
                  })
                }
                : eachBatch,
            ...runArgs
          })
        }
        return consumer
      }
  )

  return Kafka
})
