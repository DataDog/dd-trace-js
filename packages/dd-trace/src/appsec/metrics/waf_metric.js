'use strict'

const { AggregatedCombiner, ConflatedCombiner, DistributedCombiner } = require('../telemetry/combiners')
const { CompositeTaggedHandler } = require('../telemetry/handlers')
const { Metric, Scope, Distribution } = require('../telemetry/metric')

class WafMetric extends Metric {
  constructor (name) {
    super(name, Scope.GLOBAL)
  }

  getTags (tag) {
    return tag && tag.toArray ? tag.toArray() : super.getTags(tag)
  }

  isTagged () {
    return true
  }

  aggregated () {
    return new CompositeTaggedHandler(this, () => new AggregatedCombiner())
  }

  conflated () {
    return new CompositeTaggedHandler(this, () => new ConflatedCombiner())
  }
}

class WafDistribution extends Distribution {
  constructor (name) {
    super(name, Scope.GLOBAL)
  }

  getTags (tag) {
    return tag && tag.toArray ? tag.toArray() : super.getTags(tag)
  }

  isTagged () {
    return true
  }

  aggregated () {
    return new CompositeTaggedHandler(this, () => new AggregatedCombiner())
  }

  conflated () {
    return new CompositeTaggedHandler(this, () => new DistributedCombiner())
  }
}

class WafMetricTag {
  constructor () {
    this.tags = new Map()
  }

  static default (wafVersion, eventRulesVersion) {
    const tag = WafMetricTag.onlyVersions(wafVersion, eventRulesVersion)
    return tag.ruleTriggered(false)
      .requestBlocked(false)
      .wafTimeout(false)
  }

  static onlyVersions (wafVersion, eventRulesVersion) {
    const tag = new WafMetricTag()
    return tag.wafVersion(wafVersion)
      .eventRulesVersion(eventRulesVersion)
  }

  ruleTriggered (value) {
    return this.set('rule_triggered', value)
  }

  requestBlocked (value) {
    return this.set('request_blocked', value)
  }

  wafTimeout (value) {
    return this.set('waf_timeout', value)
  }

  wafVersion (value) {
    return this.set('waf_version', value)
  }

  eventRulesVersion (value) {
    return this.set('event_rules_version', value)
  }

  set (name, value) {
    if (name && value !== undefined) {
      this.tags.set(name, value)
    }
    return this
  }

  toArray () {
    return [...this.tags.keys()]
      .sort()
      .map(tag => `${tag}:${this.tags.get(tag)}`)
  }

  key () {
    return this.toArray().join(',')
  }
}

module.exports = {
  WAF_INIT: new WafMetric('waf.init'),
  WAF_REQUESTS: new WafMetric('waf.requests'),
  WAF_UPDATES: new WafMetric('waf.updates'),

  WAF_DURATION: new WafDistribution('waf.duration'),
  WAF_DURATION_EXT: new WafDistribution('waf.duration_ext'),

  WafMetric,
  WafMetricTag
}
