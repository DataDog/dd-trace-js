'use strict'

const {
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
const { buildFlagEvaluationPayloads } = require('./flag-evaluation-payload')
const { normalizeTargetingKey, protectedErrorCode } = require('./flag-evaluation-pii')
const { recordDropped, recordTargetingKeyOmitted } = require('./flag-evaluation-telemetry')
const BaseFFEWriter = require('./base')

/** @typedef {Readonly<Record<string, string | number | boolean | null>>} ContextSnapshot */

/**
 * @typedef {object} FlagEvaluationRoute
 * @property {URL} url
 * @property {string} basePath
 * @property {object} [headers]
 * @property {import('node:https').Agent} [agent]
 * @property {FlagEvaluationRoute} [fallback]
 */

/**
 * @typedef {object} FlagEvaluationEvent
 * @property {string} flagKey
 * @property {string} [variant]
 * @property {string} [allocationKey]
 * @property {string} [targetingRuleKey]
 * @property {boolean} runtimeDefault
 * @property {unknown} [errorCode]
 * @property {unknown} [targetingKey]
 * @property {ContextSnapshot} [attrs]
 * @property {unknown} [observeFullEvaluationData]
 * @property {number} timestamp
 */

function optionalKey (value) {
  const key = normalizeTargetingKey(value)
  return key === undefined || key.length === 0 ? undefined : key
}

class FlagEvaluationsWriter extends BaseFFEWriter {
  #enabled = false
  #closed = false
  #queue = []
  #immediate
  #aggregator = new FlagEvaluationAggregator()
  #context

  /**
   * @param {import('../../config/config-base')} config
   * @param {FlagEvaluationRoute} [route]
   */
  constructor (config, route) {
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
    if (!this.#enabled || this.#aggregator.size === 0) return

    const { full, degraded } = this.#aggregator.take()
    const payloads = buildFlagEvaluationPayloads(full, degraded, this.#context, Date.now())
    for (const payload of payloads) this._sendPayload(payload.encoded, payload.rows)
  }

  destroy () {
    if (this.#closed) return
    this.#cancelImmediate()
    this.#drain()
    this.flush()
    this.#closed = true
    this.#enabled = false
    super.destroy()
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
    for (const event of queue) this.#aggregator.add(event)
  }

  #discardBuffered (reason) {
    this.#cancelImmediate()
    const count = this.#queue.length + this.#aggregator.clear()
    this.#queue = []
    recordDropped(reason, count)
  }
}

module.exports = FlagEvaluationsWriter
