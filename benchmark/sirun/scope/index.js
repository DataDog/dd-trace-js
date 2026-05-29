'use strict'

const {
  SCOPE_ENABLED,
  COUNT,
} = process.env

const count = Number(COUNT)

// Drives a long chain of promise continuations, the microtask shape the tracer
// rides under each traced async operation. When enabled, every continuation is
// wrapped in scope.activate() exactly as the tracer does; the delta against the
// base variant is the per-hop AsyncLocalStorage enterWith plus store-copy cost.
let activate
if (SCOPE_ENABLED === 'true') {
  const Scope = require('../../../packages/dd-trace/src/scope')
  const scope = new Scope()
  const span = { _store: {} }
  activate = (cb) => scope.activate(span, cb)
} else {
  activate = (cb) => cb()
}

let p = Promise.resolve()
for (let i = 1; i < count; i++) {
  p = p.then(() => activate(() => {}))
}
