'use strict'

if (Number(process.env.USE_TRACER)) {
  require('../../..').init()
}

const Promise = require('../../../versions/bluebird/node_modules/bluebird/js/release/bluebird')

// Total `.then` hops per process. The tracer's promise instrumentation is paid
// per hop, so a large total keeps the fixed tracer load a small fraction of the
// run. Run it as many short chains rather than one COUNT-deep chain: a deep chain
// pins every promise plus reaction live at once and blows the heap, whereas short
// chains keep live memory flat while still performing COUNT hops.
const count = process.env.COUNT ? Number(process.env.COUNT) : 30_000_000
const CHAIN_DEPTH = 1000

function runChain (hops) {
  let resolvePromise
  const p = new Promise((resolve) => { resolvePromise = resolve })
  let pChain = p
  for (let i = 0; i < hops; i++) {
    pChain = pChain.then(() => {})
  }
  resolvePromise()
  return pChain
}

function runWave (remaining) {
  if (remaining <= 0) return
  const hops = remaining < CHAIN_DEPTH ? remaining : CHAIN_DEPTH
  runChain(hops).then(() => runWave(remaining - hops))
}

runWave(count)
