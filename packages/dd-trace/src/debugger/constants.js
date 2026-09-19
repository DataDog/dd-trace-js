'use strict'

module.exports = {
  DEFAULT_QUEUE_MAX_BYTES: 10 * 1024 * 1024,
  DIAGNOSTICS_QUEUE_MAX_BYTES: 1024 * 1024,
  MAX_MESSAGE_LENGTH: 8 * 1024,

  DEBUGGER_INPUT_DIRECT: '/api/v2/debugger',
  DEBUGGER_DIAGNOSTICS_V1: '/debugger/v1/diagnostics',
  DEBUGGER_INPUT_V1: '/debugger/v1/input',
  DEBUGGER_INPUT_V2: '/debugger/v2/input',

  // Guardrail counters are aggregated in shared memory and only converted into telemetry metrics at this interval, so
  // the interval bounds the delay before a guardrail hit becomes visible, not the cost of recording it. Tests wait on
  // it, so it is shared rather than duplicated.
  GUARDRAIL_METRICS_FLUSH_INTERVAL_MS: 10_000,

  INSPECT_SEGMENT_GLOBAL_PROPERTY: 'debuggerInspectSegment',
}
