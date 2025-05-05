'use strict'

const iastTelemetry = require('../appsec/iast/telemetry')
const { Verbosity } = require('../appsec/iast/telemetry/verbosity')
const { INSTRUMENTED_PROPAGATION } = require('../appsec/iast/telemetry/iast-metric')

function incrementTelemetryIfNeeded (metrics) {
  if (iastTelemetry.verbosity !== Verbosity.OFF && metrics?.instrumentedPropagation) {
    INSTRUMENTED_PROPAGATION.inc(undefined, metrics.instrumentedPropagation)
  }
}

module.exports = { incrementTelemetryIfNeeded }
