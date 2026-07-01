'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const {
  SCOPE_ENABLED,
  MODE,
  OPERATIONS,
} = process.env

const count = Number(OPERATIONS)

// Build a span whose `_store` is a real legacy-storage handle, exactly as a span
// created under an active parent captures one. activate() resolves the parent
// store via `getStore(span._store)`; a plain-object handle misses the storage
// WeakMap, so the per-hop parent-store copy never runs and the bench measures
// only enterWith. The handle has to resolve to a populated store for the copy to
// be exercised, so seed an active store first and capture its handle.
function makeSpan () {
  const { storage } = require('../../../packages/datadog-core')
  const legacyStorage = storage('legacy')
  legacyStorage.enterWith({ span: {} })
  const span = { _store: legacyStorage.getHandle() }
  assert.ok(legacyStorage.getStore(span._store), 'synthetic span handle does not resolve to a store')
  return span
}

if (MODE === 'bind') {
  // scope.bind wraps a callback so it later runs inside a captured span context
  // -- the path every bound continuation, timer and event handler takes. Each
  // call is one closure allocation plus one activate (AsyncLocalStorage enterWith
  // + store copy + restore). Run synchronously so the measurement is the bind +
  // activate cost itself rather than promise scheduling; the async-chain shape is
  // the scope_enabled variant.
  const Scope = require('../../../packages/dd-trace/src/scope')
  const scope = new Scope()
  const span = makeSpan()
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
  // continuation that resolves, schedules the next, and so on. When SCOPE_ENABLED is
  // set, every hop is wrapped in scope.activate() exactly as the tracer does (the
  // per-hop AsyncLocalStorage enterWith plus parent store copy); unset, the hop runs
  // bare. CI runs only the enabled variant -- there is no baseline wiring -- but the
  // bare path stays available for a local A/B.
  let activate
  if (SCOPE_ENABLED === 'true') {
    const Scope = require('../../../packages/dd-trace/src/scope')
    const scope = new Scope()
    const span = makeSpan()
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
