'use strict'

const log = require('../../../log')
const { Namespace } = require('../../../telemetry/metrics')
const { addMetricsToSpan } = require('./span-tags')
const { IAST_TRACE_METRIC_PREFIX } = require('../tags')
const iastLog = require('../iast-log')

const DD_IAST_METRICS_NAMESPACE = Symbol('_dd.iast.request.metrics.namespace')

function initRequestNamespace (context) {
  if (!context) return

  const namespace = new IastNamespace()
  context[DD_IAST_METRICS_NAMESPACE] = namespace
  return namespace
}

function getNamespaceFromContext (context) {
  return context?.[DD_IAST_METRICS_NAMESPACE]
}

function finalizeRequestNamespace (context, rootSpan) {
  try {
    const namespace = getNamespaceFromContext(context)
    if (!namespace) return

    addMetricsToSpan(rootSpan, [...namespace.metrics.values()], IAST_TRACE_METRIC_PREFIX)

    merge(namespace)

    namespace.clear()
  } catch (e) {
    log.error(e)
  } finally {
    if (context) {
      delete context[DD_IAST_METRICS_NAMESPACE]
    }
  }
}

function merge (namespace) {
  for (const [metricName, metricsByTagMap] of namespace.iastMetrics) {
    for (const [tags, metric] of metricsByTagMap) {
      const { type, points } = metric

      if (points?.length && type === 'count') {
        const gMetric = globalNamespace.getMetric(metricName, tags)
        points.forEach(point => gMetric.inc(point[1]))
      }
    }
  }
}

class IastNamespace extends Namespace {
  constructor (maxMetricTagsSize = 100) {
    super('iast')

    this.maxMetricTagsSize = maxMetricTagsSize
    this.iastMetrics = new Map()
  }

  getIastMetrics (name) {
    let metrics = this.iastMetrics.get(name)
    if (!metrics) {
      metrics = new Map()
      this.iastMetrics.set(name, metrics)
    }

    return metrics
  }

  getMetric (name, tags, type = 'count') {
    const metrics = this.getIastMetrics(name)

    let metric = metrics.get(tags)
    if (!metric) {
      metric = super[type](name, Array.isArray(tags) ? [...tags] : tags)

      if (metrics.size === this.maxMetricTagsSize) {
        metrics.clear()
        iastLog.warnAndPublish(`Tags cache max size reached for metric ${name}`)
      }

      metrics.set(tags, metric)
    }

    return metric
  }

  count (name, tags) {
    return this.getMetric(name, tags, 'count')
  }

  clear () {
    this.iastMetrics.clear()
    this.distributions.clear()
    this.metrics.clear()
  }
}

const globalNamespace = new IastNamespace()

module.exports = {
  initRequestNamespace,
  getNamespaceFromContext,
  finalizeRequestNamespace,
  globalNamespace,

  DD_IAST_METRICS_NAMESPACE,

  IastNamespace
}
