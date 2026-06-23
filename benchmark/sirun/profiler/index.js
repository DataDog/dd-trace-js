'use strict'

const assert = require('node:assert/strict')

const guard = require('../startup-guard')
const tracer = require('../../..')

const { PROFILER } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

if (PROFILER !== 'wall' && PROFILER !== 'all') {
  process.env.DD_PROFILING_WALLTIME_ENABLED = 'false'
}
if (PROFILER !== 'space' && PROFILER !== 'all') {
  process.env.DD_PROFILING_HEAP_ENABLED = 'false'
}
process.env.DD_PROFILING_HEAP_SAMPLING_INTERVAL = '0'

tracer.init({ profiling: 'true' })

assert.equal(tracer._profilerStarted, true, 'profiler.start did not return true')

// Keep the process busy so the wall and space profilers actually sample. Sized
// to stay under the 60s upload period, so no profile is exported and no agent
// is required.
guard.loopStart()
let sink = 0
for (let round = 0; round < OPERATIONS; round++) {
  for (let i = 0; i < 20_000; i++) {
    sink += Math.sqrt(i) * Math.cos(i)
  }
  const items = new Array(2000)
  for (let i = 0; i < items.length; i++) {
    items[i] = { index: i, label: `item-${i}` }
  }
  sink += items[round % items.length].index
}

assert.notEqual(sink, Infinity)

guard.done()
