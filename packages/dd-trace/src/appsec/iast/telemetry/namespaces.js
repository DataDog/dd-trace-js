'use strict'

const log = require('../../../log')
const { Namespace } = require('../../../telemetry/metrics')
const { addMetricsToSpan, filterTags } = require('./span-tags')
const { IAST_TRACE_METRIC_PREFIX } = require('../tags')

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

    const metrics = [...namespace.metrics.values()]
    namespace.metrics.clear()

    addMetricsToSpan(rootSpan, metrics, IAST_TRACE_METRIC_PREFIX)

    merge(metrics)
  } catch (e) {
    log.error(e)
  } finally {
    if (context) {
      delete context[DD_IAST_METRICS_NAMESPACE]
    }
  }
}

function merge (metrics) {
  metrics.forEach(metric => {
    const { metric: metricName, type, tags, points } = metric

    if (points?.length && type === 'count') {
      const gMetric = globalNamespace.count(metricName, getTagsObject(tags))
      points.forEach(point => gMetric.inc(point[1]))
    }
  })
}

function getTagsObject (tags) {
  if (tags && tags.length > 0) {
    return filterTags(tags)
  }
}

class IastNamespace extends Namespace {
  constructor () {
    super('iast')

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
      metrics.set(tags, metric)
    }

    return metric
  }

  count (name, tags) {
    return this.getMetric(name, tags, 'count')
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
