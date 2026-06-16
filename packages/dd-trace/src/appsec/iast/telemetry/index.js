'use strict'

const telemetryMetrics = require('../../../telemetry/metrics')
const { Verbosity, getVerbosity } = require('./verbosity')
const { initRequestNamespace, finalizeRequestNamespace, globalNamespace } = require('./namespaces')

class Telemetry {
  configure (config, verbosity) {
    const telemetryAndMetricsEnabled = config?.telemetry?.DD_INSTRUMENTATION_TELEMETRY_ENABLED &&
      config.telemetry.DD_TELEMETRY_METRICS_ENABLED

    this.verbosity = telemetryAndMetricsEnabled ? getVerbosity(verbosity) : Verbosity.OFF
    this.enabled = this.verbosity !== Verbosity.OFF

    if (this.enabled) {
      telemetryMetrics.manager.set('iast', globalNamespace)
    }
  }

  stop () {
    this.enabled = false
    telemetryMetrics.manager.delete('iast')
  }

  isEnabled () {
    return this.enabled
  }

  onRequestStart (context) {
    if (this.isEnabled()) {
      initRequestNamespace(context)
    }
  }

  onRequestEnd (context, rootSpan) {
    if (this.isEnabled()) {
      finalizeRequestNamespace(context, rootSpan)
    }
  }
}

module.exports = new Telemetry()
