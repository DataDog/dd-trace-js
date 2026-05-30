'use strict'

const assert = require('node:assert/strict')
const shimmer = require('../../../packages/datadog-shimmer')

// Measures the cost of the wrap operation itself (what every instrumentation
// pays at load time), not the cost of calling the result. shimmer.wrap (object
// property, via property descriptors) and shimmer.wrapFunction (standalone) are
// genuinely different operations here, so WRAP_FUNCTION selects which one. The
// wrapped function's shape is irrelevant to the wrap cost, so a single sync
// target is used. A fresh object is wrapped each iteration so nothing nests and
// memory stays flat as ITERATIONS grows.
const useWrapFunction = process.env.WRAP_FUNCTION === 'true'
const ITERATIONS = Number(process.env.ITERATIONS) || 1e6

let counter = 0
function target () {
  return ++counter // Do very little
}

const passthrough = (original) => function (...args) {
  return original.apply(this, args)
}

let lastWrapped
for (let i = 0; i < ITERATIONS; i++) {
  if (useWrapFunction) {
    lastWrapped = shimmer.wrapFunction(target, passthrough)
  } else {
    const obj = { target }
    shimmer.wrap(obj, 'target', passthrough)
    lastWrapped = obj.target
  }
}

// Fail loudly if the wrap operation stops producing a delegating wrapper.
assert.equal(typeof lastWrapped, 'function')
assert.equal(lastWrapped(), 1, 'wrapped function should delegate to the original')
