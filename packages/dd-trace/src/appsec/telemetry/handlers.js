'use strict'

// eslint-disable-next-line max-len
// https://github.com/DataDog/instrumentation-telemetry-api-docs/blob/main/GeneratedDocumentation/ApiDocs/v2/SchemaDocumentation/Schemas/metric_data.md
class MetricData {
  constructor (metric, points, tag) {
    this.metric = metric
    this.points = points
    this.tag = tag
  }

  getTags () {
    return this.metric.getTags(this.tag)
  }

  getPayload () {
    return {
      metric: this.metric.name,
      common: this.metric.common,
      type: this.metric.type,
      points: this.getPayloadPoints(this.points),
      tags: this.getTags(),
      namespace: this.metric.namespace
    }
  }

  getPayloadPoints (points) {
    return points
      .map(point => this.metric.getPoint(point))
  }
}

// eslint-disable-next-line max-len
// https://github.com/DataDog/instrumentation-telemetry-api-docs/blob/main/GeneratedDocumentation/ApiDocs/v1/SchemaDocumentation/Schemas/distribution_series.md
class DistributionSeries extends MetricData {
  getPayloadPoints (points) {
    return points
  }
}

class DefaultHandler {
  constructor (metric, combiner) {
    this.metric = metric
    this.combiner = combiner
  }

  add (value) {
    this.combiner.add(value)
  }

  drain () {
    const points = this.combiner.drain()
    return [this.metric.serialize(points)]
  }

  merge (metricData) {
    this.combiner.merge(metricData)
  }
}

class TaggedHandler {
  constructor (metric, supplier) {
    this.metric = metric
    this.supplier = supplier
    this.combiners = new Map()
  }

  add (value, tag) {
    this.getOrCreateCombiner(tag).add(value)
  }

  drain () {
    const result = []
    for (const [key, value] of this.combiners) {
      const points = value.drain()
      if (points && points.length) {
        result.push(this.metric.serialize(points, this.getMetricDataTag(key)))
      }
    }
    return result
  }

  getMetricDataTag (tag) {
    return tag
  }

  getOrCreateCombiner (tag) {
    tag = !tag ? '' : tag
    let combiner = this.combiners.get(tag)
    if (!combiner) {
      combiner = this.supplier()
      this.combiners.set(tag, combiner)
    }
    return combiner
  }

  merge (metricData) {
    this.getOrCreateCombiner(metricData.tag).merge(metricData)
  }
}

class DelegatingHandler {
  constructor (metric, collector) {
    this.metric = metric
    this.collector = collector
  }

  add (value, tag) {
    this.collector.addMetric(this.metric, value, tag)
  }

  drain () { /* drain not supported */ }

  merge () { /* merge not supported */ }
}

class CompositeTaggedHandler extends TaggedHandler {
  constructor (metric, supplier) {
    super(metric, supplier)
    this.compositeTags = new Map()
  }

  getOrCreateCombiner (compositeTag) {
    const tag = compositeTag && compositeTag.key ? compositeTag.key() : compositeTag
    const combiner = super.getOrCreateCombiner(tag)
    if (!this.compositeTags.has(tag)) {
      this.compositeTags.set(tag, compositeTag)
    }
    return combiner
  }

  getMetricDataTag (tag) {
    return this.compositeTags.get(tag) || tag
  }
}

module.exports = {
  DefaultHandler,
  TaggedHandler,
  DelegatingHandler,
  CompositeTaggedHandler,
  MetricData,
  DistributionSeries
}
