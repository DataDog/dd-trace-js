'use strict'

const { aggregated, conflated, delegating } = require('./handlers')
const log = require('../../log')
const DD_TELEMETRY_COLLECTOR = Symbol('_dd.appsec.telemetryCollector')

class TelemetryCollector {
  constructor (builders) {
    this.handlers = new Map()
    this.builders = builders
  }

  addMetric (metric, value, tag) {
    this.getOrCreateHandler(metric).add(value, tag)
  }

  getOrCreateHandler (metric) {
    let handler = this.handlers.get(metric)
    if (!handler) {
      handler = this.builders(metric)
      this.handlers.set(metric, handler)
    }
    return handler
  }

  drainMetrics () {
    const result = []
    for (const handler of this.handlers.values()) {
      const values = handler.drain()
      if (values && values.length) {
        result.push(...values)
      }
    }
    this.handlers.clear()
    return result
  }

  merge (metrics) {
    if (metrics) {
      for (const metricData of metrics) {
        this.getOrCreateHandler(metricData.metric).merge(metricData)
      }
    }
  }

  reset () {
    this.handlers = new Map()
  }
}

const GLOBAL = new TelemetryCollector(metric => metric.hasRequestScope()
  ? aggregated(metric)
  : conflated(metric)
)

function getMetricCollector (metric, context) {
  if (metric && metric.hasRequestScope()) {
    const telemetryCollector = getFromContext(context)
    if (telemetryCollector) {
      return telemetryCollector
    }
  }
  return GLOBAL
}

function init (context) {
  if (!context) return

  const collector = new TelemetryCollector((metric) => metric.hasRequestScope()
    ? conflated(metric)
    : delegating(metric, GLOBAL)
  )
  context[DD_TELEMETRY_COLLECTOR] = collector
  return collector
}

function getFromContext (context, deleteCollector) {
  const collector = context && context[DD_TELEMETRY_COLLECTOR]
  if (deleteCollector) {
    delete context[DD_TELEMETRY_COLLECTOR]
  }
  return collector
}

function addValue (metric, value, tag, context) {
  try {
    if (!metric) return

    const collector = getMetricCollector(metric, context)
    collector.addMetric(metric, value, tag)
  } catch (e) {
    log.error(e)
  }
}

function drain () {
  const drained = []
  for (const metricData of GLOBAL.drainMetrics()) {
    if (metricData.metric && metricData.points) {
      drained.push(metricData.getPayload())
    }
  }
  return drained
}

module.exports = {
  addValue,
  drain,
  getMetricCollector,
  init,
  getFromContext,

  TelemetryCollector,

  GLOBAL,
  DD_TELEMETRY_COLLECTOR
}
