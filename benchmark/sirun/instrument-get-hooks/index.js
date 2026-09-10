'use strict'

const assert = require('node:assert/strict')

const guard = require('../startup-guard')

// Self-contained algorithm comparison for `getHooks` in
// packages/datadog-instrumentations/src/helpers/instrument.js, which every
// rewriter-based integration calls once at require time to look up its module
// hooks (15+ calls per traced process). Both implementations are kept here
// verbatim so the bench runs standalone:
// - scan: the pre-index implementation - a full map -> filter (with a nested
//   `names.includes`) -> map over the rewriter list on every call.
// - indexed: the name-indexed implementation - one startup pass dedupes the
//   hooks by (versionRange, filePath) into a Map, then each call is a lookup
//   plus a defensive copy of the cached hooks.
// The optimization that ships the indexed implementation is stacked on this
// branch; that PR repoints the indexed variant at the shipped helper so the
// bench keeps tracking production code once it lands.

const CALLS = Number(process.env.CALLS) || 100000
const SCAN = Number(process.env.SCAN)

const rewriterInstrumentations =
  require('../../../packages/datadog-instrumentations/src/helpers/rewriter/instrumentations')

function scanGetHooks (names) {
  names = [names].flat()

  return rewriterInstrumentations
    .map(inst => inst.module)
    .filter(({ name }) => names.includes(name))
    .map(({ name, versionRange, filePath }) => ({ name, versions: [versionRange], file: filePath }))
}

const rewriterHooksByName = new Map()
for (const { module: { name, versionRange, filePath } } of rewriterInstrumentations) {
  const hooks = rewriterHooksByName.get(name) ?? []
  if (!hooks.some(({ versions, file }) => file === filePath && versions[0] === versionRange)) {
    hooks.push({ name, versions: [versionRange], file: filePath })
  }
  rewriterHooksByName.set(name, hooks)
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

const NAMES = [...new Set(rewriterInstrumentations.map(inst => inst.module.name))]

// The two implementations must stay observationally equivalent up to the
// deduplication the index itself introduces, or the variants are not
// measuring the same workload.
for (const name of NAMES) {
  const scanned = scanGetHooks(name)
  const uniqueScanned = [...new Map(scanned.map(hook => [`${hook.versions[0]}|${hook.file}`, hook])).values()]
    .map(({ versions, file }) => ({ versions, file }))
  const indexed = indexedGetHooks(name).map(({ versions, file }) => ({ versions, file }))
  assert.deepStrictEqual(uniqueScanned, indexed)
}

let sink = 0

guard.loopStart()
for (let i = 0; i < CALLS; i++) {
  const hooks = SCAN ? scanGetHooks(NAMES[i % NAMES.length]) : indexedGetHooks(NAMES[i % NAMES.length])
  sink += hooks.length
}
guard.done(0.3) // the indexed loop is intentionally ~100x shorter; see README

assert.ok(sink > 0, 'benchmark did no work')
