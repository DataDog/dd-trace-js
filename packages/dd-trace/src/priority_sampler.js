'use strict'

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

class PrioritySampler {
  constructor (env, config) {
    this.configure(env, config)
    this.update({})
  }

  configure (env, { sampleRate, provenance = undefined, rateLimit = 100, rules = [] } = {}) {
    this._env = env
    this._rules = this._normalizeRules(rules, sampleRate, rateLimit, provenance)
    this._limiter = new RateLimiter(rateLimit)

    setSamplingRules(this._rules)
  }

  isSampled (span) {
    const priority = this._getPriorityFromAuto(span)
    return priority === USER_KEEP || priority === AUTO_KEEP
  }

  sample (span, auto = true) {
    if (!span) return

    const context = this._getContext(span)
    const root = context._trace.started[0]

    // TODO: remove the decision maker tag when priority is less than AUTO_KEEP
    if (context._sampling.priority !== undefined) return
    if (!root) return // noop span

    const tag = this._getPriorityFromTags(context._tags)

    if (this.validate(tag)) {
      context._sampling.priority = tag
      context._sampling.mechanism = SAMPLING_MECHANISM_MANUAL
    } else if (auto) {
      context._sampling.priority = this._getPriorityFromAuto(root)
    } else {
      return
    }

    this._addDecisionMaker(root)
  }

  update (rates) {
    const samplers = {}

    for (const key in rates) {
      const rate = rates[key]
      const sampler = new Sampler(rate)

      samplers[key] = sampler
    }

    samplers[DEFAULT_KEY] = samplers[DEFAULT_KEY] || defaultSampler

    this._samplers = samplers
  }

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

  _getContext (span) {
    return typeof span.context === 'function' ? span.context() : span
  }

  _getPriorityFromAuto (span) {
    const context = this._getContext(span)
    const rule = this._findRule(span)

    return rule
      ? this._getPriorityByRule(context, rule)
      : this._getPriorityByAgent(context)
  }

  _getPriorityFromTags (tags) {
    if (hasOwn(tags, MANUAL_KEEP) && tags[MANUAL_KEEP] !== false) {
      return USER_KEEP
    } else if (hasOwn(tags, MANUAL_DROP) && tags[MANUAL_DROP] !== false) {
      return USER_REJECT
    } else {
      const priority = parseInt(tags[SAMPLING_PRIORITY], 10)

      if (priority === 1 || priority === 2) {
        return USER_KEEP
      } else if (priority === 0 || priority === -1) {
        return USER_REJECT
      }
    }
  }

  _getPriorityByRule (context, rule) {
    context._trace[SAMPLING_RULE_DECISION] = rule.sampleRate
    context._sampling.mechanism = SAMPLING_MECHANISM_RULE
    if (rule.provenance === 'customer') context._sampling.mechanism = SAMPLING_MECHANISM_REMOTE_USER
    if (rule.provenance === 'dynamic') context._sampling.mechanism = SAMPLING_MECHANISM_REMOTE_DYNAMIC

    return rule.sample() && this._isSampledByRateLimit(context)
      ? USER_KEEP
      : USER_REJECT
  }

  _isSampledByRateLimit (context) {
    const allowed = this._limiter.isAllowed()

    context._trace[SAMPLING_LIMIT_DECISION] = this._limiter.effectiveRate()

    return allowed
  }

  _getPriorityByAgent (context) {
    const key = `service:${context._tags[SERVICE_NAME]},env:${this._env}`
    const sampler = this._samplers[key] || this._samplers[DEFAULT_KEY]

    context._trace[SAMPLING_AGENT_DECISION] = sampler.rate()

    if (sampler === defaultSampler) {
      context._sampling.mechanism = SAMPLING_MECHANISM_DEFAULT
    } else {
      context._sampling.mechanism = SAMPLING_MECHANISM_AGENT
    }

    return sampler.isSampled(context) ? AUTO_KEEP : AUTO_REJECT
  }

  _addDecisionMaker (span) {
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

  _normalizeRules (rules, sampleRate, rateLimit, provenance) {
    rules = [].concat(rules || [])

    return rules
      .concat({ sampleRate, maxPerSecond: rateLimit, provenance })
      .map(rule => ({ ...rule, sampleRate: parseFloat(rule.sampleRate) }))
      .filter(rule => !isNaN(rule.sampleRate))
      .map(SamplingRule.from)
  }

  _findRule (span) {
    for (const rule of this._rules) {
      if (rule.match(span)) return rule
    }
  }
}

function hasOwn (object, prop) {
  return Object.prototype.hasOwnProperty.call(object, prop)
}

module.exports = PrioritySampler
