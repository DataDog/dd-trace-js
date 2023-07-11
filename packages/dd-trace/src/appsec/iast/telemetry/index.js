'use strict'

const telemetryMetrics = require('../../../telemetry/metrics')
const telemetryLogs = require('./log')
const { Verbosity, getVerbosity } = require('./verbosity')
const { initRequestNamespace, finalizeRequestNamespace, globalNamespace } = require('./namespaces')

class Telemetry {
  configure (config, verbosity) {
    // in order to telemetry be enabled, tracer telemetry and metrics collection have to be enabled
    this.enabled = config && config.telemetry && config.telemetry.enabled && config.telemetry.metrics
    this.verbosity = this.enabled ? getVerbosity(verbosity) : Verbosity.OFF

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
    if (this.isEnabled() && this.verbosity !== Verbosity.OFF) {
      initRequestNamespace(context)
    }
  }

  onRequestEnd (context, rootSpan) {
    if (this.isEnabled() && this.verbosity !== Verbosity.OFF) {
      finalizeRequestNamespace(context, rootSpan)
    }
  }
}

module.exports = new Telemetry()
