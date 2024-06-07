'use strict'

const { globMatch } = require('../src/util')
const RateLimiter = require('./rate_limiter')
const Sampler = require('./sampler')

class AlwaysMatcher {
  match () {
    return true
  }
}

class GlobMatcher {
  constructor (pattern, locator) {
    this.pattern = pattern
    this.locator = locator
  }

  match (span) {
    const subject = this.locator(span)
    if (!subject) return false
    return globMatch(this.pattern, subject)
  }
}

class RegExpMatcher {
  constructor (pattern, locator) {
    this.pattern = pattern
    this.locator = locator
  }

  match (span) {
    const subject = this.locator(span)
    if (!subject) return false
    return this.pattern.test(subject)
  }
}

function matcher (pattern, locator) {
  if (pattern instanceof RegExp) {
    return new RegExpMatcher(pattern, locator)
  }

  if (typeof pattern === 'string' && pattern !== '*') {
    return new GlobMatcher(pattern, locator)
  }

  return new AlwaysMatcher()
}

function makeTagLocator (tag) {
  return (span) => span.context()._tags[tag]
}

function nameLocator (span) {
  return span.context()._name
}

function serviceLocator (span) {
  const { _tags: tags } = span.context()
  return tags.service ||
    tags['service.name'] ||
    span.tracer()._service
}

class SamplingRule {
  constructor ({ name, service, resource, tags, sampleRate = 1.0, provenance = undefined, maxPerSecond } = {}) {
    this.matchers = []

    if (name) {
      this.matchers.push(matcher(name, nameLocator))
    }
    if (service) {
      this.matchers.push(matcher(service, serviceLocator))
    }
    if (resource) {
      this.matchers.push(matcher(resource, makeTagLocator('resource.name')))
    }
    for (const [key, value] of Object.entries(tags || {})) {
      this.matchers.push(matcher(value, makeTagLocator(key)))
    }

    this._sampler = new Sampler(sampleRate)
    this._limiter = undefined
    this.provenance = provenance

    if (Number.isFinite(maxPerSecond)) {
      this._limiter = new RateLimiter(maxPerSecond)
    }
  }

  static from (config) {
    return new SamplingRule(config)
  }

  get sampleRate () {
    return this._sampler.rate()
  }

  get effectiveRate () {
    return this._limiter && this._limiter.effectiveRate()
  }

  get maxPerSecond () {
    return this._limiter && this._limiter._rateLimit
  }

  match (span) {
    for (const matcher of this.matchers) {
      if (!matcher.match(span)) {
        return false
      }
    }

    return true
  }

  sample () {
    if (!this._sampler.isSampled()) {
      return false
    }

    if (this._limiter) {
      return this._limiter.isAllowed()
    }

    return true
  }
}

module.exports = SamplingRule
