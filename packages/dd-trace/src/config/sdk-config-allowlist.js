'use strict'

// SDK_CONFIGURATION currently only accepts configs that already had per-setting RC support under
// the (now removed) APM_TRACING capabilities. This is a temporary local list until
// supported-configurations.json gets a "remote" field to drive this from a single source of truth.
const sdkConfigAllowlist = new Set([
  'DD_TRACE_ENABLED',
  'DD_TRACE_SAMPLE_RATE',
  'DD_TRACE_SAMPLING_RULES',
  'DD_LOGS_INJECTION',
  'DD_TRACE_HEADER_TAGS',
  'DD_TAGS',
  'DD_DYNAMIC_INSTRUMENTATION_ENABLED',
  'DD_CODE_ORIGIN_FOR_SPANS_ENABLED',

  // Profiling (follow-up PR):
  // 'DD_PROFILING_ENABLED',
])

module.exports = { sdkConfigAllowlist }
