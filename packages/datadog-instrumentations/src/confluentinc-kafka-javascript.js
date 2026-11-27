'use strict'

const shimmer = require('../../datadog-shimmer')

const log = require('../../dd-trace/src/log')
const {
  addHook,
  channel,
} = require('./helpers/instrument')
const { cloneMessages } = require('./helpers/kafka')

// Create channels for Confluent Kafka JavaScript
const channels = {
  producerStart: channel('apm:confluentinc-kafka-javascript:produce:start'),
  producerFinish: channel('apm:confluentinc-kafka-javascript:produce:finish'),
  producerError: channel('apm:confluentinc-kafka-javascript:produce:error'),
  producerCommit: channel('apm:confluentinc-kafka-javascript:produce:commit'),
  consumerStart: channel('apm:confluentinc-kafka-javascript:consume:start'),
  consumerFinish: channel('apm:confluentinc-kafka-javascript:consume:finish'),
  consumerError: channel('apm:confluentinc-kafka-javascript:consume:error'),
  consumerCommit: channel('apm:confluentinc-kafka-javascript:consume:commit'),

  // batch operations
  batchConsumerStart: channel('apm:confluentinc-kafka-javascript:consume-batch:start'),
  batchConsumerFinish: channel('apm:confluentinc-kafka-javascript:consume-batch:finish'),
  batchConsumerError: channel('apm:confluentinc-kafka-javascript:consume-batch:error'),
  batchConsumerCommit: channel('apm:confluentinc-kafka-javascript:consume-batch:commit'),
}

const disabledHeaderWeakSet = new WeakSet()

const EMPTY_CARRIER = Object.create(null)
/** @type {string[]} */
const NO_MERGEABLE_KEYS = []

/** @typedef {string | Buffer} NativeHeaderValue */
/** @typedef {Array<Record<string, NativeHeaderValue>>} NativeHeaders */
/** @typedef {Record<string, NativeHeaderValue | NativeHeaderValue[]>} NativeHeaderCarrier */

/** @type {NativeHeaders} */
const EMPTY_NATIVE_HEADERS = []

/**
 * Confluent replaces its metrics object on disconnect. Use it to keep each result with its connection.
 * @type {WeakMap<object, string>}
 */
const clusterIds = new WeakMap()

addHook({ name: '@confluentinc/kafka-javascript', versions: ['>=1.0.0'] }, (module) => {
  // Hook native module classes first
  instrumentBaseModule(module)

  // Then hook KafkaJS if it exists
  if (module.KafkaJS) {
    instrumentKafkaJS(module.KafkaJS)
  }

  return module
})

addHook({ name: '@confluentinc/kafka-javascript', file: 'lib/client.js', versions: ['>=1.0.0'] }, Client => {
  if (typeof Client?.prototype?.clusterId !== 'function') return Client

  // Confluent accepts an omitted callback. Shimmer lets the SDK own callback validation.
  shimmer.wrap(Client.prototype, 'clusterId', function wrapClusterId (clusterId) {
    return function wrappedClusterId (timeout, callback) {
      // A metadata failure during connect can retry before Confluent replaces its metrics.
      if (typeof callback === 'function' && !this?._isConnecting &&
          (channels.producerStart.hasSubscribers || channels.consumerStart.hasSubscribers)) {
        const metrics = this?.metrics
        if (metrics && typeof metrics === 'object') {
          arguments[1] = function captureClusterId (error, id) {
            if (!error && id) clusterIds.set(metrics, id)
            return Reflect.apply(callback, this, arguments)
          }
        }
      }
      return Reflect.apply(clusterId, this, arguments)
    }
  })
  return Client
})

function instrumentBaseModule (module) {
  // Helper function to wrap producer classes
  function wrapProducerClass (ProducerClass, className) {
    return shimmer.wrap(module, className, function wrapProducer (Original) {
      return function wrappedProducer (...args) {
        const producer = new Original(...args)
        const bootstrapServers = getBootstrapServers(producer.globalConfig)

        // Hook the produce method
        if (typeof producer?.produce === 'function') {
          shimmer.wrap(producer, 'produce', function wrapProduce (produce) {
            return function wrappedProduce (topic, partition, message, key, timestamp, opaque, headers) {
              if (!channels.producerStart.hasSubscribers) {
                return produce.apply(this, arguments)
              }

              const nativeHeaders = Array.isArray(headers) ? headers : EMPTY_NATIVE_HEADERS

              let carrier
              let forwardCallerHeaders = false
              let applicationValues = EMPTY_CARRIER
              let headerKeys = NO_MERGEABLE_KEYS
              if (nativeHeaders.length !== 0) {
                // `__proto__` is a legal Kafka header key and propagation never
                // writes it, so only the seeded carrier needs a null prototype.
                const candidateCarrier = Object.create(null)
                const candidateValues = Object.create(null)
                const candidateKeys = seedNativeHeaderCarrier(nativeHeaders, candidateCarrier, candidateValues)
                if (candidateKeys === undefined) {
                  forwardCallerHeaders = true
                } else if (candidateKeys.length !== 0) {
                  carrier = candidateCarrier
                  applicationValues = candidateValues
                  headerKeys = candidateKeys
                }
              }

              const ctx = {
                topic,
                messages: [{
                  key,
                  value: message,
                  headers: carrier,
                }],
                bootstrapServers,
                clusterId: clusterIds.get(producer.metrics),
              }

              return channels.producerStart.runStores(ctx, () => {
                try {
                  const producedHeaders = forwardCallerHeaders
                    ? nativeHeaders
                    : mergeNativeHeaders(
                      nativeHeaders, headerKeys, applicationValues, ctx.messages[0].headers ?? EMPTY_CARRIER
                    )
                  const result = produce.apply(this, [
                    topic, partition, message, key, timestamp, opaque, producedHeaders,
                  ])

                  ctx.result = result
                  channels.producerCommit.publish(ctx)
                  channels.producerFinish.publish(ctx)
                  return result
                } catch (error) {
                  ctx.error = error
                  channels.producerError.publish(ctx)
                  channels.producerFinish.publish(ctx)
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
      return function wrappedConsumer (...args) {
        const consumer = new Original(...args)
        const groupId = this.groupId || (args[0]?.['group.id'])
        const offsets = new Map()
        const bootstrapServers = getBootstrapServers(consumer.globalConfig)
        let connectionGeneration = 0
        if (typeof consumer.on === 'function') {
          consumer.on('disconnected', () => {
            connectionGeneration++
            offsets.clear()
          })
        }

        // Wrap the consume method
        if (typeof consumer?.consume === 'function') {
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
                const { metrics } = consumer
                const generation = connectionGeneration
                const ctx = { groupId, bootstrapServers, clusterId: undefined }
                return consume.call(this, numMessages, function wrappedCallback (err, messages) {
                  ctx.clusterId = clusterIds.get(metrics)
                  if (messages && messages.length > 0) {
                    const currentOffsets = generation === connectionGeneration ? offsets : undefined
                    for (const message of messages) {
                      ctx.topic = message?.topic
                      ctx.partition = message?.partition
                      ctx.message = message

                      // TODO: We should be using publish here instead of runStores but we need bindStart to be called
                      channels.consumerStart.runStores(ctx, () => {})
                      updateLatestOffset(
                        currentOffsets, message?.topic, message?.partition, message?.offset, groupId, ctx.clusterId
                      )
                    }
                  }

                  if (err) {
                    ctx.error = err
                    channels.consumerError.publish(ctx)
                  }

                  try {
                    const result = callback.apply(this, arguments)
                    if (messages && messages.length > 0) {
                      channels.consumerFinish.publish(ctx)
                    }
                    return result
                  } catch (error) {
                    ctx.error = error
                    channels.consumerError.publish(ctx)
                    channels.consumerFinish.publish(ctx)
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
            shimmer.wrap(consumer, 'commit', commit => wrapCommit(commit, offsets))
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
  if (typeof kafkaJS?.Kafka === 'function') {
    shimmer.wrap(kafkaJS, 'Kafka', function wrapKafka (OriginalKafka) {
      return function KafkaWrapper (options) {
        const kafka = new OriginalKafka(options)

        // Wrap the producer method if it exists
        if (typeof kafka?.producer === 'function') {
          shimmer.wrap(kafka, 'producer', function wrapProducerMethod (producerMethod) {
            return function wrappedProducerMethod (...args) {
              const producer = producerMethod.apply(this, args)
              let connectedClient
              let bootstrapServers

              // Wrap the send method of the producer
              if (producer && typeof producer.send === 'function') {
                shimmer.wrap(producer, 'send', function wrapSend (send) {
                  return function wrappedSend (payload) {
                    if (!channels.producerStart.hasSubscribers) {
                      return send.apply(this, arguments)
                    }

                    const disableHeaderInjection = disabledHeaderWeakSet.has(producer)
                    const nativeClient = connectedClient ?? getConnectedNativeClient(producer)
                    const servers = bootstrapServers ?? getBootstrapServers(nativeClient?.globalConfig)

                    // Hand the underlying client a shallow clone so neither
                    // injection nor the client's auto-fields (it sets
                    // `headers: null` on messages without headers) ever
                    // touch caller-owned objects. With injection disabled the
                    // clone must not seed `headers: {}` either: brokers that
                    // reject any header field cannot recover otherwise.
                    let outgoingPayload = payload
                    if (payload && Array.isArray(payload.messages)) {
                      outgoingPayload = {
                        ...payload,
                        messages: cloneMessages(payload.messages, !disableHeaderInjection),
                      }
                    }

                    const ctx = {
                      topic: outgoingPayload?.topic,
                      messages: outgoingPayload?.messages || [],
                      bootstrapServers: servers,
                      clusterId: clusterIds.get(nativeClient?.metrics),
                      disableHeaderInjection,
                    }

                    return channels.producerStart.runStores(ctx, () => {
                      try {
                        const result = send.call(this, outgoingPayload)

                        result.then((res) => {
                          // KafkaJS can replace a ready native client during connection retries.
                          connectedClient ??= nativeClient
                          bootstrapServers ??= servers
                          ctx.result = res
                          channels.producerCommit.publish(ctx)
                          channels.producerFinish.publish(ctx)
                        }, (error) => {
                          if (error) {
                            // KafkaJS-compat reports `ERR_UNKNOWN` for brokers
                            // <0.11 that cannot parse headers. Stop injecting
                            // for this producer; subsequent sends to the same
                            // broker succeed.
                            if (error.name === 'KafkaJSError' && error.type === 'ERR_UNKNOWN') {
                              disabledHeaderWeakSet.add(producer)
                              log.error(
                                // eslint-disable-next-line @stylistic/max-len
                                'Kafka Broker responded with UNKNOWN_SERVER_ERROR (-1). Please look at broker logs for more information. Tracer message header injection for Kafka is disabled.'
                              )
                            }
                            ctx.error = error
                            channels.producerError.publish(ctx)
                          }
                          channels.producerFinish.publish(ctx)
                        })

                        return result
                      } catch (error) {
                        ctx.error = error
                        channels.producerError.publish(ctx)
                        channels.producerFinish.publish(ctx)
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
        if (typeof kafka?.consumer === 'function') {
          shimmer.wrap(kafka, 'consumer', function wrapConsumerMethod (consumerMethod) {
            return function wrappedConsumerMethod (config) {
              const consumer = consumerMethod.apply(this, arguments)
              const groupId = getGroupId(config)
              const offsets = new Map()

              // Wrap the run method for handling message consumption
              if (typeof consumer?.run === 'function') {
                shimmer.wrap(consumer, 'run', function wrapRun (run) {
                  return function wrappedRun (options) {
                    if (!channels.consumerStart.hasSubscribers || options !== Object(options)) {
                      return run.apply(this, arguments)
                    }

                    const nativeClient = getConnectedNativeClient(consumer)
                    const bootstrapServers = getBootstrapServers(nativeClient?.globalConfig)
                    const metrics = nativeClient?.metrics
                    const runOptions = wrapKafkaRunOptions(options, {
                      eachMessage: callback => wrapKafkaCallback(
                        callback,
                        {
                          startCh: channels.consumerStart,
                          commitCh: channels.consumerCommit,
                          finishCh: channels.consumerFinish,
                          errorCh: channels.consumerError,
                        },
                        (payload) => {
                          return {
                            topic: payload?.topic,
                            partition: payload?.partition,
                            offset: payload?.message?.offset,
                            message: payload?.message,
                            groupId,
                            clusterId: clusterIds.get(metrics),
                            bootstrapServers,
                          }
                        },
                        offsets
                      ),
                      eachBatch: callback => wrapKafkaCallback(
                        callback,
                        {
                          startCh: channels.batchConsumerStart,
                          commitCh: channels.batchConsumerCommit,
                          finishCh: channels.batchConsumerFinish,
                          errorCh: channels.batchConsumerError,
                        },
                        (payload) => {
                          const { batch } = payload
                          return {
                            topic: batch?.topic,
                            partition: batch?.partition,
                            offset: batch?.messages[batch?.messages?.length - 1]?.offset,
                            messages: batch?.messages,
                            groupId,
                            clusterId: clusterIds.get(metrics),
                            bootstrapServers,
                          }
                        },
                        offsets
                      ),
                    })

                    return run.call(this, runOptions)
                  }
                })
              }

              // Wrap the commit method for handling offset commits
              if (typeof consumer?.commitOffsets === 'function') {
                shimmer.wrap(consumer, 'commitOffsets', commit => wrapCommit(commit, offsets))
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

/**
 * @param {object} options
 * @param {Record<'eachMessage' | 'eachBatch',
 *   (callback: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown>} wrap
 */
function wrapKafkaRunOptions (options, wrap) {
  // Confluent checks own properties before copying options. Read from the caller's object so getters run in that order.
  return new Proxy({}, {
    ownKeys () {
      return Reflect.ownKeys(options)
    },
    getOwnPropertyDescriptor (target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(options, key)
      // The proxy has an empty target, including when the caller freezes its options.
      if (descriptor) descriptor.configurable = true
      return descriptor
    },
    get (target, key) {
      const value = Reflect.get(options, key)
      if (typeof value === 'function' && (key === 'eachMessage' || key === 'eachBatch')) return wrap[key](value)
      return value
    },
  })
}

function wrapCommit (commit, offsets) {
  return function wrappedCommit (options) {
    if (!channels.consumerCommit.hasSubscribers) {
      return commit.apply(this, arguments)
    }

    const result = commit.apply(this, arguments)
    const committed = []
    for (const partitions of offsets.values()) {
      for (const record of partitions.values()) committed.push(record)
    }
    channels.consumerCommit.publish(committed)
    offsets.clear()
    return result
  }
}

function wrapKafkaCallback (callback, { startCh, commitCh, finishCh, errorCh }, getPayload, offsets) {
  return function wrappedKafkaCallback (payload) {
    const commitPayload = getPayload(payload)

    const ctx = {
      extractedArgs: commitPayload,
    }

    return startCh.runStores(ctx, () => {
      updateLatestOffset(
        offsets,
        commitPayload?.topic,
        commitPayload?.partition,
        commitPayload?.offset,
        commitPayload?.groupId,
        commitPayload?.clusterId
      )

      try {
        const result = callback.apply(this, arguments)

        if (result && typeof result.then === 'function') {
          return result
            .then((res) => {
              ctx.result = res
              finishCh.publish(ctx)
              return res
            })
            .catch((err) => {
              ctx.error = err
              errorCh.publish(ctx)
              finishCh.publish(ctx)
              throw err
            })
        }
        finishCh.publish(ctx)
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

function getGroupId (config) {
  if (!config) return ''
  if (config.kafkaJS?.groupId) return config.kafkaJS.groupId
  if (config?.groupId) return config.groupId
  if (config['group.id']) return config['group.id']
  return ''
}

function updateLatestOffset (offsets, topic, partition, offset, groupId, clusterId) {
  if (!offsets) return
  let partitions = offsets.get(topic)
  if (!partitions) {
    partitions = new Map()
    offsets.set(topic, partitions)
  }
  partitions.set(partition, {
    topic,
    partition,
    offset,
    groupId,
    clusterId,
  })
}

/** @typedef {{ 'bootstrap.servers'?: string, 'metadata.broker.list'?: string }} BrokerOptions */

/**
 * @param {{ _getInternalClient?: () => NativeClient | null }} client
 */
function getConnectedNativeClient (client) {
  // Confluent applies serializer and deserializer builder results before constructing the native client.
  if (typeof client._getInternalClient !== 'function') return
  const nativeClient = client._getInternalClient()
  if (!nativeClient?.isConnected?.() || nativeClient._isConnecting) return
  return nativeClient
}

/**
 * @param {BrokerOptions} [config]
 */
function getBootstrapServers (config) {
  if (!config) return
  let brokers
  // The binding sets both aliases in property order.
  for (const key of Object.keys(config)) {
    if (key === 'bootstrap.servers' || key === 'metadata.broker.list') {
      brokers = config[key]
    }
  }
  return brokers
}

/**
 * @typedef {object} NativeClient
 * @property {() => boolean} [isConnected]
 * @property {boolean} [_isConnecting]
 * @property {object} [metrics]
 * @property {BrokerOptions} [globalConfig]
 */

/**
 * `Producer::NodeProduce` reads the first *enumerable* own key of each entry and
 * validates the value itself. A `null` or `undefined` entry aborts the process
 * there, so those are the only entries we refuse to hand back to it.
 *
 * @param {NativeHeaders} headers Caller-owned.
 * @param {NativeHeaderCarrier} carrier
 * @param {NativeHeaderCarrier} applicationValues
 * @returns {string[] | undefined} `undefined` when the binding has to reject the
 *   array itself; empty when it cannot consume the array at all.
 * @see https://github.com/confluentinc/confluent-kafka-javascript/blob/v1.9.1/src/producer.cc
 */
function seedNativeHeaderCarrier (headers, carrier, applicationValues) {
  const keys = new Array(headers.length)
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]
    if (header === null || header === undefined) return NO_MERGEABLE_KEYS

    const key = Object.keys(header)[0]
    if (key === undefined) return

    keys[i] = key
    const value = header[key]
    if (typeof value !== 'string' && !Buffer.isBuffer(value)) return

    if (i === 0) {
      carrier[key] = value
      applicationValues[key] = value
      continue
    }

    const previousValue = carrier[key]
    if (previousValue === undefined) {
      carrier[key] = value
    } else if (Array.isArray(previousValue)) {
      previousValue.push(value)
    } else {
      carrier[key] = [previousValue, value]
    }
    applicationValues[key] = carrier[key]
  }
  return keys
}

/**
 * @param {NativeHeaders} headers Caller-owned; surviving entries are forwarded
 *   by reference, never copied or mutated.
 * @param {string[]} headerKeys Parallel to `headers`.
 * @param {NativeHeaderCarrier} applicationValues Carrier contents before
 *   propagation ran.
 * @param {NativeHeaderCarrier} carrier
 */
function mergeNativeHeaders (headers, headerKeys, applicationValues, carrier) {
  const merged = []
  for (let i = 0; i < headerKeys.length; i++) {
    const key = headerKeys[i]
    if (carrier[key] === applicationValues[key]) {
      merged.push(headers[i])
    }
  }

  for (const key of Object.keys(carrier)) {
    if (carrier[key] !== applicationValues[key]) {
      merged.push({ [key]: carrier[key] })
    }
  }
  return merged
}
