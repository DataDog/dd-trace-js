'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

// Abstracted channel creation
function createKafkaChannels (prefix) {
  return {
    producerStart: channel(`apm:${prefix}:produce:start`),
    producerCommit: channel(`apm:${prefix}:produce:commit`),
    producerFinish: channel(`apm:${prefix}:produce:finish`),
    producerError: channel(`apm:${prefix}:produce:error`),
    consumerStart: channel(`apm:${prefix}:consume:start`),
    consumerCommit: channel(`apm:${prefix}:consume:commit`),
    consumerFinish: channel(`apm:${prefix}:consume:finish`),
    consumerError: channel(`apm:${prefix}:consume:error`),
    batchConsumerStart: channel(`apm:${prefix}:consume-batch:start`),
    batchConsumerFinish: channel(`apm:${prefix}:consume-batch:finish`),
    batchConsumerError: channel(`apm:${prefix}:consume-batch:error`)
  }
}

// Abstracted producer instrumentation
function instrumentProducer (Kafka, channels, getClusterId, options = {}) {
  const {
    getBootstrapServers = (kafka) => kafka._brokers,
    extractProducerArgs = (args) => ({ topic: args[0].topic, messages: args[0].messages || [] }),
    getProducerResult = (result) => result
  } = options

  shimmer.wrap(Kafka.prototype, 'producer', createProducer => function () {
    const producer = createProducer.apply(this, arguments)
    const send = producer.send
    const bootstrapServers = getBootstrapServers(this)
    const kafkaClusterIdPromise = getClusterId(this)

    producer.send = function () {
      const wrappedSend = (clusterId) => {
        const innerAsyncResource = new AsyncResource('bound-anonymous-fn')

        return innerAsyncResource.runInAsyncScope(() => {
          if (!channels.producerStart.hasSubscribers) {
            return send.apply(this, arguments)
          }

          try {
            const { topic, messages } = extractProducerArgs(arguments)
            for (const message of messages) {
              if (message !== null && typeof message === 'object') {
                message.headers = message.headers || {}
              }
            }
            channels.producerStart.publish({ topic, messages, bootstrapServers, clusterId })

            const result = send.apply(this, arguments)
            const producerResult = getProducerResult(result)

            producerResult.then(
              innerAsyncResource.bind(res => {
                channels.producerFinish.publish(undefined)
                channels.producerCommit.publish(res)
              }),
              innerAsyncResource.bind(err => {
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

      if (!isPromise(kafkaClusterIdPromise)) {
        return wrappedSend(kafkaClusterIdPromise)
      } else {
        return kafkaClusterIdPromise.then((clusterId) => {
          return wrappedSend(clusterId)
        })
      }
    }
    return producer
  })
}

// Abstracted consumer instrumentation
function instrumentConsumer (Kafka, channels, getClusterId, options = {}) {
  const {
    getGroupId = (args) => args[0].groupId,
    extractMessageArgs = (args) => ({ topic: args[0].topic, partition: args[0].partition, message: args[0].message }),
    extractBatchArgs = (args) => ({ topic: args[0].batch.topic, partition: args[0].batch.partition, messages: args[0].batch.messages }),
    handleCommits = (event) => {
      const { payload: { groupId, topics } } = event
      const commitList = []
      for (const { topic, partitions } of topics) {
        for (const { partition, offset } of partitions) {
          commitList.push({ groupId, partition, offset, topic })
        }
      }
      channels.consumerCommit.publish(commitList)
    }
  } = options

  shimmer.wrap(Kafka.prototype, 'consumer', createConsumer => function () {
    if (!channels.consumerStart.hasSubscribers) {
      return createConsumer.apply(this, arguments)
    }

    const kafkaClusterIdPromise = getClusterId(this)
    const groupId = getGroupId(arguments)

    const eachMessageExtractor = (args, clusterId) => {
      const extracted = extractMessageArgs(args)
      return { ...extracted, groupId, clusterId }
    }

    const eachBatchExtractor = (args, clusterId) => {
      const extracted = extractBatchArgs(args)
      return { ...extracted, groupId, clusterId }
    }

    const consumer = createConsumer.apply(this, arguments)

    consumer.on(consumer.events.COMMIT_OFFSETS, handleCommits)

    const run = consumer.run

    consumer.run = function ({ eachMessage, eachBatch, ...runArgs }) {
      const wrapConsume = (clusterId) => {
        return run({
          eachMessage: wrappedCallback(
            eachMessage,
            channels.consumerStart,
            channels.consumerFinish,
            channels.consumerError,
            eachMessageExtractor,
            clusterId
          ),
          eachBatch: wrappedCallback(
            eachBatch,
            channels.batchConsumerStart,
            channels.batchConsumerFinish,
            channels.batchConsumerError,
            eachBatchExtractor,
            clusterId
          ),
          ...runArgs
        })
      }

      if (!isPromise(kafkaClusterIdPromise)) {
        return wrapConsume(kafkaClusterIdPromise)
      } else {
        return kafkaClusterIdPromise.then((clusterId) => {
          return wrapConsume(clusterId)
        })
      }
    }
    return consumer
  })
}

// Common callback wrapper
function wrappedCallback (fn, startCh, finishCh, errorCh, extractArgs, clusterId) {
  return typeof fn === 'function'
    ? function (...args) {
      const innerAsyncResource = new AsyncResource('bound-anonymous-fn')
      return innerAsyncResource.runInAsyncScope(() => {
        const extractedArgs = extractArgs(args, clusterId)

        startCh.publish(extractedArgs)
        try {
          const result = fn.apply(this, args)
          if (result && typeof result.then === 'function') {
            result.then(
              innerAsyncResource.bind(() => finishCh.publish(undefined)),
              innerAsyncResource.bind(err => {
                if (err) {
                  errorCh.publish(err)
                }
                finishCh.publish(undefined)
              })
            )
          } else {
            finishCh.publish(undefined)
          }
          return result
        } catch (e) {
          errorCh.publish(e)
          finishCh.publish(undefined)
          throw e
        }
      })
    }
    : fn
}

// Common cluster ID getter
function getKafkaClusterId (kafka) {
  if (kafka._ddKafkaClusterId) {
    return kafka._ddKafkaClusterId
  }

  if (!kafka.admin) {
    return null
  }

  const admin = kafka.admin()

  if (!admin.describeCluster) {
    return null
  }

  return admin.connect()
    .then(() => {
      return admin.describeCluster()
    })
    .then((clusterInfo) => {
      const clusterId = clusterInfo?.clusterId
      kafka._ddKafkaClusterId = clusterId
      admin.disconnect()
      return clusterId
    })
    .catch((error) => {
      throw error
    })
}

// Common promise check
function isPromise (obj) {
  return !!obj && (typeof obj === 'object' || typeof obj === 'function') && typeof obj.then === 'function'
}

// Export common functionality
module.exports = {
  createKafkaChannels,
  instrumentProducer,
  instrumentConsumer,
  wrappedCallback,
  getKafkaClusterId,
  isPromise
}

// Original kafkajs instrumentation
const channels = createKafkaChannels('kafkajs')

addHook({ name: 'kafkajs', file: 'src/index.js', versions: ['>=1.4'] }, (BaseKafka) => {
  class Kafka extends BaseKafka {
    constructor (options) {
      super(options)
      this._brokers = (options.brokers && typeof options.brokers !== 'function')
        ? options.brokers.join(',')
        : undefined
    }
  }

  instrumentProducer(Kafka, channels, getKafkaClusterId)
  instrumentConsumer(Kafka, channels, getKafkaClusterId)

  return Kafka
})
