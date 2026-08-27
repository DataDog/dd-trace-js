'use strict'

const { storage } = require('../../../../datadog-core')

const { DsmPathwayCodec, getMessageSize } = require('../../datastreams')
const log = require('../../log')
const TracingPlugin = require('../../plugins/tracing')
const TraceManager = require('../trace-manager')
const MessagingLifecycleAdapter = require('./lifecycle-adapter')

const legacyStorage = storage('legacy')
const ADAPTER_ERROR_MESSAGES = {
  consume: {
    complete: 'Messaging consume adapter failed during completion: %s',
    error: 'Messaging consume adapter failed during error: %s',
  },
  produce: {
    complete: 'Messaging produce adapter failed during completion: %s',
    error: 'Messaging produce adapter failed during error: %s',
  },
}

class MessagingProcessor extends TracingPlugin {
  static eventDomain = 'messaging'
  static eventOperation = 'messaging.produce'
  static id = 'messaging'

  #consumers = new WeakMap()
  #lifecycleAdapters
  #traceManager

  /**
   * Create the shared messaging processor for one tracer.
   *
   * @param {object} tracer Tracer instance.
   * @param {object} tracerConfig Global tracer configuration.
   */
  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)

    this.#traceManager = new TraceManager(this)
    this.#lifecycleAdapters = Object.freeze({
      consume: new MessagingLifecycleAdapter(this.#traceManager),
      produce: new MessagingLifecycleAdapter(this.#traceManager),
    })
  }

  /**
   * Compile stable source policy and bind it to this processor.
   *
   * @param {object} runtime Per-tracer package source runtime.
   * @returns {object} Stable source consumer used by the process-wide bridge.
   */
  createSourceConsumer (runtime) {
    const existing = this.#consumers.get(runtime)
    if (existing) return existing

    const { identity, lifecycle } = runtime.adapter
    const lifecycleAdapter = this.#lifecycleAdapters[lifecycle]
    if (!lifecycleAdapter) {
      throw new Error(`Unsupported messaging lifecycle adapter "${lifecycle}"`)
    }
    const integration = identity.integration || runtime.source
    const component = identity.component || integration.replaceAll('-', '_')
    const kind = lifecycle === 'produce' ? 'producer' : 'consumer'
    const policy = Object.freeze({
      component,
      filterError: `${integration}: producerFilter threw, filtering is disabled: %s`,
      integration,
      kind,
      lifecycle,
      messagingOperation: lifecycle === 'produce' ? 'publish' : 'process',
      system: identity.system || integration,
    })
    const consumer = {
      complete: event => this.#complete(event, lifecycleAdapter, lifecycle),
      fail: event => this.#fail(event, lifecycleAdapter, lifecycle),
      start: event => this.#bindStart(event, runtime, policy, lifecycleAdapter, consumer),
    }

    Object.freeze(consumer)
    this.#consumers.set(runtime, consumer)
    return consumer
  }

  /**
   * Suppress legacy automatic tracing-channel subscriptions.
   *
   * @returns {void}
   */
  addTraceSubs () {}

  /**
   * Normalize and start one messaging operation.
   *
   * @param {object} event Package source lifecycle context.
   * @param {object} runtime Per-tracer package source runtime.
   * @param {object} policy Stable messaging source policy.
   * @param {MessagingLifecycleAdapter} lifecycleAdapter Fixed lifecycle adapter.
   * @param {object} consumer Stable source consumer starting the operation.
   * @returns {object | undefined} Store active while the package operation runs.
   */
  #bindStart (event, runtime, policy, lifecycleAdapter, consumer) {
    if (!runtime.enabled) return event.parentStore

    const { facts } = event
    if (!facts || facts.skip) return facts?.skip === 'noop' ? { noop: true } : event.parentStore

    let messages = facts.messages
    if (policy.lifecycle === 'produce') {
      messages = this.#selectMessages(runtime.config.producerFilter, facts, policy)
      if (messages === false) return { noop: true }
    }

    try {
      const options = this.#createOptions(runtime, policy, facts)
      if (policy.lifecycle === 'consume' && facts.carrier) {
        options.childOf = this.#traceManager.extract('text_map', facts.carrier)
      }
      lifecycleAdapter.start(`${policy.component}.${facts.action}`, options, event)
    } catch (error) {
      log.error('Messaging source "%s" failed to start tracing: %s', policy.integration, error?.message || error)
      return event.parentStore
    }

    if (event.sourceConsumer === undefined) {
      event.sourceConsumer = consumer
      if (policy.lifecycle === 'produce') {
        event.currentStore = legacyStorage.run(
          event.currentStore,
          startProduceCapabilities,
          this.#traceManager,
          event,
          runtime.config,
          policy,
          facts,
          messages
        )
      } else {
        event.currentStore = legacyStorage.run(
          event.currentStore,
          startConsumeCapabilities,
          this.#traceManager,
          event,
          runtime.config,
          policy,
          facts
        )
      }
    }

    return event.currentStore
  }

  /**
   * Select producer messages without allowing a user filter to break publishing.
   *
   * @param {Function | undefined} filter User producer filter.
   * @param {object} facts Normalized producer facts.
   * @param {object} policy Stable messaging source policy.
   * @returns {object[] | undefined | false} Accepted messages, absent messages, or a rejected-operation sentinel.
   */
  #selectMessages (filter, facts, policy) {
    const messages = facts.messages
    if (!filter || !messages) return messages

    const accepted = []
    try {
      for (const message of messages) {
        if (filter(message.filter)) accepted.push(message)
      }
    } catch (error) {
      log.error(policy.filterError, error?.message || error)
      return messages
    }

    const filterCount = facts.filterCount ?? facts.messageCount
    return accepted.length === 0 && filterCount > 0 ? false : accepted
  }

  /**
   * Build dynamic messaging tracing options from package facts and compiled source policy.
   *
   * @param {object} runtime Enabled package source runtime.
   * @param {object} policy Stable messaging source policy.
   * @param {object} facts Normalized messaging facts.
   * @returns {object} Resolved tracing options.
   */
  #createOptions (runtime, policy, facts) {
    const config = runtime.config
    const options = {
      component: policy.component,
      config,
      integrationName: policy.integration,
      kind: policy.kind,
      meta: {
        component: policy.component,
        'messaging.system': policy.system,
        'messaging.destination.name': facts.destination,
        'messaging.operation': policy.messagingOperation,
        ...facts.tags,
      },
      resource: facts.destination,
      service: config.service || this.serviceName({
        id: policy.integration,
        kind: policy.kind,
        type: 'messaging',
      }),
      type: 'messaging',
    }
    if (facts.messageCount !== undefined) {
      options.metrics = { 'messaging.batch.message_count': facts.messageCount }
    }
    if (facts.startTime !== undefined) options.startTime = facts.startTime

    return options
  }

  /**
   * Record and finish a failed messaging operation exactly once.
   *
   * @param {object & {error?: unknown}} event Package source lifecycle context.
   * @param {MessagingLifecycleAdapter} lifecycleAdapter Fixed lifecycle adapter.
   * @param {string} lifecycle Fixed lifecycle adapter identifier.
   * @returns {void}
   */
  #fail (event, lifecycleAdapter, lifecycle) {
    try {
      lifecycleAdapter.error(event, event.error, event.metadata)
    } catch (error) {
      log.error(ADAPTER_ERROR_MESSAGES[lifecycle].error, error?.message || error)
    }
  }

  /**
   * Complete and finish a successful messaging operation exactly once.
   *
   * @param {object} event Package source lifecycle context.
   * @param {MessagingLifecycleAdapter} lifecycleAdapter Fixed lifecycle adapter.
   * @param {string} lifecycle Fixed lifecycle adapter identifier.
   * @returns {void}
   */
  #complete (event, lifecycleAdapter, lifecycle) {
    try {
      lifecycleAdapter.complete(event, event.metadata)
    } catch (error) {
      log.error(ADAPTER_ERROR_MESSAGES[lifecycle].complete, error?.message || error)
    }
  }
}

/**
 * Run processor-owned trace propagation and data-streams production inside the operation's bound store.
 *
 * @param {TraceManager} traceManager Processor trace manager.
 * @param {object} event Active source lifecycle event.
 * @param {object} config Immutable source configuration.
 * @param {object} policy Stable messaging source policy.
 * @param {object} facts Normalized producer facts.
 * @param {object[] | undefined} messages Accepted messages.
 * @returns {object | undefined} Store carrying the producer's resulting data-stream context.
 */
function startProduceCapabilities (traceManager, event, config, policy, facts, messages) {
  if (!messages || messages.length === 0) return legacyStorage.getStore()

  let writableCount = 0
  for (const message of messages) {
    if (message.writable !== false) writableCount++
  }
  if (writableCount === 0) return legacyStorage.getStore()

  const writableMessages = new Array(writableCount)
  const carriers = new Array(writableCount)
  let writableIndex = 0
  for (const message of messages) {
    if (message.writable === false) continue
    writableMessages[writableIndex] = message
    carriers[writableIndex] = { carrier: {}, index: message.index }
    writableIndex++
  }

  let updateSource = false
  try {
    for (const { carrier } of carriers) {
      traceManager.inject(event, 'text_map', carrier)
    }
    updateSource = true
  } catch (error) {
    log.error('Messaging source "%s" failed during trace propagation: %s',
      policy.integration, error?.message || error)
  }

  if (config.dsmEnabled) {
    try {
      const edgeTags = ['direction:out', `topic:${facts.destination}`, `type:${policy.system}`]
      for (let i = 0; i < writableMessages.length; i++) {
        const body = writableMessages[i].body
        const payloadSize = body ? getMessageSize(body) : 0
        const pathway = traceManager.setCheckpoint(event, edgeTags, payloadSize)
        DsmPathwayCodec.encode(pathway, carriers[i].carrier)
      }
      updateSource = true
    } catch (error) {
      log.error('Messaging source "%s" failed during data-streams production: %s',
        policy.integration, error?.message || error)
    }
  }

  if (updateSource) event.updates = { carriers }
  return legacyStorage.getStore()
}

/**
 * Run processor-owned data-streams consumption inside the operation's bound store.
 *
 * @param {TraceManager} traceManager Processor trace manager.
 * @param {object} event Active source lifecycle event.
 * @param {object} config Immutable source configuration.
 * @param {object} policy Stable messaging source policy.
 * @param {object} facts Normalized consumer facts.
 * @returns {object | undefined} Store carrying the consumed message's data-stream context.
 */
function startConsumeCapabilities (traceManager, event, config, policy, facts) {
  if (config.dsmEnabled) {
    try {
      traceManager.decodeDataStreamsContext(facts.carrier)
      traceManager.setCheckpoint(
        event,
        ['direction:in', `topic:${facts.destination}`, `type:${policy.system}`],
        facts.body ? getMessageSize(facts.body) : 0
      )
    } catch (error) {
      log.error('Messaging source "%s" failed during data-streams consumption: %s',
        policy.integration, error?.message || error)
    }
  }

  return legacyStorage.getStore()
}

module.exports = MessagingProcessor
