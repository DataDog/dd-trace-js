'use strict'

const {
  EVP_PAYLOAD_SIZE_LIMIT,
  FLAG_EVALUATION_ENDPOINT,
  FLAG_EVALUATION_FLUSH_INTERVAL,
  FLAG_EVALUATION_QUEUE_CAP,
} = require('../constants/constants')
const {
  EVP_EVENT_PLATFORM_SUBDOMAIN,
  EVP_PROXY_PATH_V2,
  EVP_SUBDOMAIN_HEADER_NAME,
} = require('../../evp_proxy/constants')
const { joinEVPProxyPath } = require('../../evp_proxy/path')
const { FlagEvaluationAggregator } = require('./flag-evaluation-aggregation')
const { iterateFlagEvaluationPayloads } = require('./flag-evaluation-payload')
const { normalizeTargetingKey, optionalKey, protectedErrorCode } = require('./flag-evaluation-pii')
const { recordDropped, recordTargetingKeyOmitted } = require('./flag-evaluation-telemetry')
const BaseFFEWriter = require('./base')

/** @typedef {import('./flag-evaluation-aggregation').FlagEvaluationEvent} FlagEvaluationEvent */

/**
 * @typedef {object} FlagEvaluationRoute
 * @property {URL} url
 * @property {string} basePath
 * @property {object} [headers]
 * @property {import('node:https').Agent} [agent]
 * @property {FlagEvaluationRoute} [fallback]
 */

class FlagEvaluationConsumer extends BaseFFEWriter {
  #enabled = false
  #closed = false
  #queue = []
  #immediate
  #aggregator = new FlagEvaluationAggregator()
  #context
  #pendingBytes = 0
  #pending
  #pendingCount = 0
  #pumping = false
  #flushRequested = false
  #onProcessed
  #onDelivered
  #onIdle

  /**
   * @param {import('../../config/config-base')} config
   * @param {FlagEvaluationRoute} [route]
   * @param {object} [callbacks] - Worker ownership callbacks
   * @param {(count: number) => void} [callbacks.onProcessed] - Release input credit after processing
   * @param {(count: number) => void} [callbacks.onDelivered] - Release observations after transport completes
   * @param {() => void} [callbacks.onIdle] - Called once shutdown has drained delivery
   */
  constructor (config, route, { onProcessed, onDelivered, onIdle } = {}) {
    route ??= {
      url: /** @type {URL} */ (config.url),
      basePath: EVP_PROXY_PATH_V2,
    }
    const headers = route.headers ?? { [EVP_SUBDOMAIN_HEADER_NAME]: EVP_EVENT_PLATFORM_SUBDOMAIN }
    super({
      config,
      interval: FLAG_EVALUATION_FLUSH_INTERVAL,
      agentUrl: route.url,
      endpoint: joinEVPProxyPath(route.basePath, FLAG_EVALUATION_ENDPOINT),
      headers,
    })
    if (route.agent || route.fallback) this.#setRoute({ ...route, headers })
    this.#onProcessed = onProcessed
    this.#onDelivered = onDelivered
    this.#onIdle = onIdle

    this.#context = { service: typeof config.service === 'string' ? config.service : '' }
    if (typeof config.env === 'string') this.#context.env = config.env
    if (typeof config.version === 'string') this.#context.version = config.version
  }

  hasCapacity () {
    return this.#enabled && !this.#closed && this.#queue.length < FLAG_EVALUATION_QUEUE_CAP
  }

  /**
   * @param {boolean} enabled
   * @param {FlagEvaluationRoute} [route]
   */
  setEnabled (enabled, route) {
    if (route) this.#setRoute(route)
    if (!enabled && this.#enabled) this.#discardBuffered('unavailable')
    this.#enabled = enabled && !this.#closed
  }

  /** @param {FlagEvaluationEvent} event */
  enqueue (event) {
    if (this.#closed) {
      recordDropped('closed')
      return false
    }
    if (!this.#enabled) {
      recordDropped('unavailable')
      return false
    }
    if (this.#queue.length >= FLAG_EVALUATION_QUEUE_CAP) {
      recordDropped('queue_overflow')
      return false
    }

    const consent = event.observeFullEvaluationData === true
    const targetingKey = normalizeTargetingKey(event.targetingKey)
    if (targetingKey === undefined && event.targetingKey !== undefined && event.targetingKey !== null) {
      recordTargetingKeyOmitted()
    }
    this.#queue.push({
      flagKey: normalizeTargetingKey(event.flagKey),
      variant: optionalKey(event.variant),
      allocationKey: optionalKey(event.allocationKey),
      targetingRuleKey: optionalKey(event.targetingRuleKey),
      runtimeDefault: event.runtimeDefault === true,
      errorCode: protectedErrorCode(event.errorCode),
      targetingKey,
      attrs: consent ? event.attrs : undefined,
      observeFullEvaluationData: consent,
      timestamp: typeof event.timestamp === 'number' ? event.timestamp : NaN,
    })
    if (this.#immediate === undefined) {
      this.#immediate = setImmediate(() => this.#drain())
      this.#immediate.unref?.()
    }
    return true
  }

  flush () {
    this.#cancelImmediate()
    this.#drain()
    if (!this.#enabled && !this.#closed) return
    this.#flushRequested = true
    this.#pump()
  }

  destroy () {
    if (this.#closed) return
    this.#cancelImmediate()
    this.#drain()
    this.#closed = true
    this.#enabled = false
    super.destroy()
  }

  #pump () {
    if (this.#pumping) return
    this.#pumping = true
    try {
      // Reserve a maximum-sized payload before advancing the iterator. HTTP callbacks release this budget.
      while (this.#pendingBytes <= EVP_PAYLOAD_SIZE_LIMIT) {
        if (!this.#pending) {
          if ((!this.#flushRequested && !this.#closed) || this.#aggregator.size === 0) break
          this.#flushRequested = false
          const { full, degraded } = this.#aggregator.take()
          for (const entry of full.values()) this.#pendingCount += entry.count
          for (const entry of degraded.values()) this.#pendingCount += entry.count
          this.#pending = iterateFlagEvaluationPayloads(full, degraded, this.#context, Date.now(), count => {
            this.#pendingCount -= count
          })
        }
        const next = this.#pending.next()
        if (next.done) {
          this.#pending = undefined
          continue
        }
        const payload = next.value
        const bytes = Buffer.byteLength(payload.encoded)
        this.#pendingBytes += bytes
        this._sendPayload(payload.encoded, payload.rows, () => {
          this.#pendingBytes -= bytes
          this.#onDelivered?.(payload.evaluations)
          this.#pump()
        })
      }
    } finally {
      this.#pumping = false
    }
    if (this.#closed && !this.#pending && this.#aggregator.size === 0 && this.#pendingBytes === 0) {
      this.#onIdle?.()
      this.#onIdle = undefined
    }
  }

  /** @param {FlagEvaluationRoute} route */
  #setRoute (route) {
    const headers = route.headers ?? { [EVP_SUBDOMAIN_HEADER_NAME]: EVP_EVENT_PLATFORM_SUBDOMAIN }
    const fallback = route.fallback && {
      url: route.fallback.url,
      endpoint: joinEVPProxyPath(route.fallback.basePath, FLAG_EVALUATION_ENDPOINT),
      headers: route.fallback.headers ?? {},
      agent: route.fallback.agent,
    }
    this._setRoutes({
      url: route.url,
      endpoint: joinEVPProxyPath(route.basePath, FLAG_EVALUATION_ENDPOINT),
      headers,
      agent: route.agent,
    }, fallback)
  }

  #cancelImmediate () {
    if (this.#immediate !== undefined) clearImmediate(this.#immediate)
    this.#immediate = undefined
  }

  #drain () {
    this.#immediate = undefined
    const queue = this.#queue
    this.#queue = []
    for (const event of queue) {
      this.#aggregator.add(event)
      this.#onProcessed?.(1)
    }
  }

  #discardBuffered (reason) {
    this.#cancelImmediate()
    const count = this.#queue.length + this.#aggregator.clear() + this.#pendingCount
    this.#pending?.return()
    this.#pending = undefined
    this.#pendingCount = 0
    this.#flushRequested = false
    this.#onProcessed?.(this.#queue.length)
    this.#queue = []
    recordDropped(reason, count)
  }
}

module.exports = FlagEvaluationConsumer
