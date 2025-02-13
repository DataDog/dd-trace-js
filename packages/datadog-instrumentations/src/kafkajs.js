'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const producerStartCh = channel('apm:kafkajs:produce:start')
const producerCommitCh = channel('apm:kafkajs:produce:commit')
const producerFinishCh = channel('apm:kafkajs:produce:finish')
const producerErrorCh = channel('apm:kafkajs:produce:error')

const consumerStartCh = channel('apm:kafkajs:consume:start')
const consumerCommitCh = channel('apm:kafkajs:consume:commit')
const consumerFinishCh = channel('apm:kafkajs:consume:finish')
const consumerErrorCh = channel('apm:kafkajs:consume:error')

const batchConsumerStartCh = channel('apm:kafkajs:consume-batch:start')
const batchConsumerFinishCh = channel('apm:kafkajs:consume-batch:finish')
const batchConsumerErrorCh = channel('apm:kafkajs:consume-batch:error')

function commitsFromEvent (event) {
  const { payload: { groupId, topics } } = event
  const commitList = []
  for (const { topic, partitions } of topics) {
    for (const { partition, offset } of partitions) {
      commitList.push({
        groupId,
        partition,
        offset,
        topic
      })
    }
  }
  consumerCommitCh.publish(commitList)
}

addHook({ name: 'kafkajs', file: 'src/index.js', versions: ['>=1.4'] }, (BaseKafka) => {
  class Kafka extends BaseKafka {
    constructor (options) {
      super(options)
      this._brokers = (options.brokers && typeof options.brokers !== 'function')
        ? options.brokers.join(',')
        : undefined
    }
  }

  shimmer.wrap(Kafka.prototype, 'producer', createProducer => function () {
    const producer = createProducer.apply(this, arguments)
    const send = producer.send
    const bootstrapServers = this._brokers

    producer.send = function () {
      const wrappedSend = (clusterId) => {
        try {
          const { topic, messages = [] } = arguments[0]
          for (const message of messages) {
            if (message !== null && typeof message === 'object') {
              message.headers = message.headers || {}
            }
          }
          producerStartCh.publish({ topic, messages, bootstrapServers, clusterId })

          const result = send.apply(this, arguments)

          result.then(
            innerAsyncResource.bind(res => {
              producerFinishCh.publish(undefined)
              producerCommitCh.publish(res)
            }),
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
      }

      const innerAsyncResource = new AsyncResource('bound-anonymous-fn')

      return innerAsyncResource.runInAsyncScope(() => {
        if (!producerStartCh.hasSubscribers) {
          return send.apply(this, arguments)
        }

        const clusterId = getKafkaClusterId(this)

        if (clusterId) {
          return wrappedSend(clusterId)
        }

        return loadKafkaClusterId(this).then(clusterId => wrappedSend(clusterId))
      })
    }

    return producer
  })

  shimmer.wrap(Kafka.prototype, 'consumer', createConsumer => function () {
    if (!consumerStartCh.hasSubscribers) {
      return createConsumer.apply(this, arguments)
    }

    const eachMessageExtractor = (args, clusterId) => {
      const { topic, partition, message } = args[0]
      return { topic, partition, message, groupId, clusterId }
    }

    const eachBatchExtractor = (args, clusterId) => {
      const { batch } = args[0]
      const { topic, partition, messages } = batch
      return { topic, partition, messages, groupId, clusterId }
    }

    const consumer = createConsumer.apply(this, arguments)

    consumer.on(consumer.events.COMMIT_OFFSETS, commitsFromEvent)

    const run = consumer.run
    const groupId = arguments[0].groupId

    consumer.run = function ({ eachMessage, eachBatch, ...runArgs }) {
      const wrapConsume = (clusterId) => {
        return run({
          eachMessage: wrappedCallback(
            eachMessage,
            consumerStartCh,
            consumerFinishCh,
            consumerErrorCh,
            eachMessageExtractor,
            clusterId
          ),
          eachBatch: wrappedCallback(
            eachBatch,
            batchConsumerStartCh,
            batchConsumerFinishCh,
            batchConsumerErrorCh,
            eachBatchExtractor,
            clusterId
          ),
          ...runArgs
        })
      }

      const clusterId = getKafkaClusterId(this)

      if (clusterId) {
        return wrapConsume(clusterId)
      }

      return loadKafkaClusterId(this).then(clusterId => wrapConsume(clusterId))
    }
    return consumer
  })
  return Kafka
})

const wrappedCallback = (fn, startCh, finishCh, errorCh, extractArgs, clusterId) => {
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

const getKafkaClusterId = (kafka) => {
  return kafka._ddKafkaClusterId || null
}

const loadKafkaClusterId = (kafka) => {
  if (!kafka.admin) {
    return Promise.resolve(null)
  }

  const admin = kafka.admin()

  if (!admin.describeCluster) {
    return Promise.resolve(null)
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
}
