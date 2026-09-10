'use strict'

const assert = require('node:assert/strict')

const guard = require('../startup-guard')
const { QUERIES, scanGetHooks, dedupedGetHooks } = require('./get-hooks')

// Cost-of-correctness benchmark for `getHooks` in
// packages/datadog-instrumentations/src/helpers/instrument.js, quantifying the
// fix that dedupes rewriter hooks by (versionRange, filePath). The two
// implementations live in ./get-hooks.js (see its header), and ./validate.js
// runs as a sirun `setup` command that gates their equivalence outside the
// measured process.
//
// The workload models what production actually does. `getHooks` is called
// once per module name, lazily, from integration files that
// helpers/register.js only runs when the user's package loads; a traced
// process performs zero of these calls at tracer init, and all 13 only when
// every instrumented package family is used. So there is no hot loop to
// optimize and no startup cost to charge against lookup savings: the
// question this bench answers is how much the dedupe costs (or saves) per
// startup, at the real query count.
//
// Production call sites never stop at the hook count either - each one
// registers every returned hook through `addHook` (for example
// azure-cosmos.js: `for (const hook of getHooks('@azure/cosmos'))
// addHook(hook, exports => exports)`). The registration pass is modeled
// here on purpose: the scan variant resolves 144 hooks per startup where
// the deduped variant resolves 66, so the per-hook registration work is a
// real part of what the dedupe saves in production, and leaving it out would
// bias the comparison toward the scan variant.
//
// Variants (see meta.json):
// - *-cold: one simulated startup through the measured window per process -
//   each sirun iteration is a fresh process, so the window is paid cold,
//   exactly where production pays it. The share guard is vacuous for these
//   by design (load+setup legitimately dominates a single pass).
// - *-warm: 20 000 simulated startups per process, for steady-state per-call
//   signal over the same workload.

const STARTUPS = Number(process.env.STARTUPS) || 20000
const SCAN = Number(process.env.SCAN)

// One simulated startup: resolve the hooks every lazy integration resolves
// when its user package loads, and register each one - an addHook-style
// push of { versions, file, hook } into a per-startup instrumentations map,
// one closure per hook, as every integration file does.
function resolveStartup () {
  const getHooks = SCAN ? scanGetHooks : dedupedGetHooks
  const instrumentations = new Map()
  let hooks = 0
  for (const name of QUERIES) {
    for (const { versions, file } of getHooks(name)) {
      hooks++
      let byName = instrumentations.get(name)
      if (!byName) {
        byName = []
        instrumentations.set(name, byName)
      }
      byName.push({ versions, file, hook: exports => exports })
    }
  }
  return hooks
}

let sink = 0

guard.loopStart()
for (let i = 0; i < STARTUPS; i++) {
  sink += resolveStartup()
}
// Cold variants run a single startup through the window, so load+setup
// legitimately dominates; only the warm variants enforce a share ceiling.
guard.done(STARTUPS > 1 ? 0.15 : 1)

assert.ok(sink > 0, 'benchmark did no work')
