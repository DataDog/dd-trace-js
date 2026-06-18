'use strict'

const assert = require('node:assert/strict')

// Measures the startup overhead of enabling runtime metrics: init wires up the
// native-metrics collector, the GC PerformanceObserver, the event-loop monitor,
// the dogstatsd client and the flush interval. The old idle-window shape measured
// a 1s timer rather than that work -- the periodic per-collection cost is sub-ms
// and invisible in an idle wall-time, which read as ~16% jitter. The control vs
// with-metrics init delta is deterministic. (A precise per-collection bench would
// need the module's private capture path exposed, which isn't worth it here.)
const tracer = require('../../..').init()
assert.equal(typeof tracer.startSpan, 'function', 'tracer did not initialize')
