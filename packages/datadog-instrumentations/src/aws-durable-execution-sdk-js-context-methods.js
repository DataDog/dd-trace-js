'use strict'

// Methods on `DurableContextImpl` that return a lazy DurablePromise. The rewriter
// instrumentation generates a `kind: 'Sync'` Orchestrion hook for each so Orchestrion
// does not eagerly side-chain `.then()`; the runtime instrumentation side-chains the
// returned DurablePromise itself and publishes a `:settle` channel once it settles,
// preserving the SDK's lazy semantics. Shared between both so the lists cannot drift.
module.exports = [
  'step',
  'invoke',
  'runInChildContext',
  'wait',
  'waitForCondition',
  'waitForCallback',
  'createCallback',
  'map',
  'parallel',
]
