'use strict'

const telemetryMetrics = require('../../../telemetry/metrics')
const telemetryLogs = require('./log')
const { Verbosity, getVerbosity } = require('./verbosity')
const { initRequestNamespace, finalizeRequestNamespace, globalNamespace } = require('./namespaces')

class Telemetry {
  configure (config, verbosity) {
    const telemetryAndMetricsEnabled = config?.telemetry?.enabled && config.telemetry.metrics

    this.verbosity = telemetryAndMetricsEnabled ? getVerbosity(verbosity) : Verbosity.OFF
    this.enabled = this.verbosity !== Verbosity.OFF

    if (this.enabled) {
      telemetryMetrics.manager.set('iast', globalNamespace)
    }

    telemetryLogs.start()
  }

  stop () {
    this.enabled = false
    telemetryMetrics.manager.delete('iast')

    telemetryLogs.stop()
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
