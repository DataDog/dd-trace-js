'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')
const shimmer = require('../../../packages/datadog-shimmer')

// Measures the per-call cost of a shimmer-wrapped function. shimmer.wrap (object
// property) and shimmer.wrapFunction (standalone) produce the same wrapper, so
// the call cost is the same; WRAP_FUNCTION just selects which API created it,
// and both are kept as a guard against the wrappers diverging. Only a sync
// target is exercised on purpose: an async target would spend most of the loop
// allocating promises (not shimmer's cost) and add GC jitter. The wrap-time
// difference between the two APIs is covered by the shimmer-startup bench.
const useWrapFunction = process.env.WRAP_FUNCTION === 'true'
const OPERATIONS = Number(process.env.OPERATIONS)

let counter = 0
function target () {
  return ++counter // Do very little
}

const passthrough = (original) => function (...args) {
  return original.apply(this, args)
}

let wrapped
if (useWrapFunction) {
  wrapped = shimmer.wrapFunction(target, passthrough)
} else {
  const obj = { target }
  shimmer.wrap(obj, 'target', passthrough)
  wrapped = obj.target
}

guard.loopStart()
for (let i = 0; i < OPERATIONS; i++) {
  wrapped()
}
guard.done()

// Fail loudly if the wrapper stops delegating to the original function.
assert.equal(counter, OPERATIONS, 'wrapped function did not run OPERATIONS times')
