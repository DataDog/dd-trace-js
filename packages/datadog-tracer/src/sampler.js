'use strict'

const limiter = require('limiter')

const {
  SAMPLING_MECHANISM_DEFAULT,
  SAMPLING_MECHANISM_RULE,
  USER_KEEP,
  USER_REJECT,
  AUTO_KEEP,
  AUTO_REJECT
} = require('./constants')

class Sampler {
  constructor ({ sampleRate, rateLimit = 100, rules = [] } = {}) {
    this._rules = this._normalizeRules(rules, sampleRate)
    this._limiter = new RateLimiter(rateLimit)
  }

  sample (span) {
    const trace = span.trace
    const root = trace.spans[0]

    if (!span || !span.trace.started) return
    if (trace.samplingPriority !== undefined) return

    const rule = this._findRule(root)

    if (rule) {
      this._setPriorityByRule(root, rule)
    } else {
      this._setPriorityByAgent(root)
    }
  }

  _isSampled (rate) {
    return rate === 1 || Math.random() < rate
  }

  _getPriorityFromAuto (span) {
    const context = this._getContext(span)
    const rule = this._findRule(context)

    return rule
      ? this._setPriorityByRule(context, rule)
      : this._setPriorityByAgent(context)
  }

  _setPriorityByRule (span, rule) {
    const trace = span.trace
    const sampled = this._isSampled(rule.sampleRate)
    const allowed = sampled && this._limiter.isAllowed()

    trace.samplingPriority = sampled && allowed ? USER_KEEP : USER_REJECT
    trace.samplingMechanism = SAMPLING_MECHANISM_RULE
    // trace[SAMPLING_RULE_DECISION] = rule.sampleRate

    if (!allowed) {
      // trace[SAMPLING_LIMIT_DECISION] = this._limiter.effectiveRate()
    }
  }

  // TODO: actually support this or move sampling out of the internal tracer
  _setPriorityByAgent (span) {
    const trace = span.trace
    const sampled = true

    trace.samplingPriority = sampled ? AUTO_KEEP : AUTO_REJECT
    trace.samplingMechanism = SAMPLING_MECHANISM_DEFAULT

    // trace[SAMPLING_AGENT_DECISION] = sampler.rate()
  }

  _normalizeRules (rules, sampleRate) {
    return rules
      .concat({ sampleRate })
      .map(rule => ({ ...rule, sampleRate: parseFloat(rule.sampleRate) }))
      .filter(rule => !isNaN(rule.sampleRate))
  }

  _findRule (context) {
    for (let i = 0, l = this._rules.length; i < l; i++) {
      if (this._matchRule(context, this._rules[i])) return this._rules[i]
    }
  }

  _matchRule (span, rule) {
    const name = span.name
    const service = span.service

    if (rule.name instanceof RegExp && !rule.name.test(name)) return false
    if (typeof rule.name === 'string' && rule.name !== name) return false
    if (rule.service instanceof RegExp && !rule.service.test(service)) return false
    if (typeof rule.service === 'string' && rule.service !== service) return false

    return true
  }
}

class RateLimiter {
  constructor (rateLimit) {
    this._rateLimit = parseInt(rateLimit)
    this._limiter = new limiter.RateLimiter(this._rateLimit, 'second')
    this._tokensRequested = 0
    this._prevIntervalTokens = 0
    this._prevTokensRequested = 0
  }

  isAllowed () {
    const curIntervalStart = this._limiter.curIntervalStart
    const curIntervalTokens = this._limiter.tokensThisInterval
    const allowed = this._isAllowed()

    if (curIntervalStart !== this._limiter.curIntervalStart) {
      this._prevIntervalTokens = curIntervalTokens
      this._prevTokensRequested = this._tokensRequested
      this._tokensRequested = 1
    } else {
      this._tokensRequested++
    }

    return allowed
  }

  effectiveRate () {
    if (this._rateLimit < 0) return 1
    if (this._rateLimit === 0) return 0
    if (this._tokensRequested === 0) return 1

    const allowed = this._prevIntervalTokens + this._limiter.tokensThisInterval
    const requested = this._prevTokensRequested + this._tokensRequested

    return allowed / requested
  }

  _isAllowed () {
    if (this._rateLimit < 0) return true
    if (this._rateLimit === 0) return false

    return this._limiter.tryRemoveTokens(1)
  }

  _currentWindowRate () {
    if (this._rateLimit < 0) return 1
    if (this._rateLimit === 0) return 0
    if (this._tokensRequested === 0) return 1

    return this._limiter.tokensThisInterval / this._tokensRequested
  }
}

module.exports = { RateLimiter, Sampler }
