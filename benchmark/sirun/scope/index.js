'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const {
  SCOPE_ENABLED,
  MODE,
  COUNT,
} = process.env

const count = Number(COUNT)

if (MODE === 'bind') {
  // scope.bind wraps a callback so it later runs inside a captured span context
  // -- the path every bound continuation, timer and event handler takes. Each
  // call is one closure allocation plus one activate (AsyncLocalStorage enterWith
  // + store copy + restore). Run synchronously so the measurement is the bind +
  // activate cost itself rather than promise scheduling; the async-chain shape is
  // the scope_enabled variant.
  const Scope = require('../../../packages/dd-trace/src/scope')
  const scope = new Scope()
  const span = { _store: {} }
  let sink = 0
  const target = () => ++sink

  // Sanity: a bound function runs its target and returns its value.
  scope.activate(span, () => {})
  assert.equal(scope.bind(target, span)(), 1, 'bound function did not invoke its target')

  guard.loopStart()
  for (let i = 0; i < count; i++) {
    scope.bind(target, span)()
  }
  guard.done()

  assert.ok(sink > 0, 'scope.bind loop produced no work')
} else {
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

  // Sanity-check the wiring once before the timed wave: a broken scope.activate
  // that skipped its callback would otherwise measure a near-empty loop and
  // silently "pass".
  let activated = false
  activate(() => { activated = true })
  assert.ok(activated, 'scope.activate did not invoke its callback')

  // Run the hops as many short independent chains rather than one `count`-deep
  // `.then()` chain. A single deep chain pins every promise + reaction object live
  // at once (~1.3 GB at 7M hops), which OOM-thrashes under a constrained CI heap;
  // short chains keep live memory flat while still performing `count` activate
  // hops. CHAIN_DEPTH balances scheduler overhead against live-set size.
  const CHAIN_DEPTH = 1000

  const runChain = (hops) => {
    let p = Promise.resolve()
    for (let i = 0; i < hops; i++) {
      p = p.then(() => activate(() => {}))
    }
    return p
  }

  const runWave = (remaining) => {
    if (remaining <= 0) {
      guard.done()
      return
    }
    const hops = remaining < CHAIN_DEPTH ? remaining : CHAIN_DEPTH
    runChain(hops).then(() => runWave(remaining - hops))
  }

  guard.loopStart()
  runWave(count)
}
