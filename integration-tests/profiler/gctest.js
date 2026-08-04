'use strict'

require('dd-trace').init()

// Allocate a lot of short-lived objects to force young-generation garbage
// collections. Under V8's --minor-ms flag these are emitted as Minor
// Mark-Sweep (kind 2) GC events, which used to crash the profiler. See
// https://github.com/DataDog/dd-trace-js/issues/8839
setImmediate(() => {
  let sink
  for (let i = 0; i < 1000; i++) {
    const garbage = []
    for (let j = 0; j < 10000; j++) {
      garbage.push({ i, j, payload: `garbage-${i}-${j}` })
    }
    sink = garbage[garbage.length - 1]
  }
  // Reference sink so V8 can't optimize the allocations away.
  if (sink === undefined) throw new Error('unexpected')
})
