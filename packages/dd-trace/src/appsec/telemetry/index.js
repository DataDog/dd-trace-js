'use strict'

const logs = require('./api/logs-plugin')
const metrics = require('./api/metrics-plugin')
const { Verbosity, isDebugAllowed, isInfoAllowed, getVerbosity } = require('./verbosity')
const {
  drain: drainMetrics,
  init: initTelemetryCollector,
  getFromContext,
  GLOBAL
} = require('./telemetry-collector')
const {
  init: initLogCollector,
  drain: drainLogs
} = require('./log-collector')

const TRACE_METRIC_PATTERN = '_dd.instrumentation_telemetry_data.appsec'

class Telemetry {
  configure (config) {
    // in order to telemetry be enabled, tracer telemetry and metrics collection have to be enabled
    this.enabled = config && config.telemetry && config.telemetry.enabled && config.telemetry.metrics
    this.logCollectionDebugEnabled = this.enabled && config.telemetry.debug
    this.verbosity = this.enabled ? getVerbosity() : Verbosity.OFF

    if (this.enabled) {
      metrics.registerProvider(drainMetrics)
        .init(config.telemetry)

      logs.registerProvider(drainLogs)
        .init(config.telemetry, initLogCollector)
    }
  }

  stop () {
    this.enabled = false

    metrics.stop()
    logs.stop()
  }

  isEnabled () {
    return this.enabled
  }

  isLogCollectionDebugEnabled () {
    return this.isEnabled() && this.logCollectionDebugEnabled
  }

  isDebugEnabled () {
    return this.isEnabled() && isDebugAllowed(this.verbosity)
  }

  isInformationEnabled () {
    return this.isEnabled() && isInfoAllowed(this.verbosity)
  }

  onRequestStarted (context) {
    if (this.isEnabled() && this.verbosity !== Verbosity.OFF) {
      initTelemetryCollector(context)
    }
  }

  onRequestEnded (context, rootSpan, tagPrefix) {
    if (!this.isEnabled()) return

    const collector = getFromContext(context, true)
    if (!collector) return

    const metrics = collector.drainMetrics()
    this.addMetricsToSpan(rootSpan, metrics, tagPrefix || TRACE_METRIC_PATTERN)
    GLOBAL.merge(metrics)
  }

  flatten (metricData) {
    return metricData.points && metricData.points.map(point => point.value).reduce((total, value) => total + value, 0)
  }

  addMetricsToSpan (rootSpan, metrics, tagPrefix) {
    if (!rootSpan || !rootSpan.addTags || !metrics) return

    const flattenMap = new Map()
    metrics
      .filter(data => data && data.metric && data.metric.hasRequestScope())
      .forEach(data => {
        let total = flattenMap.get(data.metric)
        const value = this.flatten(data)
        if (!total) {
          total = value
        } else {
          total += value
        }
        flattenMap.set(data.metric, total)
      })

    for (const [key, value] of flattenMap) {
      const tagName = `${tagPrefix}.${key.name}`
      rootSpan.addTags({
        [tagName]: value
      })
    }
  }
}

module.exports = new Telemetry()
