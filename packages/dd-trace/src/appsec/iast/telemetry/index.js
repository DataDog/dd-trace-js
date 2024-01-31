'use strict'

const { Verbosity, getVerbosity } = require('./verbosity')
const { initRequestNamespace, finalizeRequestNamespace } = require('./namespaces')

class Telemetry {
  configure (config, verbosity) {
    const telemetryAndMetricsEnabled = config?.telemetry?.enabled && config.telemetry.metrics

    this.verbosity = telemetryAndMetricsEnabled ? getVerbosity(verbosity) : Verbosity.OFF
    this.enabled = this.verbosity !== Verbosity.OFF
  }

  stop () {
    this.enabled = false
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
