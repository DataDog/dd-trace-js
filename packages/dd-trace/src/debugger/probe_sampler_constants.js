'use strict'

const DD_TRACE_SYMBOL = 'dd-trace'
const PROBE_SAMPLER_SYMBOL = 'dd-trace.debugger.probeSampler'

// Shared sampler contract used by the main debugger bootstrap and the devtools worker.
const MAX_SAMPLED_PROBES_PER_PAUSE = 256
const SAMPLED_PROBE_COUNT_INDEX = 0
const SAMPLED_PROBE_OVERFLOW_INDEX = 1
const SAMPLED_PROBE_INDEXES_START = 2

module.exports = {
  DD_TRACE_SYMBOL,
  MAX_SAMPLED_PROBES_PER_PAUSE,
  PROBE_SAMPLER_SYMBOL,
  SAMPLED_PROBE_COUNT_INDEX,
  SAMPLED_PROBE_INDEXES_START,
  SAMPLED_PROBE_OVERFLOW_INDEX,
}
