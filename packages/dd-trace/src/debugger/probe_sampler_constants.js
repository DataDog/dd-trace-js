'use strict'

const DD_TRACE_SYMBOL = 'dd-trace'
const PROBE_SAMPLER_SYMBOL = 'dd-trace.debugger.probeSampler'

// Shared sampler contract used by the main debugger bootstrap and the devtools worker. The debuggee hands sampled
// probes to the worker through a shared Int32Array, drained by the worker on every pause:
//
//            +----------+----------+----------+----------+- - - -+------------+
//   slot     |    0     |    1     |    2     |    3     |       | 2+MAX-1    |
//   holds    |  count   | overflow | value    | value    |  ...  | value      |
//            +----------+----------+----------+----------+- - - -+------------+
//             ^COUNT     ^OVERFLOW  ^INDEXES_START
const MAX_SAMPLED_PROBES_PER_PAUSE = 256
const SAMPLED_PROBE_COUNT_INDEX = 0
const SAMPLED_PROBE_OVERFLOW_INDEX = 1
const SAMPLED_PROBE_INDEXES_START = 2

// Each value above is a probe sampling index, with this flag set in bit 30 when the pause is for reporting a
// condition evaluation error instead of a probe result. Bit 31 stays unused because the array is signed:
//
//            +--------+------------+--------------------------------------------+
//   bit      |   31   |     30     |                   29..0                    |
//   means    | unused | CONDITION_ |                samplingIndex               |
//            | (sign) | ERROR_FLAG |                                            |
//            +--------+------------+--------------------------------------------+
//
//   0x0000_0007  probe #7 matched            -> worker captures as usual
//   0x4000_0007  probe #7's condition threw  -> worker takes the recorded error, captures nothing
//
//   write: probeIndex | CONDITION_ERROR_FLAG
//   read:  value & ~CONDITION_ERROR_FLAG  -> the sampling index
//          value &  CONDITION_ERROR_FLAG  -> non-zero when the condition threw
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
