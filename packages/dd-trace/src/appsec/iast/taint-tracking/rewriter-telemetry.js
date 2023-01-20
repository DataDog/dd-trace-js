'use strict'

const telemetry = require('../../telemetry')
const { Verbosity } = require('../../telemetry/verbosity')
const { INSTRUMENTED_PROPAGATION, INSTRUMENTATION_TIME, PropagationType } = require('../iast-metric')

const telemetryRewriter = {
  off (content, filename, rewriter) {
    return rewriter.rewrite(content, filename)
  },

  information (content, filename, rewriter) {
    const response = this.off(content, filename, rewriter)

    const metrics = response.metrics
    if (metrics && metrics.instrumentedPropagation) {
      INSTRUMENTED_PROPAGATION.add(metrics.instrumentedPropagation, PropagationType.STRING)
    }

    return response
  },

  debug (content, filename, rewriter) {
    const start = process.hrtime.bigint()
    const response = this.information(content, filename, rewriter)

    // TODO: propagationDebug!
    const metrics = response.metrics
    if (metrics && metrics.propagationDebug) {
      // debug metrics are using logs telemetry API instead metrics telemetry API
    }

    const rewriteTime = parseInt(process.hrtime.bigint() - start) * 1e-6
    INSTRUMENTATION_TIME.add(rewriteTime)
    return response
  }
}

function getRewriteFunction (rewriter) {
  switch (telemetry.verbosity) {
    case Verbosity.OFF:
      return (content, filename) => telemetryRewriter.off(content, filename, rewriter)
    case Verbosity.DEBUG:
      return (content, filename) => telemetryRewriter.debug(content, filename, rewriter)
    default:
      return (content, filename) => telemetryRewriter.information(content, filename, rewriter)
  }
}

module.exports = { getRewriteFunction }
