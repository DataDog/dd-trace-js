'use strict'

const DD_TRACE_SYMBOL = 'dd-trace'
const PROBE_SAMPLER_SYMBOL = 'dd-trace.debugger.probeSampler'

// Shared sampler contract used by the main debugger bootstrap and the devtools worker.
const MAX_SAMPLED_PROBES_PER_PAUSE = 256
const SAMPLED_PROBE_COUNT_INDEX = 0
const SAMPLED_PROBE_OVERFLOW_INDEX = 1
const SAMPLED_PROBE_INDEXES_START = 2

// Set on a sampled probe index when the pause is for reporting a condition evaluation error instead of a probe result.
const CONDITION_ERROR_FLAG = 1 << 30

// A probe whose condition failed to evaluate is not evaluated again for this long. One error result is reported per
// window, so a probe with a broken condition stays visible without repeatedly paying for the failing evaluation.
const CONDITION_ERROR_THROTTLE_NS = 5n * 60n * 1_000_000_000n // 5 minutes

module.exports = {
  CONDITION_ERROR_FLAG,
  CONDITION_ERROR_THROTTLE_NS,
  DD_TRACE_SYMBOL,
  MAX_SAMPLED_PROBES_PER_PAUSE,
  PROBE_SAMPLER_SYMBOL,
  SAMPLED_PROBE_COUNT_INDEX,
  SAMPLED_PROBE_INDEXES_START,
  SAMPLED_PROBE_OVERFLOW_INDEX,
}
