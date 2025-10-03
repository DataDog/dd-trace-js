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
 * @typedef {{ id: number, mechanism?: number }} Product
 * @typedef {2|-1|1|0} SamplingPriority Empirically defined sampling priorities.
 * @typedef {import('./sampling_rule')|Record<string, unknown>} SamplingRuleLike
 */
class PrioritySampler {
  /**
   * Creates an instance of PrioritySampler.
   *
   * @typedef {Object} SamplingConfig
   * @property {number} [sampleRate] - The default sample rate for traces.
   * @property {string} [provenance] - Optional rule provenance ("customer" or "dynamic").
   * @property {number} [rateLimit=100] - The maximum number of traces to sample per second.
   * @property {Array<import('./sampling_rule')>|Array<Record<string, unknown>>} [rules=[]] - Sampling rules or configs.
   *
   * @param {string} env - The environment name (e.g., "production", "staging").
   * @param {SamplingConfig} [config] - The configuration object for sampling.
   */
  constructor (env, config) {
    this.configure(env, config)
    this.update({})
  }

  /**
   *
   * @param {string} env
   * @param {SamplingConfig} config
   */
  configure (env, config = {}) {
    const { sampleRate, provenance, rateLimit = 100, rules } = config
    this._env = env
    this._rules = this.#normalizeRules(rules || [], sampleRate, rateLimit, provenance)
    this._limiter = new RateLimiter(rateLimit)

    log.trace(env, config)
    setSamplingRules(this._rules)
  }

  /**
   * @param {DatadogSpan} span
   * @returns {boolean} True if the trace should be sampled based on priority.
   */
  isSampled (span) {
    const priority = this._getPriorityFromAuto(span)
    log.trace(span)
    return priority === USER_KEEP || priority === AUTO_KEEP
  }

  /**
   * Assigns a sampling priority to a span if not already set.
   *
   * @param {DatadogSpan} span
   * @param {boolean} [auto=true] - Whether to use automatic sampling if no manual tags are present.
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
   * Updates agent-provided sampling rates keyed by `service:,env:`.
   *
   * @param {Record<string, number>} rates
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
   * Validates that a sampling priority value is one of the allowed constants.
   *
   * @param {SamplingPriority|undefined} samplingPriority
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
   * Explicitly sets the priority and mechanism for the span's trace.
   *
   * @param {DatadogSpan} span
   * @param {SamplingPriority} samplingPriority
   * @param {Product} [product]
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
   * Returns the span context, accepting either a span or a span context.
   *
   * @param {DatadogSpan|DatadogSpanContext} span
   * @returns {DatadogSpanContext}
   */
  _getContext (span) {
    return typeof /** @type {DatadogSpan} */ (span).context === 'function'
      ? /** @type {DatadogSpan} */ (span).context()
      : /** @type {DatadogSpanContext} */ (span)
  }

  /**
   * Computes priority using rules and agent rates when no manual tag is present.
   *
   * @param {DatadogSpan} span
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
   * Computes priority from manual sampling tags if present.
   * Included for compatibility with {@link import('./standalone/tracesource_priority_sampler')._getPriorityFromTags}
   *
   * @param {Record<string, unknown>} tags
   * @param {DatadogSpanContext} _context
   * @returns {SamplingPriority|undefined}
   */
  _getPriorityFromTags (tags, _context) {
    if (Object.hasOwn(tags, MANUAL_KEEP) && tags[MANUAL_KEEP] !== false) {
      return USER_KEEP
    } else if (Object.hasOwn(tags, MANUAL_DROP) && tags[MANUAL_DROP] !== false) {
      return USER_REJECT
    }
    const rawPriority = tags[SAMPLING_PRIORITY]
    if (rawPriority !== undefined) {
      const priority = Number.parseInt(String(rawPriority), 10)

      if (priority === 1 || priority === 2) {
        return USER_KEEP
      } else if (priority === 0 || priority === -1) {
        return USER_REJECT
      }
    }
  }

  /**
   * Applies a matching rule and rate limit to compute the sampling priority.
   *
   * @param {DatadogSpanContext} context
   * @param {import('./sampling_rule')} rule
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
   * Checks if the rate limiter allows sampling for the current window and
   * records the effective rate on the trace.
   *
   * @param {DatadogSpanContext} context
   * @returns {boolean}
   */
  _isSampledByRateLimit (context) {
    // TODO: Change underscored properties to private ones.
    const allowed = this._limiter.isAllowed()

    context._trace[SAMPLING_LIMIT_DECISION] = this._limiter.effectiveRate()

    return allowed
  }

  /**
   * Computes priority using agent-provided sampling rates.
   *
   * @param {DatadogSpanContext} context
   * @returns {SamplingPriority}
   */
  #getPriorityByAgent (context) {
    const key = `service:${context._tags[SERVICE_NAME]},env:${this._env}`
    // TODO: Change underscored properties to private ones.
    const sampler = this._samplers[key] || this._samplers[DEFAULT_KEY]

    context._trace[SAMPLING_AGENT_DECISION] = sampler.rate()

    context._sampling.mechanism = sampler === defaultSampler ? SAMPLING_MECHANISM_DEFAULT : SAMPLING_MECHANISM_AGENT

    return sampler.isSampled(context) ? AUTO_KEEP : AUTO_REJECT
  }

  /**
   * Tags the trace with a decision maker when priority is keep, or removes it otherwise.
   *
   * @param {DatadogSpan} span
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
   * Normalizes rule inputs to SamplingRule instances, applying defaults.
   *
   * @param {Array<SamplingRuleLike>|SamplingRuleLike} rules - Rules to normalize.
   * @param {number|undefined} sampleRate
   * @param {number} rateLimit
   * @param {string|undefined} provenance
   * @returns {Array<import('./sampling_rule')>}
   */
  #normalizeRules (rules, sampleRate, rateLimit, provenance) {
    rules = Array.isArray(rules) ? rules.flat() : [rules]

    rules.push({ sampleRate, maxPerSecond: rateLimit, provenance })

    const result = []
    for (const rule of rules) {
      const sampleRate = Number.parseFloat(String(rule.sampleRate))
      // TODO(BridgeAR): Debug logging invalid rules fails our tests.
      // Should we definitely not know about these?
      if (!Number.isNaN(sampleRate)) {
        result.push(SamplingRule.from({ ...rule, sampleRate }))
      }
    }
    return result
  }

  /**
   * Finds the first matching rule for the given span.
   *
   * @param {DatadogSpan} span
   * @returns {import('./sampling_rule')|undefined}
   */
  #findRule (span) {
    // TODO: Change underscored properties to private ones.
    for (const rule of this._rules) {
      // Rule is a special object with a .match() property.
      // It has nothing to do with a regular expression.
      // eslint-disable-next-line unicorn/prefer-regexp-test
      if (rule.match(span)) return rule
    }
  }

  /**
   * Convenience helper to keep a trace with an optional product mechanism.
   *
   * @param {DatadogSpan} span
   * @param {Product} [product]
   */
  static keepTrace (span, product) {
    span?._prioritySampler?.setPriority(span, USER_KEEP, product)
  }
}

module.exports = PrioritySampler
