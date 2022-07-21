'use strict'
const { globMatch } = require('../src/util')
const {
  USER_KEEP,
  AUTO_KEEP
} = require('../../../ext').priority
const RateLimiter = require('./rate_limiter')

class SpanIngestor {
  constructor ({ spanSamplingRules = [] }) {
    this._rules = spanSamplingRules
    this._limiters = {}
  }

  ingest (rootContext) {
    const decision = rootContext._sampling.priority
    if (decision === USER_KEEP || decision === AUTO_KEEP) return

    const { started } = rootContext._trace
    for (const span of started) {
      const service = span.tracer()._service
      const name = span._name
      const rule = findRule(this._rules, service, name)
      if (!rule) continue

      const sampleRate = getSampleRate(rule.sampleRate)
      const maxPerSecond = getMaxPerSecond(rule.maxPerSecond)
      const sampled = sample(sampleRate)
      if (!sampled) continue

      const key = `${service}:${name}`
      const limiter = getLimiter(this._limiters, key, maxPerSecond)
      if (limiter.isAllowed()) {
        span.context()._sampling.spanSampling = {
          sampleRate,
          maxPerSecond
        }
      }
    }
  }
}

function findRule (rules, service, name) {
  for (const rule of rules) {
    const servicePattern = getService(rule.service)
    const namePattern = getName(rule.name)
    if (globMatch(servicePattern, service) && globMatch(namePattern, name)) {
      return rule
    }
  }
}

function getLimiter (list, key, maxPerSecond) {
  if (typeof list[key] === 'undefined') {
    list[key] = new RateLimiter(maxPerSecond)
  }
  return list[key]
}

function sample (sampleRate) {
  return Math.random() < sampleRate
}

function getService (service) {
  return service || '*'
}

function getName (name) {
  return name || '*'
}

function getSampleRate (sampleRate) {
  return sampleRate || 1.0
}

function getMaxPerSecond (maxPerSecond) {
  return maxPerSecond || Infinity
}

module.exports = SpanIngestor
