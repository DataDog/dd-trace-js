'use strict'

const telemetryMetrics = require('../../../telemetry/metrics')
const telemetryLogs = require('./log')
const { Verbosity, isDebugAllowed, isInfoAllowed, getVerbosity } = require('./verbosity')
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

  isDebugEnabled () {
    return this.isEnabled() && isDebugAllowed(this.verbosity)
  }

  isInformationEnabled () {
    return this.isEnabled() && isInfoAllowed(this.verbosity)
  }

  onRequestStart (context) {
    if (this.isEnabled() && this.verbosity !== Verbosity.OFF) {
      initRequestNamespace(context)
    }
  }

  onRequestEnd (context, rootSpan) {
    if (this.isEnabled() && this.verbosity !== Verbosity.OFF) {
      finalizeRequestNamespace(context, rootSpan, this.namespace)
    }
  }
}

module.exports = new Telemetry()
