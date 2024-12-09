'use strict'

const iastTelemetry = require('../telemetry')
const { Verbosity } = require('../telemetry/verbosity')
const { INSTRUMENTED_PROPAGATION } = require('../telemetry/iast-metric')

const telemetryRewriter = {
  off (content, filename, rewriter) {
    return rewriter.rewrite(content, filename)
  },

  information (content, filename, rewriter) {
    const response = this.off(content, filename, rewriter)

    incrementTelemetry(response.metrics)

    return response
  }
}

function getRewriteFunction (rewriter) {
  switch (iastTelemetry.verbosity) {
    case Verbosity.OFF:
      return (content, filename) => telemetryRewriter.off(content, filename, rewriter)
    default:
      return (content, filename) => telemetryRewriter.information(content, filename, rewriter)
  }
}

function incrementTelemetry (metrics) {
  if (metrics?.instrumentedPropagation) {
    INSTRUMENTED_PROPAGATION.inc(undefined, metrics.instrumentedPropagation)
  }
}

function incrementTelemetryIfNeeded (metrics) {
  if (iastTelemetry.verbosity !== Verbosity.OFF) {
    incrementTelemetry(metrics)
  }
}

module.exports = { getRewriteFunction, incrementTelemetryIfNeeded }
