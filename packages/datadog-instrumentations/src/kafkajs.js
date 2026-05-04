'use strict'

const shimmer = require('../../datadog-shimmer')

const log = require('../../dd-trace/src/log')
const {
  channel,
  addHook,
} = require('./helpers/instrument')
const {
  brokerSupportsMessageHeaders,
  cloneMessagesForInjection,
} = require('./helpers/kafka')

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

// Capture the cluster instance kafkajs creates per producer/consumer so the
// boundary can read `cluster.brokerPool.metadata.clusterId` lazily instead of
// opening a parallel admin connection.
const kCluster = Symbol('dd-trace.kafkajs.cluster')

addHook({ name: 'kafkajs', file: 'src/producer/index.js', versions: ['>=1.4'] }, (createProducer) =>
  shimmer.wrapFunction(createProducer, original => function wrappedCreateProducer (params) {
    const producer = original(params)
    if (params?.cluster) {
      producer[kCluster] = params.cluster
    }
    return producer
  })
)

addHook({ name: 'kafkajs', file: 'src/consumer/index.js', versions: ['>=1.4'] }, (createConsumer) =>
  shimmer.wrapFunction(createConsumer, original => function wrappedCreateConsumer (params) {
    const consumer = original(params)
    if (params?.cluster) {
      consumer[kCluster] = params.cluster
    }
    return consumer
  })
)

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
    const cluster = producer[kCluster]

    let disableHeaderInjection = false

    const refreshHeaderSupport = () => {
      if (!disableHeaderInjection && !brokerSupportsMessageHeaders(cluster?.brokerPool)) {
        disableHeaderInjection = true
        log.info('kafkajs broker negotiated Produce <v3; tracer header injection disabled.')
      }
    }

    producer.send = function (...args) {
      if (!producerStartCh.hasSubscribers) {
        return originalSend.apply(this, args)
      }

      // Fast path: kafkajs has fetched metadata, so versions and clusterId are
      // already on the broker pool.
      const metadata = cluster?.brokerPool?.metadata
      if (metadata) {
        refreshHeaderSupport()
        return runSend.call(this, args, metadata.clusterId)
      }

      // Slow path, taken at most once per producer connect cycle. Prime the
      // metadata fetch kafkajs's send would do internally a few stack frames
      // later. `sharedPromiseTo` collapses our call and kafkajs's call into a
      // single round trip, so total latency is unchanged.
      if (typeof cluster?.refreshMetadataIfNecessary !== 'function') {
        return runSend.call(this, args)
      }
      return cluster.refreshMetadataIfNecessary().then(
        () => {
          refreshHeaderSupport()
          return runSend.call(this, args, cluster.brokerPool?.metadata?.clusterId)
        },
        () => runSend.call(this, args)
      )
    }

    function runSend (args, clusterId) {
      const arg0 = args[0]
      const topic = arg0?.topic
      const inputMessages = Array.isArray(arg0?.messages) ? arg0.messages : []

      // Hand kafkajs and the plugin a shallow clone so injection writes to a
      // tracer-owned object instead of the caller's. Skip the clone when
      // injection is off; nothing downstream mutates the array.
      let messages = inputMessages
      if (!disableHeaderInjection && inputMessages.length > 0) {
        messages = cloneMessagesForInjection(inputMessages)
        args[0] = { ...arg0, messages }
      }

      const ctx = {
        bootstrapServers,
        clusterId,
        disableHeaderInjection,
        messages,
        topic,
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
            (error) => {
              ctx.error = error
              if (error) {
                // Safety net for mixed-version clusters where the seed broker
                // advertised Produce v3+ but the leader we shipped to could
                // not parse the headers, surfacing as KafkaJSProtocolError
                // UNKNOWN (server error code -1).
                if (error.name === 'KafkaJSProtocolError' && error.type === 'UNKNOWN') {
                  disableHeaderInjection = true
                  log.error(
                    // eslint-disable-next-line @stylistic/max-len
                    'Kafka Broker responded with UNKNOWN_SERVER_ERROR (-1). Please look at broker logs for more information. Tracer message header injection for Kafka is disabled.'
                  )
                }
                producerErrorCh.publish(error)
              }
              producerFinishCh.publish(ctx)
            }
          )
          return result
        } catch (error) {
          ctx.error = error
          producerErrorCh.publish(ctx)
          producerFinishCh.publish(ctx)
          throw error
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
    const cluster = consumer[kCluster]
    const groupId = arguments[0].groupId

    const readClusterId = () => cluster?.brokerPool?.metadata?.clusterId

    const eachMessageExtractor = (args) => {
      const { topic, partition, message } = args[0]
      return { topic, partition, message, groupId, clusterId: readClusterId() }
    }

    const eachBatchExtractor = (args) => {
      const { batch } = args[0]
      const { topic, partition, messages } = batch
      return { topic, partition, messages, groupId, clusterId: readClusterId() }
    }

    consumer.on(consumer.events.COMMIT_OFFSETS, (event) => {
      const { payload: { groupId: commitGroupId, topics } } = event
      const clusterId = readClusterId()
      const commitList = []
      for (const { topic, partitions } of topics) {
        for (const { partition, offset } of partitions) {
          commitList.push({
            groupId: commitGroupId,
            partition,
            offset,
            topic,
            clusterId,
          })
        }
      }
      consumerCommitCh.publish(commitList)
    })

    const run = consumer.run

    consumer.run = function ({ eachMessage, eachBatch, ...runArgs }) {
      return run({
        eachMessage: wrappedCallback(
          eachMessage,
          consumerStartCh,
          consumerFinishCh,
          consumerErrorCh,
          eachMessageExtractor
        ),
        eachBatch: wrappedCallback(
          eachBatch,
          batchConsumerStartCh,
          batchConsumerFinishCh,
          batchConsumerErrorCh,
          eachBatchExtractor
        ),
        ...runArgs,
      })
    }

    return consumer
  })

  return Kafka
})

const wrappedCallback = (fn, startCh, finishCh, errorCh, extractArgs) => {
  if (typeof fn !== 'function') return fn
  return function (...args) {
    const ctx = {
      extractedArgs: extractArgs(args),
    }

    return startCh.runStores(ctx, () => {
      try {
        const result = fn.apply(this, args)
        if (result && typeof result.then === 'function') {
          result.then(
            (res) => {
              ctx.result = res
              finishCh.publish(ctx)
            },
            (error) => {
              ctx.error = error
              if (error) {
                errorCh.publish(ctx)
              }
              finishCh.publish(ctx)
            }
          )
        } else {
          finishCh.publish(ctx)
        }
        return result
      } catch (error) {
        ctx.error = error
        errorCh.publish(ctx)
        finishCh.publish(ctx)
        throw error
      }
    })
  }
}
