'use strict'

const log = require('../../../log')
const { Namespace } = require('../../../telemetry/metrics')
const { addMetricsToSpan, filterTags } = require('./span-tags')
const { IAST_TRACE_METRIC_PREFIX } = require('../tags')

const DD_IAST_METRICS_NAMESPACE = Symbol('_dd.iast.request.metrics.namespace')

function initRequestNamespace (context) {
  if (!context) return

  const namespace = new Namespace('iast')
  context[DD_IAST_METRICS_NAMESPACE] = namespace
  return namespace
}

function getNamespaceFromContext (context) {
  return context && context[DD_IAST_METRICS_NAMESPACE]
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
  metrics.forEach(metric => metric.points.forEach(point => {
    globalNamespace
      .count(metric.metric, getTagsObject(metric.tags))
      .inc(point[1])
  }))
}

function getTagsObject (tags) {
  if (tags && tags.length > 0) {
    return filterTags(tags)
  }
}

class IastNamespace extends Namespace {
  constructor () {
    super('iast')
  }

  reset () {
    this.metrics.clear()
    this.distributions.clear()
  }
}

const globalNamespace = new IastNamespace()

module.exports = {
  initRequestNamespace,
  getNamespaceFromContext,
  finalizeRequestNamespace,
  globalNamespace,

  DD_IAST_METRICS_NAMESPACE
}
