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

    // TODO: Change this by hooking into kafka's connect method.
    // That receives the clusterId and we can avoid the admin call.
    // That way the clusterId is also immediately available for all calls.
    producer.on(producer.events.CONNECT, () => {
      getKafkaClusterId(this).then((id) => {
        clusterId = id
      })
    })

    producer.send = function send (...args) {
      // Do not manipulate user input by copying the messages
      let malformedMessage = false
      if (!args[0] || !Array.isArray(args[0].messages)) {
        malformedMessage = true
      } else if (!disableHeaderInjection) {
        args[0] = {
          ...args[0],
          messages: args[0].messages.map((message) => {
            if (typeof message !== 'object' || message === null) {
              malformedMessage = true
              return message
            }
            return { ...message, headers: { ...message.headers } }
          })
        }
      }

      const topic = args[0]?.topic
      const messages = args[0]?.messages

      const ctx = {
        bootstrapServers,
        clusterId,
        disableHeaderInjection,
        messages,
        topic,
        malformedMessage
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
              // TODO: Read the broker's versions (minimum version 3) by hooking into that code.
              // That way all messages would pass and it's clear from the beginning on if headers
              // are allowed or not.
              // Currently we only know that after the first message is sent, which the customer
              // now has to resend.
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

    let clusterId
    const { groupId } = arguments[0]

    const eachMessageExtractor = (args) => {
      const { topic, partition, message } = args[0]
      return { topic, partition, message, groupId, clusterId }
    }

    const eachBatchExtractor = (args) => {
      const { batch } = args[0]
      const { topic, partition, messages } = batch
      return { topic, partition, messages, groupId, clusterId }
    }

    const consumer = createConsumer.apply(this, arguments)

    consumer.on(consumer.events.CONNECT, () => {
      getKafkaClusterId(this).then((id) => {
        clusterId = id
      })
    })

    consumer.on(consumer.events.COMMIT_OFFSETS, commitsFromEvent)

    const originalRun = consumer.run

    consumer.run = function run ({ eachMessage, eachBatch, ...runArgs }) {
      return originalRun({
        eachMessage: wrappedCallback(
          eachMessage,
          consumerStartCh,
          consumerFinishCh,
          consumerErrorCh,
          eachMessageExtractor,
        ),
        eachBatch: wrappedCallback(
          eachBatch,
          batchConsumerStartCh,
          batchConsumerFinishCh,
          batchConsumerErrorCh,
          eachBatchExtractor,
        ),
        ...runArgs
      })
    }
    return consumer
  })
  return Kafka
})

const wrappedCallback = (fn, startCh, finishCh, errorCh, extractArgs) => {
  if (typeof fn !== 'function') {
    return fn
  }
  return function (...args) {
    const ctx = {
      extractedArgs: extractArgs(args)
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
