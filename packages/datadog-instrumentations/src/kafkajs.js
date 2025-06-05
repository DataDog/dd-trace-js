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
    const originalSend = producer.send
    const bootstrapServers = this._brokers

    let clusterId
    let disableHeaderInjection = false

    producer.on(producer.events.CONNECT, () => {
      getKafkaClusterId(this).then((id) => {
        clusterId = id
      })
    })

    producer.send = function send (...args) {
      const { topic, messages } = args[0]

      const ctx = {
        bootstrapServers,
        clusterId,
        disableHeaderInjection,
        messages,
        topic
      }

      return producerStartCh.runStores(ctx, () => {
        try {
          const result = originalSend.apply(this, args)
          result.then(
            (res) => {
              ctx.result = res
              producerFinishCh.publish(ctx)
              producerCommitCh.publish(ctx)
            },
            (err) => {
              ctx.error = err
              if (err) {
                // Fixes bug where we would inject message headers for kafka brokers that don't support headers
                // (version <0.11). On the error, we disable header injection.
                // Unfortunately the error name / type is not more specific.
                // This approach is implemented by other tracers as well.
                if (err.name === 'KafkaJSProtocolError' && err.type === 'UNKNOWN') {
                  disableHeaderInjection = true
                  log.error('Kafka Broker responded with UNKNOWN_SERVER_ERROR (-1). ' +
                    'Please look at broker logs for more information. ' +
                    'Tracer message header injection for Kafka is disabled.')
                }
                producerErrorCh.publish(err)
              }
              producerFinishCh.publish(ctx)
            })

          return result
        } catch (e) {
          ctx.error = e
          producerErrorCh.publish(ctx)
          producerFinishCh.publish(ctx)
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

    let clusterId

    const originalRun = consumer.run

    consumer.on(consumer.events.CONNECT, () => {
      getKafkaClusterId(this).then((id) => {
        clusterId = id
      })
    })

    consumer.on(consumer.events.COMMIT_OFFSETS, commitsFromEvent)

    const groupId = arguments[0].groupId

    consumer.run = function run ({ eachMessage, eachBatch, ...runArgs }) {
      return originalRun({
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
    return consumer
  })
  return Kafka
})

const wrappedCallback = (fn, startCh, finishCh, errorCh, extractArgs, clusterId) => {
  return typeof fn === 'function'
    ? function (...args) {
      const ctx = {
        extractedArgs: extractArgs(args, clusterId)
      }

      return startCh.runStores(ctx, () => {
        try {
          const result = fn.apply(this, args)
          if (typeof result?.then === 'function') {
            result.then(
              (res) => {
                ctx.result = res
                finishCh.publish(ctx)
              },
              (err) => {
                ctx.error = err
                errorCh.publish(ctx)
                finishCh.publish(ctx)
              })
          } else {
            finishCh.publish(ctx)
          }
          return result
        } catch (e) {
          ctx.error = e
          errorCh.publish(ctx)
          finishCh.publish(ctx)
          throw e
        }
      })
    }
    : fn
}

const getKafkaClusterId = (kafka) => {
  const admin = kafka.admin?.()

  if (!admin?.describeCluster) {
    return Promise.resolve()
  }

  return admin.connect()
    .then(() => {
      return admin.describeCluster()
    })
    .then((clusterInfo) => {
      admin.disconnect().catch(() => {})
      return clusterInfo?.clusterId
    }).catch(() => {
      admin.disconnect().catch(() => {})
    })
}
