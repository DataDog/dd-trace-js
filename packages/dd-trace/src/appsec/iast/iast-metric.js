'use strict'

const { Metric, Scope } = require('../telemetry/metric')

const IAST_NAMESPACE = 'iast'

const PropagationType = {
  STRING: 'STRING',
  JSON: 'JSON',
  URL: 'URL'
}

const MetricTag = {
  VULNERABILITY_TYPE: 'vulnerability_type',
  SOURCE_TYPE: 'source_type',
  PROPAGATION_TYPE: 'propagation_type'
}

function getExecutedMetric (metricTag) {
  return metricTag === MetricTag.VULNERABILITY_TYPE ? EXECUTED_SINK : EXECUTED_SOURCE
}

function getInstrumentedMetric (metricTag) {
  return metricTag === MetricTag.VULNERABILITY_TYPE ? INSTRUMENTED_SINK : INSTRUMENTED_SOURCE
}

const INSTRUMENTED_PROPAGATION =
  new Metric('instrumented.propagation', Scope.GLOBAL, MetricTag.PROPAGATION_TYPE, IAST_NAMESPACE)
const INSTRUMENTED_SOURCE = new Metric('instrumented.source', Scope.GLOBAL, MetricTag.SOURCE_TYPE, IAST_NAMESPACE)
const INSTRUMENTED_SINK = new Metric('instrumented.sink', Scope.GLOBAL, MetricTag.VULNERABILITY_TYPE, IAST_NAMESPACE)

const EXECUTED_SOURCE = new Metric('executed.source', Scope.REQUEST, MetricTag.SOURCE_TYPE, IAST_NAMESPACE)
const EXECUTED_SINK = new Metric('executed.sink', Scope.REQUEST, MetricTag.VULNERABILITY_TYPE, IAST_NAMESPACE)

const REQUEST_TAINTED = new Metric('request.tainted', Scope.REQUEST, null, IAST_NAMESPACE)

// DEBUG using metrics
const EXECUTED_PROPAGATION =
  new Metric('executed.propagation', Scope.REQUEST, MetricTag.PROPAGATION_TYPE, IAST_NAMESPACE)
const EXECUTED_TAINTED = new Metric('executed.tainted', Scope.REQUEST, null, IAST_NAMESPACE)

// DEBUG using log endpoint
// const SOURCE_DEBUG = new Metric('source.debug', Scope.GLOBAL, null, IAST_NAMESPACE)
// const PROPAGATION_DEBUG = new Metric('propagation.debug', Scope.GLOBAL, null, IAST_NAMESPACE)
// const SINK_DEBUG = new Metric('sink.debug', Scope.GLOBAL, null, IAST_NAMESPACE)
// const TAINTED_DEBUG = new Metric('tainted.debug', Scope.GLOBAL, null, IAST_NAMESPACE)
// const TAINTED_SINK_DEBUG = new Metric('tainted.sink.debug', Scope.GLOBAL, null, IAST_NAMESPACE)

// DEBUG using distribution endpoint
const INSTRUMENTATION_TIME = new Metric('instrumentation.time', Scope.GLOBAL, null, IAST_NAMESPACE)
// const EXECUTION_TIME = new Metric('execution.time', Scope.GLOBAL, null, IAST_NAMESPACE)

module.exports = {
  INSTRUMENTED_PROPAGATION,
  INSTRUMENTED_SOURCE,
  INSTRUMENTED_SINK,

  EXECUTED_PROPAGATION,
  EXECUTED_SOURCE,
  EXECUTED_SINK,
  EXECUTED_TAINTED,

  REQUEST_TAINTED,

  INSTRUMENTATION_TIME,

  PropagationType,
  MetricTag,

  getExecutedMetric,
  getInstrumentedMetric
}
