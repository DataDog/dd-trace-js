'use strict'

const {
  SCOPE_ENABLED,
  COUNT,
} = process.env

const count = Number(COUNT)

// The microtask shape the tracer rides under each traced async operation: a
// continuation that resolves, schedules the next, and so on. When enabled, every
// hop is wrapped in scope.activate() exactly as the tracer does; the delta
// against the base variant is the per-hop AsyncLocalStorage enterWith plus
// store-copy cost.
let activate
if (SCOPE_ENABLED === 'true') {
  const Scope = require('../../../packages/dd-trace/src/scope')
  const scope = new Scope()
  const span = { _store: {} }
  activate = (cb) => scope.activate(span, cb)
} else {
  activate = (cb) => cb()
}

// Run the hops as many short independent chains rather than one `count`-deep
// `.then()` chain. A single deep chain pins every promise + reaction object live
// at once (~1.3 GB at 7M hops), which OOM-thrashes under a constrained CI heap;
// short chains keep live memory flat while still performing `count` activate
// hops. CHAIN_DEPTH balances scheduler overhead against live-set size.
const CHAIN_DEPTH = 1000

function runChain (hops) {
  let p = Promise.resolve()
  for (let i = 0; i < hops; i++) {
    p = p.then(() => activate(() => {}))
  }
  return p
}

function runWave (remaining) {
  if (remaining <= 0) return
  const hops = remaining < CHAIN_DEPTH ? remaining : CHAIN_DEPTH
  runChain(hops).then(() => runWave(remaining - hops))
}

runWave(count)
