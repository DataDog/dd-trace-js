'use strict'

const {
  addHook,
  channel,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

// Create channels for Confluent Kafka JavaScript
const channels = {
  producerStart: channel('apm:confluentinc-kafka-javascript:produce:start'),
  producerFinish: channel('apm:confluentinc-kafka-javascript:produce:finish'),
  producerError: channel('apm:confluentinc-kafka-javascript:produce:error'),
  producerCommit: channel('apm:confluentinc-kafka-javascript:produce:commit'),
  consumerStart: channel('apm:confluentinc-kafka-javascript:consume:start'),
  consumerFinish: channel('apm:confluentinc-kafka-javascript:consume:finish'),
  consumerError: channel('apm:confluentinc-kafka-javascript:consume:error'),
  consumerCommit: channel('apm:confluentinc-kafka-javascript:consume:commit')
}

// Customize the instrumentation for Confluent Kafka JavaScript
addHook({ name: '@confluentinc/kafka-javascript', versions: ['>=1.0.0'] }, (module) => {
  // Hook native module classes first
  instrumentNativeModule(module)

  // Then hook KafkaJS if it exists
  if (module.KafkaJS) {
    instrumentKafkaJS(module.KafkaJS)
  }

  return module
})

function instrumentNativeModule (module) {
  // Hook the Producer class if it exists
  if (typeof module.Producer === 'function') {
    shimmer.wrap(module, 'Producer', function wrapProducer (original) {
      return function wrappedProducer () {
        const producer = original.apply(this, arguments)

        // Hook the produce method
        if (producer && typeof producer.produce === 'function') {
          shimmer.wrap(producer, 'produce', function wrapProduce (produce) {
            return function wrappedProduce (topic, partition, message, key, timestamp, opaque) {
              if (!channels.producerStart.hasSubscribers) {
                return produce.apply(this, arguments)
              }

              const brokers = this.client && this.client.brokers ? this.client.brokers.join(',') : ''

              const asyncResource = new AsyncResource('bound-anonymous-fn')
              return asyncResource.runInAsyncScope(() => {
                try {
                  channels.producerStart.publish({
                    topic,
                    messages: [{ key, value: message }],
                    bootstrapServers: brokers
                  })

                  const result = produce.apply(this, arguments)

                  channels.producerCommit.publish(result)
                  channels.producerFinish.publish(undefined)
                  return result
                } catch (error) {
                  channels.producerError.publish(error)
                  channels.producerFinish.publish(undefined)
                  throw error
                }
              })
            }
          })
        }

        return producer
      }
    })
  }

  // Hook the Consumer class if it exists
  if (typeof module.Consumer === 'function') {
    shimmer.wrap(module, 'Consumer', function wrapConsumer (original) {
      return function wrappedConsumer () {
        const consumer = original.apply(this, arguments)
        const groupId = this.groupId || (arguments[0] && arguments[0].groupId)

        // Wrap the consume method
        if (consumer && typeof consumer.consume === 'function') {
          shimmer.wrap(consumer, 'consume', function wrapConsume (consume) {
            return function wrappedConsume (numMessages, callback) {
              if (!channels.consumerStart.hasSubscribers) {
                return consume.apply(this, arguments)
              }

              // Handle callback-based consumption
              if (typeof callback === 'function') {
                return consume.call(this, numMessages, function wrappedCallback (err, messages) {
                  if (messages && messages.length > 0) {
                    messages.forEach(message => {
                      channels.consumerStart.publish({
                        topic: message.topic,
                        partition: message.partition,
                        message,
                        groupId
                      })
                      channels.consumerFinish.publish(undefined)
                    })
                  }

                  if (err) {
                    channels.consumerError.publish(err)
                  }

                  return callback.apply(this, arguments)
                })
              }

              // If it's returning a promise
              const result = consume.apply(this, arguments)
              if (result && typeof result.then === 'function') {
                return result.then(messages => {
                  if (messages && messages.length > 0) {
                    messages.forEach(message => {
                      channels.consumerStart.publish({
                        topic: message.topic,
                        partition: message.partition,
                        message,
                        groupId
                      })
                      channels.consumerFinish.publish(undefined)
                    })
                  }
                  return messages
                }).catch(err => {
                  channels.consumerError.publish(err)
                  throw err
                })
              }

              return result
            }
          })
        }

        return consumer
      }
    })
  }
}

function instrumentKafkaJS (kafkaJS) {
  // Hook the Kafka class if it exists
  if (typeof kafkaJS.Kafka === 'function') {
    shimmer.wrap(kafkaJS, 'Kafka', function wrapKafka (OriginalKafka) {
      return function KafkaWrapper (options) {
        const kafka = new OriginalKafka(options)
        const kafkaJSOptions = options.kafkaJS || options
        const brokers = kafkaJSOptions.brokers ? kafkaJSOptions.brokers.join(',') : ''

        // Store brokers for later use
        kafka._ddBrokers = brokers

        // Wrap the producer method if it exists
        if (typeof kafka.producer === 'function') {
          shimmer.wrap(kafka, 'producer', function wrapProducerMethod (producerMethod) {
            return function wrappedProducerMethod () {
              const producer = producerMethod.apply(this, arguments)

              // Wrap the send method of the producer
              if (producer && typeof producer.send === 'function') {
                shimmer.wrap(producer, 'send', function wrapSend (send) {
                  return function wrappedSend (payload) {
                    if (!channels.producerStart.hasSubscribers) {
                      return send.apply(this, arguments)
                    }

                    const asyncResource = new AsyncResource('bound-anonymous-fn')
                    return asyncResource.runInAsyncScope(() => {
                      try {
                        channels.producerStart.publish({
                          topic: payload.topic,
                          messages: payload.messages || [],
                          bootstrapServers: kafka._ddBrokers
                        })

                        const result = send.apply(this, arguments)

                        if (result && typeof result.then === 'function') {
                          return result
                            .then(asyncResource.bind(res => {
                              channels.producerFinish.publish(undefined)
                              channels.producerCommit.publish(res)
                              return res
                            }))
                            .catch(asyncResource.bind(err => {
                              channels.producerError.publish(err)
                              channels.producerFinish.publish(undefined)
                              throw err
                            }))
                        }

                        channels.producerFinish.publish(undefined)
                        return result
                      } catch (error) {
                        channels.producerError.publish(error)
                        channels.producerFinish.publish(undefined)
                        throw error
                      }
                    })
                  }
                })
              }

              return producer
            }
          })
        }

        // Wrap the consumer method if it exists
        if (typeof kafka.consumer === 'function') {
          shimmer.wrap(kafka, 'consumer', function wrapConsumerMethod (consumerMethod) {
            return function wrappedConsumerMethod (config) {
              const consumer = consumerMethod.apply(this, arguments)
              const groupId = config && ((config.kafkaJS && config.kafkaJS.groupId) || config.groupId)

              // Wrap the run method for handling message consumption
              if (consumer && typeof consumer.run === 'function') {
                shimmer.wrap(consumer, 'run', function wrapRun (run) {
                  return function wrappedRun (options) {
                    if (!channels.consumerStart.hasSubscribers) {
                      return run.apply(this, arguments)
                    }

                    const eachMessage = options.eachMessage
                    if (eachMessage) {
                      options.eachMessage = function wrappedEachMessage (payload) {
                        const asyncResource = new AsyncResource('bound-anonymous-fn')
                        return asyncResource.runInAsyncScope(() => {
                          channels.consumerStart.publish({
                            topic: payload.topic,
                            partition: payload.partition,
                            message: payload.message,
                            groupId
                          })

                          try {
                            const result = eachMessage.apply(this, arguments)

                            if (result && typeof result.then === 'function') {
                              return result
                                .then(asyncResource.bind(res => {
                                  channels.consumerFinish.publish(undefined)
                                  return res
                                }))
                                .catch(asyncResource.bind(err => {
                                  channels.consumerError.publish(err)
                                  channels.consumerFinish.publish(undefined)
                                  throw err
                                }))
                            }

                            channels.consumerFinish.publish(undefined)
                            return result
                          } catch (error) {
                            channels.consumerError.publish(error)
                            channels.consumerFinish.publish(undefined)
                            throw error
                          }
                        })
                      }
                    }

                    const eachBatch = options.eachBatch
                    if (eachBatch) {
                      // Similar handling for batch processing if needed
                    }

                    return run.apply(this, arguments)
                  }
                })
              }

              return consumer
            }
          })
        }

        return kafka
      }
    })
  }
}
