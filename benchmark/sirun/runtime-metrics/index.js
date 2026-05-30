'use strict'

const assert = require('node:assert/strict')

const tracer = require('../../..').init()
// Fail loudly if the tracer did not load: this bench measures background
// runtime-metrics collection over a 1s window, which only happens once the
// tracer is up.
assert.equal(typeof tracer.startSpan, 'function', 'tracer did not initialize')

setTimeout(() => {}, 1000)
