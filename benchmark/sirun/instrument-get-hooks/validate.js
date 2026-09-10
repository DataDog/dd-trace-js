'use strict'

// Equivalence gate for the get-hooks.js pair, wired as a sirun `setup`
// command in meta.json. Sirun runs `setup` in its own process before the
// measured process exists: validation can neither warm the measured
// process's inline caches and JIT state nor land inside the measured window
// (sirun resets wall.time/instructions at the ready signal the bench's
// startup-guard writes in loopStart). A mismatch throws and the process
// exits non-zero, so sirun aborts the benchmark before a single sample is
// collected.
//
// The deduped variant must answer exactly the distinct hooks of the scan
// variant, or the two are not measuring the same workload. The counts
// differ on purpose: the scan variant resolves 144 hook objects per startup
// (one per transform), the deduped variant 66 (one per distinct
// (versionRange, filePath) pair).

const assert = require('node:assert/strict')

const { QUERIES, scanGetHooks, dedupedGetHooks } = require('./get-hooks')

for (const name of QUERIES) {
  const scanned = scanGetHooks(name)
  const byKey = new Map(scanned.map(hook => [`${hook.versions[0]}|${hook.file}`, hook]))
  const uniqueScanned = [...byKey.values()].map(({ name, versions, file }) => ({ name, versions, file }))
  assert.deepStrictEqual(uniqueScanned, dedupedGetHooks(name))
}
