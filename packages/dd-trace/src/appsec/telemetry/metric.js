'use strict'

const { addValue } = require('./telemetry-collector')
const { AggregatedCombiner, ConflatedCombiner, DistributedCombiner } = require('./combiners')
const { TaggedHandler, DefaultHandler, DelegatingHandler, MetricData, DistributionSeries } = require('./handlers')

const Scope = {
  GLOBAL: 'GLOBAL',
  REQUEST: 'REQUEST'
}

class Metric {
  constructor (name, scope, metricTag, namespace) {
    this.name = name
    this.common = true
    this.type = 'count'
    this.metricTag = metricTag
    this.scope = scope
    this.namespace = namespace || 'appsec'
  }

  hasRequestScope () {
    return this.scope === Scope.REQUEST
  }

  getTags (tag) {
    return this.metricTag && tag ? [`${this.metricTag}:${tag}`] : undefined
  }

  increase (tag, context) {
    this.add(1, tag, context)
  }

  add (value, tag, context) {
    if (Array.isArray(tag)) {
      tag.forEach(t => addValue(this, value, t, context))
    } else {
      addValue(this, value, tag, context)
    }
  }

  getPoint (point) {
    return [point.timestamp, point.value]
  }

  isTagged () {
    return !!this.metricTag
  }

  isDistribution () {
    return this.type === 'distribution'
  }

  aggregated () {
    return this.isTagged()
      ? new TaggedHandler(this, () => new AggregatedCombiner())
      : new DefaultHandler(this, new AggregatedCombiner())
  }

  conflated () {
    return this.isTagged()
      ? new TaggedHandler(this, () => new ConflatedCombiner())
      : new DefaultHandler(this, new ConflatedCombiner())
  }

  delegating (collector) {
    return new DelegatingHandler(this, collector)
  }

  serialize (points, tag) {
    return new MetricData(this, points, tag)
  }
}

class Distribution extends Metric {
  constructor (name, scope, metricTag, namespace) {
    super(name, scope, metricTag, namespace)
    this.type = 'distribution'
  }

  getPoint (point) {
    return point
  }

  aggregated () {
    return this.isTagged()
      ? new TaggedHandler(this, () => new DistributedCombiner())
      : new DefaultHandler(this, new DistributedCombiner())
  }

  conflated () {
    return this.isTagged()
      ? new TaggedHandler(this, () => new DistributedCombiner())
      : new DefaultHandler(this, new DistributedCombiner())
  }

  serialize (points, tag) {
    return new DistributionSeries(this, points, tag)
  }
}

module.exports = {
  Metric,
  Distribution,
  Scope
}
