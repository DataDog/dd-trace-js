'use strict'

const { globMatch } = require('../src/util')
const RateLimiter = require('./rate_limiter')
const Sampler = require('./sampler')

/**
 * Typedefs for clarity when matching spans.
 *
 * @typedef {import('./opentracing/span')} DatadogSpan
 * @typedef {import('./opentracing/span_context')} DatadogSpanContext
 *
 * @callback Locator
 * A function that derives a string subject from a span.
 * @param {DatadogSpan} span
 * @returns {string|undefined}
 *
 * @typedef {object} RuleMatcher
 * @property {(span: DatadogSpan) => boolean} match - Returns true if the span matches.
 */

/**
 * Matcher that always returns true.
 * Implements the minimal `RuleMatcher` interface.
 * @implements {RuleMatcher}
 */
class AlwaysMatcher {
  /**
   * @param {DatadogSpan} span
   * @returns {boolean}
   */
  match (span) {
    return true
  }
}

/**
 * Matcher that evaluates a glob pattern against a derived subject.
 */
class GlobMatcher {
  /**
   * @param {string} pattern - Glob pattern used to match the subject.
   * @param {Locator} locator - Function extracting the subject to match.
   */
  constructor (pattern, locator) {
    this.pattern = pattern
    this.locator = locator
  }

  /**
   * @param {DatadogSpan} span
   * @returns {boolean}
   */
  match (span) {
    const subject = this.locator(span)
    if (!subject) return false
    return globMatch(this.pattern, subject)
  }
}

/**
 * Matcher that evaluates a regular expression against a derived subject.
 */
class RegExpMatcher {
  /**
   * @param {RegExp} pattern - Regular expression used to test the subject.
   * @param {Locator} locator - Function extracting the subject to test.
   */
  constructor (pattern, locator) {
    this.pattern = pattern
    this.locator = locator
  }

  /**
   * @param {DatadogSpan} span
   * @returns {boolean}
   */
  match (span) {
    const subject = this.locator(span)
    if (!subject) return false
    return this.pattern.test(subject)
  }
}

/**
 * Creates a matcher for the provided pattern and locator.
 * Returns a glob matcher for non-trivial strings, a regexp matcher for RegExp,
 * or an always-true matcher for wildcard or missing patterns.
 *
 * @param {string|RegExp|undefined} pattern
 * @param {Locator} locator
 * @returns {RuleMatcher}
 */
function matcher (pattern, locator) {
  if (pattern instanceof RegExp) {
    return new RegExpMatcher(pattern, locator)
  }

  if (typeof pattern === 'string' && pattern !== '*' && pattern !== '**' && pattern !== '***') {
    return new GlobMatcher(pattern, locator)
  }
  return new AlwaysMatcher()
}

/**
 * Creates a locator that reads a specific tag from the span context.
 *
 * @param {string} tag
 * @returns {Locator}
 */
function makeTagLocator (tag) {
  return (span) => span.context()._tags[tag]
}

/**
 * Extracts the operation name from the span context.
 *
 * @param {DatadogSpan} span
 * @returns {string|undefined}
 */
function nameLocator (span) {
  return span.context()._name
}

/**
 * Extracts the service name from the span context or tracer configuration.
 *
 * @param {DatadogSpan} span
 * @returns {string|undefined}
 */
function serviceLocator (span) {
  const { _tags: tags } = span.context()
  return tags.service ||
    tags['service.name'] ||
    span.tracer()._service
}

/**
 * Extracts the resource name from the span context.
 *
 * @param {DatadogSpan} span
 * @returns {string|undefined}
 */
function resourceLocator (span) {
  const { _tags: tags } = span.context()
  return tags.resource ||
    tags['resource.name']
}

/**
 * Configuration options for a sampling rule.
 *
 * @typedef {object} SamplingRuleConfig
 * @property {string|RegExp} [name] - Match on span operation name.
 * @property {string|RegExp} [service] - Match on service name.
 * @property {string|RegExp} [resource] - Match on resource name.
 * @property {Record<string, string|RegExp>} [tags] - Match on specific tag values by key.
 * @property {number} [sampleRate=1] - Deterministic sampling rate in [0, 1].
 * @property {string} [provenance] - Optional provenance/metadata for this rule.
 * @property {number} [maxPerSecond] - Maximum samples per second (rate limit).
 */

/**
 * SamplingRule encapsulates matching criteria and sampling/limiting behavior
 * to decide whether a span should be sampled.
 */
class SamplingRule {
  /**
   * @param {SamplingRuleConfig} [config]
   */
  constructor ({ name, service, resource, tags, sampleRate = 1, provenance, maxPerSecond } = {}) {
    this.matchers = []

    if (name) {
      this.matchers.push(matcher(name, nameLocator))
    }
    if (service) {
      this.matchers.push(matcher(service, serviceLocator))
    }
    if (resource) {
      this.matchers.push(matcher(resource, resourceLocator))
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

  /**
   * Constructs a SamplingRule from the given configuration.
   * @param {SamplingRuleConfig} config
   * @returns {SamplingRule}
   */
  static from (config) {
    return new SamplingRule(config)
  }

  /**
   * Deterministic sampling rate in [0, 1].
   * @returns {number}
   */
  get sampleRate () {
    return this._sampler.rate()
  }

  /**
   * Effective rate applied by the rate limiter, if configured.
   * @returns {number|undefined}
   */
  get effectiveRate () {
    return this._limiter && this._limiter.effectiveRate()
  }

  /**
   * Maximum samples per second if a limiter is present.
   * @returns {number|undefined}
   */
  get maxPerSecond () {
    return this._limiter && this._limiter._rateLimit
  }

  /**
   * Checks whether the provided span matches all configured criteria.
   *
   * @param {DatadogSpan} span
   * @returns {boolean}
   */
  match (span) {
    for (const matcher of this.matchers) {
      // Rule is a special object with a .match() property.
      // It has nothing to do with a regular expression.
      // eslint-disable-next-line unicorn/prefer-regexp-test
      if (!matcher.match(span)) {
        return false
      }
    }

    return true
  }

  /**
   * Determines whether a span should be sampled based on the configured sampling rule.
   *
   * @param {DatadogSpan|DatadogSpanContext} span - The span or span context to evaluate.
   * @returns {boolean} `true` if the span should be sampled, otherwise `false`.
   */
  sample (span) {
    if (!this._sampler.isSampled(span)) {
      return false
    }

    if (this._limiter) {
      return this._limiter.isAllowed()
    }

    return true
  }
}

module.exports = SamplingRule
