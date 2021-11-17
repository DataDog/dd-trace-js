'use strict'

const RateLimiter = require('./rate_limiter')
const Sampler = require('./sampler')
const ext = require('../../../ext')
const { setSamplingRules } = require('./startup-log')

const {
  SAMPLING_RULE_DECISION,
  SAMPLING_LIMIT_DECISION,
  SAMPLING_AGENT_DECISION
} = require('./constants')

const SERVICE_NAME = ext.tags.SERVICE_NAME
const SAMPLING_PRIORITY = ext.tags.SAMPLING_PRIORITY
const MANUAL_KEEP = ext.tags.MANUAL_KEEP
const MANUAL_DROP = ext.tags.MANUAL_DROP
const USER_REJECT = ext.priority.USER_REJECT
const AUTO_REJECT = ext.priority.AUTO_REJECT
const AUTO_KEEP = ext.priority.AUTO_KEEP
const USER_KEEP = ext.priority.USER_KEEP
const DEFAULT_KEY = 'service:,env:'

class PrioritySampler {
  constructor (env, { sampleRate, rateLimit = 100, rules = [] } = {}) {
    this._env = env
    this._rules = this._normalizeRules(rules, sampleRate)
    this._limiter = new RateLimiter(rateLimit)

    setSamplingRules(this._rules)

    this.update({})
  }

  isSampled (span) {
    const priority = this._getPriorityFromAuto(span)
    return priority === USER_KEEP || priority === AUTO_KEEP
  }

  sample (span, auto = true) {
    if (!span) return

    const context = this._getContext(span)
    const root = context._trace.started[0]

    if (context._sampling.priority !== undefined) return
    if (!root) return // noop span

    const tag = this._getPriorityFromTags(context._tags)

    if (this.validate(tag)) {
      context._sampling.priority = tag
      return
    }

    if (auto) {
      context._sampling.priority = this._getPriorityFromAuto(root)
    }
  }

  update (rates) {
    const samplers = {}

    for (const key in rates) {
      const rate = rates[key]
      const sampler = new Sampler(rate)

      samplers[key] = sampler
    }

    samplers[DEFAULT_KEY] = samplers[DEFAULT_KEY] || new Sampler(AUTO_KEEP)

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
    const rule = this._findRule(context)

    return rule
      ? this._getPriorityByRule(context, rule)
      : this._getPriorityByAgent(context)
  }

  _getPriorityFromTags (tags) {
    if (tags.hasOwnProperty(MANUAL_KEEP) && tags[MANUAL_KEEP] !== false) {
      return USER_KEEP
    } else if (tags.hasOwnProperty(MANUAL_DROP) && tags[MANUAL_DROP] !== false) {
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

    return rule.sampler.isSampled(context) && this._isSampledByRateLimit(context) ? USER_KEEP : USER_REJECT
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

    return sampler.isSampled(context) ? AUTO_KEEP : AUTO_REJECT
  }

  _normalizeRules (rules, sampleRate) {
    return rules
      .concat({ sampleRate })
      .map(rule => ({ ...rule, sampleRate: parseFloat(rule.sampleRate) }))
      .filter(rule => !isNaN(rule.sampleRate))
      .map(rule => ({ ...rule, sampler: new Sampler(rule.sampleRate) }))
  }

  _findRule (context) {
    for (let i = 0, l = this._rules.length; i < l; i++) {
      if (this._matchRule(context, this._rules[i])) return this._rules[i]
    }
  }

  _matchRule (context, rule) {
    const name = context._name
    const service = context._tags['service.name']

    if (rule.name instanceof RegExp && !rule.name.test(name)) return false
    if (typeof rule.name === 'string' && rule.name !== name) return false
    if (rule.service instanceof RegExp && !rule.service.test(service)) return false
    if (typeof rule.service === 'string' && rule.service !== service) return false

    return true
  }
}

module.exports = PrioritySampler
