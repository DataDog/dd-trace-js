'use strict'

const {
  addHook,
  channel,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

// Create channels for Confluent Kafka JavaScript
const channels = {
  producerStart: channel('apm:@confluentinc/kafka-javascript:produce:start'),
  producerFinish: channel('apm:@confluentinc/kafka-javascript:produce:finish'),
  producerError: channel('apm:@confluentinc/kafka-javascript:produce:error'),
  producerCommit: channel('apm:@confluentinc/kafka-javascript:produce:commit'),
  consumerStart: channel('apm:@confluentinc/kafka-javascript:consume:start'),
  consumerFinish: channel('apm:@confluentinc/kafka-javascript:consume:finish'),
  consumerError: channel('apm:@confluentinc/kafka-javascript:consume:error'),
  consumerCommit: channel('apm:@confluentinc/kafka-javascript:consume:commit'),

  // batch operations
  batchConsumerStart: channel('apm:@confluentinc/kafka-javascript:consume-batch:start'),
  batchConsumerFinish: channel('apm:@confluentinc/kafka-javascript:consume-batch:finish'),
  batchConsumerError: channel('apm:@confluentinc/kafka-javascript:consume-batch:error'),
  batchConsumerCommit: channel('apm:@confluentinc/kafka-javascript:consume-batch:commit')
}

// we need to store the offset per partition per topic for the consumer to track offsets for DSM
const latestConsumerOffsets = new Map()

// Customize the instrumentation for Confluent Kafka JavaScript
addHook({ name: '@confluentinc/kafka-javascript', versions: ['>=1.0.0'] }, (module) => {
  // Hook native module classes first
  instrumentBaseModule(module)

  // Then hook KafkaJS if it exists
  if (module.KafkaJS) {
    instrumentKafkaJS(module.KafkaJS)
  }

  return module
})

function instrumentBaseModule (module) {
  // Helper function to wrap producer classes
  function wrapProducerClass (ProducerClass, className) {
    return shimmer.wrap(module, className, function wrapProducer (Original) {
      return function wrappedProducer () {
        const producer = new Original(...arguments)

        // Hook the produce method
        if (producer && typeof producer.produce === 'function') {
          shimmer.wrap(producer, 'produce', function wrapProduce (produce) {
            return function wrappedProduce (topic, partition, message, key, timestamp, opaque) {
              if (!channels.producerStart.hasSubscribers) {
                return produce.apply(this, arguments)
              }

              const brokers = this.globalConfig?.['bootstrap.servers']

              const asyncResource = new AsyncResource('bound-anonymous-fn')
              return asyncResource.runInAsyncScope(() => {
                try {
                  channels.producerStart.publish({
                    topic,
                    messages: [{ key, value: message }],
                    bootstrapServers: brokers
                  })

                  const result = produce.apply(this, arguments)

                  channels.producerCommit.publish(undefined)
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

  // Helper function to wrap consumer classes
  function wrapConsumerClass (ConsumerClass, className) {
    return shimmer.wrap(module, className, function wrapConsumer (Original) {
      return function wrappedConsumer () {
        const consumer = new Original(...arguments)
        const groupId = this.groupId || (arguments[0] && arguments[0]['group.id'])

        // Wrap the consume method
        if (consumer && typeof consumer.consume === 'function') {
          shimmer.wrap(consumer, 'consume', function wrapConsume (consume) {
            return function wrappedConsume (numMessages, callback) {
              if (!channels.consumerStart.hasSubscribers) {
                return consume.apply(this, arguments)
              }

              if (!callback && typeof numMessages === 'function') {
                callback = numMessages
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
                      updateLatestOffset(message.topic, message.partition, message.offset, groupId)
                    })
                  }

                  if (err) {
                    channels.consumerError.publish(err)
                  }

                  try {
                    const result = callback.apply(this, arguments)
                    channels.consumerFinish.publish(undefined)
                    return result
                  } catch (error) {
                    channels.consumerError.publish(error)
                    channels.consumerFinish.publish(undefined)
                    throw error
                  }
                })
              }

              // If no callback is provided, just pass through
              return consume.apply(this, arguments)
            }
          })

          // Wrap the commit method for handling offset commits
          if (consumer && typeof consumer.commit === 'function') {
            shimmer.wrap(consumer, 'commit', wrapCommit)
          }
        }

        return consumer
      }
    })
  }

  // Wrap Producer and KafkaProducer classes if they exist
  if (typeof module.Producer === 'function') {
    wrapProducerClass(module.Producer, 'Producer')
  }
  if (typeof module.KafkaProducer === 'function') {
    wrapProducerClass(module.KafkaProducer, 'KafkaProducer')
  }

  // Wrap Consumer and KafkaConsumer classes if they exist
  if (typeof module.Consumer === 'function') {
    wrapConsumerClass(module.Consumer, 'Consumer')
  }
  if (typeof module.KafkaConsumer === 'function') {
    wrapConsumerClass(module.KafkaConsumer, 'KafkaConsumer')
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

                        result.then(
                          asyncResource.bind(res => {
                            channels.producerCommit.publish(res)
                            channels.producerFinish.publish(undefined)
                          }),
                          asyncResource.bind(err => {
                            if (err) {
                              channels.producerError.publish(err)
                            }
                            channels.producerFinish.publish(undefined)
                          })
                        )

                        return result
                      } catch (e) {
                        channels.producerError.publish(e)
                        channels.producerFinish.publish(undefined)
                        throw e
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
                    const eachBatch = options.eachBatch
                    if (eachMessage) {
                      options.eachMessage = wrapKafkaCallback(
                        eachMessage,
                        {
                          startCh: channels.consumerStart,
                          commitCh: channels.consumerCommit,
                          finishCh: channels.consumerFinish,
                          errorCh: channels.consumerError
                        },
                        (payload) => {
                          return {
                            topic: payload.topic,
                            partition: payload.partition,
                            offset: payload.message.offset,
                            message: payload.message,
                            groupId
                          }
                        })
                    } else if (eachBatch) {
                      options.eachBatch = wrapKafkaCallback(
                        eachBatch,
                        {
                          startCh: channels.batchConsumerStart,
                          commitCh: channels.batchConsumerCommit,
                          finishCh: channels.batchConsumerFinish,
                          errorCh: channels.batchConsumerError
                        },
                        (payload) => {
                          const { batch } = payload
                          return {
                            topic: batch.topic,
                            partition: batch.partition,
                            offset: batch.messages[batch.messages.length - 1].offset,
                            messages: batch.messages,
                            groupId
                          }
                        }
                      )
                    }

                    return run.apply(this, arguments)
                  }
                })
              }

              // Wrap the commit method for handling offset commits
              if (consumer && typeof consumer.commitOffsets === 'function') {
                shimmer.wrap(consumer, 'commitOffsets', wrapCommit)
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

function wrapCommit (commit) {
  return function wrappedCommit (options) {
    if (!channels.consumerCommit.hasSubscribers) {
      return commit.apply(this, arguments)
    }

    const result = commit.apply(this, arguments)
    channels.consumerCommit.publish(getLatestOffsets())
    latestConsumerOffsets.clear()
    return result
  }
}

function wrapKafkaCallback (callback, { startCh, commitCh, finishCh, errorCh }, getPayload) {
  return function wrappedKafkaCallback (payload) {
    const commitPayload = getPayload(payload)

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      startCh.publish(commitPayload)

      updateLatestOffset(commitPayload.topic, commitPayload.partition, commitPayload.offset, commitPayload.groupId)

      try {
        const result = callback.apply(this, arguments)

        if (result && typeof result.then === 'function') {
          return result
            .then(asyncResource.bind(res => {
              finishCh.publish(undefined)
              return res
            }))
            .catch(asyncResource.bind(err => {
              errorCh.publish(err)
              finishCh.publish(undefined)
              throw err
            }))
        } else {
          finishCh.publish(undefined)
          return result
        }
      } catch (error) {
        errorCh.publish(error)
        finishCh.publish(undefined)
        throw error
      }
    })
  }
}

function updateLatestOffset (topic, partition, offset, groupId) {
  const key = `${topic}:${partition}`
  latestConsumerOffsets.set(key, {
    topic,
    partition,
    offset,
    groupId
  })
}

function getLatestOffsets () {
  return Array.from(latestConsumerOffsets.values())
}
