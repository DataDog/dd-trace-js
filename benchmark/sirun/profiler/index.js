'use strict'

const assert = require('node:assert/strict')

const tracer = require('../../..')

const { PROFILER } = process.env

// Variant selection through env vars rather than a hand-rolled options object:
// that way the bench measures the real `Config` and tracer-init surface end to
// end and survives future fields being added to `Config`. The default profiler
// set is `space,wall`; we toggle each one off when its variant doesn't want it.
if (PROFILER !== 'wall' && PROFILER !== 'all') {
  process.env.DD_PROFILING_WALLTIME_ENABLED = 'false'
}
if (PROFILER !== 'space' && PROFILER !== 'all') {
  process.env.DD_PROFILING_HEAP_ENABLED = 'false'
}
process.env.DD_PROFILING_HEAP_SAMPLING_INTERVAL = '0'

tracer.init({ profiling: 'true' })

// Pre-flight sanity: confirm tracer init actually drove the profiler-start
// code path. Catches the silent breakage where an env-var rename or `Config`
// change reduces the bench to a near-no-op startup measurement.
assert.equal(tracer._profilerStarted, true, 'profiler.start did not return true')
