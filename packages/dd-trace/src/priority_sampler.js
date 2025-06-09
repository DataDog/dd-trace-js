'use strict'

const log = require('./log')
const RateLimiter = require('./rate_limiter')
const Sampler = require('./sampler')
const { setSamplingRules } = require('./startup-log')
const SamplingRule = require('./sampling_rule')

const {
  SAMPLING_MECHANISM_DEFAULT,
  SAMPLING_MECHANISM_AGENT,
  SAMPLING_MECHANISM_RULE,
  SAMPLING_MECHANISM_MANUAL,
  SAMPLING_MECHANISM_REMOTE_USER,
  SAMPLING_MECHANISM_REMOTE_DYNAMIC,
  SAMPLING_RULE_DECISION,
  SAMPLING_LIMIT_DECISION,
  SAMPLING_AGENT_DECISION,
  DECISION_MAKER_KEY
} = require('./constants')

const {
  tags: {
    MANUAL_KEEP,
    MANUAL_DROP,
    SAMPLING_PRIORITY,
    SERVICE_NAME
  },
  priority: {
    AUTO_REJECT,
    AUTO_KEEP,
    USER_REJECT,
    USER_KEEP
  }
} = require('../../../ext')

const DEFAULT_KEY = 'service:,env:'

const defaultSampler = new Sampler(AUTO_KEEP)

/**
 * PrioritySampler is responsible for determining whether a span should be sampled
 * based on various rules, rate limits, and priorities. It supports manual and
 * automatic sampling mechanisms and integrates with Datadog's tracing system.
 *
 * @class PrioritySampler
 * @typedef {import('./opentracing/span')} DatadogSpan
 * @typedef {import('./opentracing/span_context')} DatadogSpanContext
 * @typedef {import('./standalone/product')} PRODUCTS
 * @typedef {2|-1|1|0} SamplingPriority Empirically defined sampling priorities.
 */
class PrioritySampler {
  /**
   * Creates an instance of PrioritySampler.
   *
   * @typedef {Object} SamplingConfig
   * @property {number} [sampleRate] - The default sample rate for traces.
   * @property {string} [provenance] - The provenance of the sampling rule (e.g., "customer", "dynamic").
   * @property {number} [rateLimit=100] - The maximum number of traces to sample per second.
   * @property {Array<SamplingRule>} [rules=[]] - An array of sampling rules to apply.
   *
   * @param {string} env - The environment name (e.g., "production", "staging").
   * @param {SamplingConfig} config - The configuration object for sampling.
   */
  constructor (env, config) {
    this.configure(env, config)
    this.update({})
  }

  /**
   *
   * @param env {string}
   * @param opts {SamplingConfig}
   */
  configure (env, opts = {}) {
    const { sampleRate, provenance, rateLimit = 100, rules } = opts
    this._env = env
    this._rules = this.#normalizeRules(rules || [], sampleRate, rateLimit, provenance)
    this._limiter = new RateLimiter(rateLimit)

    log.trace(env, opts)
    setSamplingRules(this._rules)
  }

  /**
   * @param span {DatadogSpan}
   * @returns {boolean}
   */
  isSampled (span) {
    const priority = this._getPriorityFromAuto(span)
    log.trace(span)
    return priority === USER_KEEP || priority === AUTO_KEEP
  }

  /**
   *
   * @param span {DatadogSpan}
   * @param auto {boolean}
   * @returns {void}
   */
  sample (span, auto = true) {
    if (!span) return

    const context = this._getContext(span)
    const root = context._trace.started[0]

    // TODO: remove the decision maker tag when priority is less than AUTO_KEEP
    if (context._sampling.priority !== undefined) return
    if (!root) return // noop span

    log.trace(span, auto)

    const tag = this._getPriorityFromTags(context._tags, context)

    if (this.validate(tag)) {
      context._sampling.priority = tag
      context._sampling.mechanism = SAMPLING_MECHANISM_MANUAL
    } else if (auto) {
      context._sampling.priority = this._getPriorityFromAuto(root)
    } else {
      return
    }

    this.#addDecisionMaker(root)
  }

  /**
   *
   * @param rates {Record<string, number>}
   * @returns {void}
   */
  update (rates) {
    const samplers = {}

    for (const key in rates) {
      const rate = rates[key]
      samplers[key] = new Sampler(rate)
    }

    samplers[DEFAULT_KEY] = samplers[DEFAULT_KEY] || defaultSampler

    this._samplers = samplers

    log.trace(rates)
  }

  /**
   *
   * @param samplingPriority {SamplingPriority}
   * @returns {boolean}
   */
  validate (samplingPriority) {
    switch (samplingPriority) {
      case USER_REJECT:
      case USER_KEEP:
      case AUTO_REJECT:
      case AUTO_KEEP:
        return true
      default:
        return false
    }
  }

  /**
   *
   * @param span {DatadogSpan}
   * @param samplingPriority {SamplingPriority}
   * @param product {import('./standalone/product')}
   */
  setPriority (span, samplingPriority, product) {
    if (!span || !this.validate(samplingPriority)) return

    const context = this._getContext(span)
    const root = context._trace.started[0]

    if (!root) {
      log.error('Skipping the setPriority on noop span')
      return // noop span
    }

    context._sampling.priority = samplingPriority

    const mechanism = product?.mechanism ?? SAMPLING_MECHANISM_MANUAL
    context._sampling.mechanism = mechanism

    log.trace(span, samplingPriority, mechanism)

    this.#addDecisionMaker(root)
  }

  /**
   *
   * @param span {DatadogSpan}
   * @returns {DatadogSpanContext}
   */
  _getContext (span) {
    return typeof span.context === 'function' ? span.context() : span
  }

  /**
   *
   * @param span {DatadogSpan}
   * @returns {SamplingPriority}
   */
  _getPriorityFromAuto (span) {
    const context = this._getContext(span)
    const rule = this.#findRule(span)

    return rule
      ? this.#getPriorityByRule(context, rule)
      : this.#getPriorityByAgent(context)
  }

  /**
   *
   * @param tags {Record<string, symbol | unknown>}
   * Included for compatibility with {@link import('./standalone/tracesource_priority_sampler')._getPriorityFromTags}
   * @param _context {DatadogSpanContext}
   * @returns {SamplingPriority}
   */
  _getPriorityFromTags (tags, _context) {
    if (Object.hasOwn(tags, MANUAL_KEEP) && tags[MANUAL_KEEP] !== false) {
      return USER_KEEP
    } else if (Object.hasOwn(tags, MANUAL_DROP) && tags[MANUAL_DROP] !== false) {
      return USER_REJECT
    }
    const priority = Number.parseInt(tags[SAMPLING_PRIORITY], 10)

    if (priority === 1 || priority === 2) {
      return USER_KEEP
    } else if (priority === 0 || priority === -1) {
      return USER_REJECT
    }
  }

  /**
   *
   * @param context {DatadogSpanContext}
   * @param rule {SamplingRule}
   * @returns {SamplingPriority}
   */
  #getPriorityByRule (context, rule) {
    context._trace[SAMPLING_RULE_DECISION] = rule.sampleRate
    context._sampling.mechanism = SAMPLING_MECHANISM_RULE
    if (rule.provenance === 'customer') context._sampling.mechanism = SAMPLING_MECHANISM_REMOTE_USER
    if (rule.provenance === 'dynamic') context._sampling.mechanism = SAMPLING_MECHANISM_REMOTE_DYNAMIC

    return rule.sample(context) && this._isSampledByRateLimit(context)
      ? USER_KEEP
      : USER_REJECT
  }

  /**
   *
   * @param context {DatadogSpanContext}
   * @returns {boolean}
   * @private
   */
  _isSampledByRateLimit (context) {
    const allowed = this._limiter.isAllowed()

    context._trace[SAMPLING_LIMIT_DECISION] = this._limiter.effectiveRate()

    return allowed
  }

  /**
   *
   * @param context {DatadogSpanContext}
   * @returns {SamplingPriority}
   */
  #getPriorityByAgent (context) {
    const key = `service:${context._tags[SERVICE_NAME]},env:${this._env}`
    const sampler = this._samplers[key] || this._samplers[DEFAULT_KEY]

    context._trace[SAMPLING_AGENT_DECISION] = sampler.rate()

    context._sampling.mechanism = sampler === defaultSampler ? SAMPLING_MECHANISM_DEFAULT : SAMPLING_MECHANISM_AGENT

    return sampler.isSampled(context) ? AUTO_KEEP : AUTO_REJECT
  }

  /**
   *
   * @param span {DatadogSpan}
   * @returns {void}
   */
  #addDecisionMaker (span) {
    const context = span.context()
    const trace = context._trace
    const priority = context._sampling.priority
    const mechanism = context._sampling.mechanism

    if (priority >= AUTO_KEEP) {
      if (!trace.tags[DECISION_MAKER_KEY]) {
        trace.tags[DECISION_MAKER_KEY] = `-${mechanism}`
      }
    } else {
      delete trace.tags[DECISION_MAKER_KEY]
    }
  }

  /**
   * @param {Record<string, unknown>[] | Record<string, unknown>} rules - The sampling rules to normalize.
   * @param {number} sampleRate
   * @param {number} rateLimit
   * @param {string} provenance
   * @returns {SamplingRule[]}
   */
  #normalizeRules (rules, sampleRate, rateLimit, provenance) {
    rules = Array.isArray(rules) ? rules.flat() : [rules]

    rules.push({ sampleRate, maxPerSecond: rateLimit, provenance })

    const result = []
    for (const rule of rules) {
      const sampleRate = Number.parseFloat(rule.sampleRate)
      // TODO(BridgeAR): Debug logging invalid rules fails our tests.
      // Should we definitely not know about these?
      if (!Number.isNaN(sampleRate)) {
        result.push(SamplingRule.from({ ...rule, sampleRate }))
      }
    }
    return result
  }

  /**
   *
   * @param span {DatadogSpan}
   * @returns {SamplingRule|undefined}
   */
  #findRule (span) {
    for (const rule of this._rules) {
      // Rule is a special object with a .match() property.
      // It has nothing to do with a regular expression.
      // eslint-disable-next-line unicorn/prefer-regexp-test
      if (rule.match(span)) return rule
    }
  }

  /**
   *
   * @param span {DatadogSpan}
   * @param product {import('./standalone/product')}
   */
  static keepTrace (span, product) {
    span?._prioritySampler?.setPriority(span, USER_KEEP, product)
  }
}

module.exports = PrioritySampler
