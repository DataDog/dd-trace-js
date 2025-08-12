'use strict'

const iastTelemetry = require('../telemetry')
const { Verbosity } = require('../telemetry/verbosity')
const { INSTRUMENTED_PROPAGATION } = require('../telemetry/iast-metric')

function incrementTelemetryIfNeeded (metrics) {
  if (iastTelemetry.verbosity !== Verbosity.OFF && metrics?.instrumentedPropagation) {
    INSTRUMENTED_PROPAGATION.inc(undefined, metrics.instrumentedPropagation)
  }
}

module.exports = { incrementTelemetryIfNeeded }
