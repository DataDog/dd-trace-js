'use strict'

const assert = require('node:assert/strict')

const guard = require('../startup-guard')

// Self-contained algorithm comparison for `getHooks` in
// packages/datadog-instrumentations/src/helpers/instrument.js, which every
// rewriter-based integration calls once at require time to look up its module
// hooks (23 calls per traced process, one per rewriter-instrumented module).
// Both implementations are kept here verbatim so the bench runs standalone:
// - scan: the pre-index implementation - a full map -> filter (with a nested
//   `names.includes`) -> map over the rewriter list on every call.
// - indexed: the name-indexed implementation - one pass dedupes the hooks by
//   (versionRange, filePath) into a Map, then each call is a lookup plus a
//   defensive copy of the cached hooks.
// Each loop iteration simulates one complete tracer startup, end to end and
// inside the measured window: the indexed variant (re)builds the startup
// index and then resolves hooks for every rewriter-instrumented module once,
// matching the production lookup count; the scan variant resolves the same
// names with no startup cost of its own. That keeps the index construction in
// the measurement instead of amortizing it away behind a synthetic lookup
// loop, since production never calls `getHooks` in a hot loop.

const STARTUPS = Number(process.env.STARTUPS) || 20000
const SCAN = Number(process.env.SCAN)

const rewriterInstrumentations =
  require('../../../packages/datadog-instrumentations/src/helpers/rewriter/instrumentations')

const NAMES = [...new Set(rewriterInstrumentations.map(inst => inst.module.name))]

function scanGetHooks (names) {
  names = [names].flat()

  return rewriterInstrumentations
    .map(inst => inst.module)
    .filter(({ name }) => names.includes(name))
    .map(({ name, versionRange, filePath }) => ({ name, versions: [versionRange], file: filePath }))
}

let rewriterHooksByName = new Map()

// Mirrors the eager startup index of the proposed helpers/instrument.js; it is
// rebuilt per simulated startup so its construction cost lands inside the
// measured window, exactly where production pays it (once, at require time).
function buildRewriterHooksByName () {
  rewriterHooksByName = new Map()
  for (const { module: { name, versionRange, filePath } } of rewriterInstrumentations) {
    const hooks = rewriterHooksByName.get(name) ?? []
    if (!hooks.some(({ versions, file }) => file === filePath && versions[0] === versionRange)) {
      hooks.push({ name, versions: [versionRange], file: filePath })
    }
    rewriterHooksByName.set(name, hooks)
  }
}

function indexedGetHooks (names) {
  const hooks = []
  for (const name of new Set([names].flat())) {
    const hooksByName = rewriterHooksByName.get(name)
    if (!hooksByName) continue
    for (const hook of hooksByName) hooks.push({ ...hook, versions: [...hook.versions] })
  }
  return hooks
}

// One simulated tracer startup: resolve the hooks every rewriter-based
// integration resolves at its require time.
function resolveStartupScan () {
  let hooks = 0
  for (const name of NAMES) hooks += scanGetHooks(name).length
  return hooks
}

function resolveStartupIndexed () {
  buildRewriterHooksByName()
  let hooks = 0
  for (const name of NAMES) hooks += indexedGetHooks(name).length
  return hooks
}

// The two implementations must stay observationally equivalent up to the
// deduplication the index itself introduces, or the variants are not
// measuring the same workload. The counts differ on purpose: the scan variant
// resolves 193 hook objects per startup (one per transform), the indexed
// variant 81 (one per distinct versionRange/file pair).
buildRewriterHooksByName()
for (const name of NAMES) {
  const scanned = scanGetHooks(name)
  const uniqueScanned = [...new Map(scanned.map(hook => [`${hook.versions[0]}|${hook.file}`, hook])).values()]
    .map(({ versions, file }) => ({ versions, file }))
  const indexed = indexedGetHooks(name).map(({ versions, file }) => ({ versions, file }))
  assert.deepStrictEqual(uniqueScanned, indexed)
}

let sink = 0

guard.loopStart()
for (let i = 0; i < STARTUPS; i++) {
  sink += SCAN ? resolveStartupScan() : resolveStartupIndexed()
}
guard.done(0.3) // see README: the indexed loop is shorter by the size of the win itself

assert.ok(sink > 0, 'benchmark did no work')
