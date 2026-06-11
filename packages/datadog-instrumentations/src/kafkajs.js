'use strict'

const shimmer = require('../../datadog-shimmer')

const log = require('../../dd-trace/src/log')
const {
  channel,
  addHook,
} = require('./helpers/instrument')
const {
  brokerSupportsMessageHeaders,
  clientToCluster,
  cloneMessages,
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

const noop = () => {}

addHook({ name: 'kafkajs', file: 'src/producer/index.js', versions: ['>=1.4'] }, (createProducer) =>
  shimmer.wrapFunction(createProducer, original => function wrappedCreateProducer (params) {
    const producer = original(params)
    if (params?.cluster) {
      clientToCluster.set(producer, params.cluster)
    }
    return producer
  })
)

addHook({ name: 'kafkajs', file: 'src/consumer/index.js', versions: ['>=1.4'] }, (createConsumer) =>
  shimmer.wrapFunction(createConsumer, original => function wrappedCreateConsumer (params) {
    const consumer = original(params)
    if (params?.cluster) {
      clientToCluster.set(consumer, params.cluster)
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
    const originalSendBatch = producer.sendBatch
    const bootstrapServers = this._brokers
    const cluster = clientToCluster.get(producer)

    let disableHeaderInjection = false

    let refreshHeaderSupport = () => {
      if (!brokerSupportsMessageHeaders(cluster?.brokerPool)) {
        disableHeaderInjection = true
        refreshHeaderSupport = noop
        log.info('kafkajs broker negotiated Produce <v3; tracer header injection disabled.')
      }
    }

    /**
     * Resolve the negotiated clusterId once and hand it to `call`. Fast path reads
     * `cluster.brokerPool.metadata` synchronously when kafkajs already fetched it.
     * Slow path primes `refreshMetadataIfNecessary`, which `sharedPromiseTo`
     * deduplicates with kafkajs's own internal fetch so total latency is unchanged.
     *
     * @param {(clusterId: string | undefined) => Promise<unknown>} call
     */
    const withClusterId = (call) => {
      const metadata = cluster?.brokerPool?.metadata
      if (metadata) {
        refreshHeaderSupport()
        return call(metadata.clusterId)
      }
      if (typeof cluster?.refreshMetadataIfNecessary !== 'function') {
        return call()
      }
      return cluster.refreshMetadataIfNecessary().then(
        () => {
          refreshHeaderSupport()
          return call(cluster.brokerPool?.metadata?.clusterId)
        },
        () => call()
      )
    }

    producer.send = function (...args) {
      if (!producerStartCh.hasSubscribers) {
        return originalSend.apply(this, args)
      }
      return withClusterId((clusterId) => runSend.call(this, args, clusterId))
    }

    producer.sendBatch = function (...args) {
      if (!producerStartCh.hasSubscribers) {
        return originalSendBatch.apply(this, args)
      }
      return withClusterId((clusterId) => runSendBatch.call(this, args, clusterId))
    }

    function runSend (args, clusterId) {
      const arg0 = args[0]
      const topic = arg0?.topic
      const inputMessages = Array.isArray(arg0?.messages) ? arg0.messages : []

      // Hand kafkajs and the plugin a shallow clone so injection writes to
      // tracer-owned objects instead of the caller's. With injection
      // disabled the clone must not seed `headers: {}` either: brokers that
      // reject any header field cannot recover otherwise.
      let messages = inputMessages
      if (inputMessages.length > 0) {
        messages = cloneMessages(inputMessages, !disableHeaderInjection)
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
                // Safety net for mixed-version clusters where the seed
                // broker advertised Produce v3+ but the leader we shipped to
                // could not parse the headers, surfacing as
                // KafkaJSProtocolError UNKNOWN (server error code -1).
                if (error.name === 'KafkaJSProtocolError' && error.type === 'UNKNOWN') {
                  disableHeaderInjection = true
                  refreshHeaderSupport = noop
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

    function runSendBatch (args, clusterId) {
      const arg0 = args[0]
      const inputTopicMessages = Array.isArray(arg0?.topicMessages) ? arg0.topicMessages : []
      if (inputTopicMessages.length === 0) {
        return originalSendBatch.apply(this, args)
      }

      // One ctx per topicMessages entry — kafkajs implements `send` as a single-entry
      // `sendBatch` (`producer/messageProducer.js`), so one span per entry is the same
      // unit `send` already produces. Cloning only happens for valid arrays so kafkajs
      // still sees and rejects a caller's malformed `messages` field.
      const outputEntries = new Array(inputTopicMessages.length)
      const ctxList = []
      let cloned = false
      for (let i = 0; i < inputTopicMessages.length; i++) {
        const entry = inputTopicMessages[i]
        const topic = entry?.topic
        const rawMessages = entry?.messages
        let entryMessages = rawMessages
        if (Array.isArray(rawMessages) && rawMessages.length > 0) {
          entryMessages = cloneMessages(rawMessages, !disableHeaderInjection)
          outputEntries[i] = { ...entry, messages: entryMessages }
          cloned = true
        } else {
          outputEntries[i] = entry
        }
        ctxList.push({
          bootstrapServers,
          clusterId,
          disableHeaderInjection,
          messages: Array.isArray(entryMessages) ? entryMessages : [],
          topic,
        })
      }
      if (cloned) {
        args[0] = { ...arg0, topicMessages: outputEntries }
      }

      for (const ctx of ctxList) {
        producerStartCh.runStores(ctx, noop)
      }

      let result
      try {
        result = originalSendBatch.apply(this, args)
      } catch (error) {
        failProduceBatch(ctxList, error)
        throw error
      }

      result.then(
        (res) => {
          for (const ctx of ctxList) {
            ctx.result = res
            producerFinishCh.publish(ctx)
          }
          // kafkajs returns a single aggregated response covering every topic;
          // commit fires once so the plugin's `setOffset` loop runs once per
          // entry of the response, not once per span.
          producerCommitCh.publish(ctxList[0])
        },
        (error) => failProduceBatch(ctxList, error)
      )

      return result
    }

    /**
     * Tag every open ctx with the shared error, then publish error + finish so the
     * plugin closes each span. The mixed-version safety net (broker advertised
     * Produce v3+ but the leader rejected the headers) fires at most once per
     * failed batch and short-circuits subsequent sends to the disabled path.
     *
     * @param {Array<object>} ctxList
     * @param {Error} error
     */
    function failProduceBatch (ctxList, error) {
      if (error?.name === 'KafkaJSProtocolError' && error.type === 'UNKNOWN') {
        disableHeaderInjection = true
        refreshHeaderSupport = noop
        log.error(
          // eslint-disable-next-line @stylistic/max-len
          'Kafka Broker responded with UNKNOWN_SERVER_ERROR (-1). Please look at broker logs for more information. Tracer message header injection for Kafka is disabled.'
        )
      }
      for (const ctx of ctxList) {
        ctx.error = error
        producerErrorCh.publish(ctx)
        producerFinishCh.publish(ctx)
      }
    }

    return producer
  })

  shimmer.wrap(Kafka.prototype, 'consumer', createConsumer => function (...args) {
    if (!consumerStartCh.hasSubscribers) {
      return createConsumer.apply(this, args)
    }

    const consumer = createConsumer.apply(this, arguments)
    const cluster = clientToCluster.get(consumer)
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
