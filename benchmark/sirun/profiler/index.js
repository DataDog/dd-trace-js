'use strict'

const assert = require('node:assert/strict')

const tracer = require('../../..')

const { PROFILER } = process.env

if (PROFILER !== 'wall' && PROFILER !== 'all') {
  process.env.DD_PROFILING_WALLTIME_ENABLED = 'false'
}
if (PROFILER !== 'space' && PROFILER !== 'all') {
  process.env.DD_PROFILING_HEAP_ENABLED = 'false'
}
process.env.DD_PROFILING_HEAP_SAMPLING_INTERVAL = '0'

tracer.init({ profiling: 'true' })

assert.equal(tracer._profilerStarted, true, 'profiler.start did not return true')
