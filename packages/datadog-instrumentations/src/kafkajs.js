'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const log = require('../../dd-trace/src/log')

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

const disabledHeaderWeakSet = new WeakSet()

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

    const kafkaClusterIdPromise = getKafkaClusterId(this)

    producer.send = function () {
      const wrappedSend = (clusterId) => {
        const ctx = {}
        ctx.bootstrapServers = bootstrapServers
        ctx.clusterId = clusterId
        ctx.disableHeaderInjection = disabledHeaderWeakSet.has(producer)

        const { topic, messages = [] } = arguments[0]
        for (const message of messages) {
          if (message !== null && typeof message === 'object' && !ctx.disableHeaderInjection) {
            message.headers = message.headers || {}
          }
        }
        ctx.topic = topic
        ctx.messages = messages

        return producerStartCh.runStores(ctx, () => {
          try {
            const result = send.apply(this, arguments)
            result.then(
              (res) => {
                ctx.res = res
                producerFinishCh.runStores(ctx, () => {})
                producerCommitCh.publish(ctx)
              },
              (err) => {
                ctx.err = err
                if (err) {
                  // Fixes bug where we would inject message headers for kafka brokers that don't support headers
                  // (version <0.11). On the error, we disable header injection.
                  // Tnfortunately the error name / type is not more specific.
                  // This approach is implemented by other tracers as well.
                  if (err.name === 'KafkaJSProtocolError' && err.type === 'UNKNOWN') {
                    disabledHeaderWeakSet.add(producer)
                    log.error('Kafka Broker responded with UNKNOWN_SERVER_ERROR (-1). ' +
                      'Please look at broker logs for more information. ' +
                      'Tracer message header injection for Kafka is disabled.')
                  }
                  producerErrorCh.publish(err)
                }
                producerFinishCh.runStores(ctx, () => {})
              })

            return result
          } catch (e) {
            ctx.err = e
            producerErrorCh.publish(ctx)
            producerFinishCh.runStores(ctx, () => {})
            throw e
          }
        })
      }

      if (isPromise(kafkaClusterIdPromise)) {
        // promise is not resolved
        return kafkaClusterIdPromise.then((clusterId) => {
          return wrappedSend(clusterId)
        })
      } else {
        // promise is already resolved
        return wrappedSend(kafkaClusterIdPromise)
      }
    }
    return producer
  })

  shimmer.wrap(Kafka.prototype, 'consumer', createConsumer => function () {
    if (!consumerStartCh.hasSubscribers) {
      return createConsumer.apply(this, arguments)
    }

    const kafkaClusterIdPromise = getKafkaClusterId(this)

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

      if (isPromise(kafkaClusterIdPromise)) {
        // promise is not resolved
        return kafkaClusterIdPromise.then((clusterId) => {
          return wrapConsume(clusterId)
        })
      } else {
        // promise is already resolved
        return wrapConsume(kafkaClusterIdPromise)
      }
    }
    return consumer
  })
  return Kafka
})

const wrappedCallback = (fn, startCh, finishCh, errorCh, extractArgs, clusterId) => {
  return typeof fn === 'function'
    ? function (...args) {
      const ctx = {}
      const extractedArgs = extractArgs(args, clusterId)
      ctx.extractedArgs = extractedArgs

      return startCh.runStores(ctx, () => {
        try {
          const result = fn.apply(this, args)
          if (result && typeof result.then === 'function') {
            result.then(
              (res) => {
                ctx.res = res
                finishCh.runStores(ctx, () => {})
              },
              (err) => {
                ctx.err = err
                if (err) {
                  errorCh.publish(ctx)
                }
                finishCh.runStores(ctx, () => {})
              })
          } else {
            finishCh.runStores(ctx, () => {})
          }
          return result
        } catch (e) {
          ctx.err = e
          errorCh.publish(ctx)
          finishCh.publish(undefined)
          throw e
        }
      })
    }
    : fn
}

const getKafkaClusterId = (kafka) => {
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

function isPromise (obj) {
  return !!obj && (typeof obj === 'object' || typeof obj === 'function') && typeof obj.then === 'function'
}
