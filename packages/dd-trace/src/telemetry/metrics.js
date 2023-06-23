'use strict'

const { version } = require('../../../../package.json')

const { sendData } = require('./send-data')

function getId (type, namespace, name, tags) {
  return `${type}:${namespace}.${name}:${tagArray(tags).sort().join(',')}`
}

function tagArray (tags = {}) {
  if (Array.isArray(tags)) return tags
  const list = []
  for (const [key, value] of Object.entries(tags)) {
    list.push(`${key}:${value}`.toLowerCase())
  }
  return list
}

function now () {
  return Date.now() / 1e3
}

function mapToJsonArray (map) {
  return Array.from(map.values()).map(v => v.toJSON())
}

class Metric {
  constructor (namespace, metric, common, tags) {
    this.namespace = namespace.toString()
    this.metric = common ? metric : `nodejs.${metric}`
    this.tags = tagArray(tags)
    if (common) {
      this.tags.push('lib_language:nodejs')
      this.tags.push(`version:${process.version}`)
    } else {
      this.tags.push(`lib_version:${version}`)
    }
    this.common = common

    this.points = []
  }

  toString () {
    const { namespace, metric } = this
    return `${namespace}.${metric}`
  }

  reset () {
    this.points = []
  }

  track () {
    throw new Error('not implemented')
  }

  toJSON () {
    const { metric, points, interval, type, tags, common } = this
    return {
      metric,
      points,
      interval,
      type,
      tags,
      common
    }
  }
}

class CountMetric extends Metric {
  get type () {
    return 'count'
  }

  inc (value) {
    return this.track(value)
  }

  dec (value = -1) {
    return this.track(value)
  }

  track (value = 1) {
    if (this.points.length) {
      this.points[0][1] += value
    } else {
      this.points.push([now(), value])
    }
  }
}

class GaugeMetric extends Metric {
  get type () {
    return 'gauge'
  }

  mark (value) {
    return this.track(value)
  }

  track (value = 1) {
    this.points.push([now(), value])
  }
}

class RateMetric extends Metric {
  constructor (namespace, metric, common, tags, interval) {
    super(namespace, metric, common, tags)

    this.interval = interval
    this.rate = 0
  }

  get type () {
    return 'rate'
  }

  reset () {
    super.reset()
    this.rate = 0
  }

  track (value = 1) {
    this.rate += value
    const rate = this.interval ? (this.rate / this.interval) : 0.0
    this.points = [[now(), rate]]
  }
}

const metricsTypes = {
  count: CountMetric,
  gauge: GaugeMetric,
  rate: RateMetric
}

class Namespace extends Map {
  constructor (namespace) {
    super()
    this.namespace = namespace
  }

  reset () {
    for (const metric of this.values()) {
      metric.reset()
    }
  }

  toString () {
    return `dd.instrumentation_telemetry_data.${this.namespace}`
  }

  getMetric (type, name, tags, interval) {
    const metricId = getId(type, this, name, tags)

    let metric = this.get(metricId)
    if (metric) return metric

    const Factory = metricsTypes[type]
    if (!Factory) {
      throw new Error(`Unknown metric type ${type}`)
    }

    metric = new Factory(this, name, true, tags, interval)
    this.set(metricId, metric)

    return metric
  }

  count (name, tags) {
    return this.getMetric('count', name, tags)
  }

  gauge (name, tags) {
    return this.getMetric('gauge', name, tags)
  }

  rate (name, interval, tags) {
    return this.getMetric('rate', name, tags, interval)
  }

  toJSON () {
    const { namespace } = this
    return {
      namespace,
      series: mapToJsonArray(this)
    }
  }
}

class NamespaceManager extends Map {
  namespace (name) {
    let ns = this.get(name)
    if (ns) return ns

    ns = new Namespace(name)
    this.set(name, ns)
    return ns
  }

  toJSON () {
    return mapToJsonArray(this)
  }

  send (config, application, host) {
    for (const namespace of this.values()) {
      sendData(config, application, host, 'generate-metrics', namespace.toJSON())

      // TODO: This could also be clear() but then it'd have to rebuild all
      // metric instances on every send. This may be desirable if we want tags
      // with high cardinality and variability over time.
      namespace.reset()
    }
  }
}

const manager = new NamespaceManager()

module.exports = {
  CountMetric,
  GaugeMetric,
  RateMetric,
  Namespace,
  NamespaceManager,
  manager
}
