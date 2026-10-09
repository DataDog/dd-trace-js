'use strict'

// Run against a saved baseline module or the current implementation:
// node benchmark/known-flaky-tests.js /tmp/baseline-known-flaky-tests.js
// node benchmark/known-flaky-tests.js
const assert = require('node:assert/strict')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const { isKnownFlakyTest } = require(path.resolve(
  process.argv[2] || 'packages/dd-trace/src/ci-visibility/known-flaky-tests.js'
))

for (const size of [10, 1000, 10000]) {
  const names = Array.from({ length: size }, (_, index) => `parameterized test with example ${index}`)
  const queries = names.map((name, index) => index % 2 ? `${name} missing` : name)
  const rounds = Math.max(5, Math.ceil(50000 / size))
  const samples = []
  // Each sample includes the first lookup's indexing cost, then repeated checks across the suite.
  for (let sample = 0; sample < 8; sample++) {
    const tests = { mocha: { 'suite.js': names.slice() } }
    let hits = 0
    const start = performance.now()
    for (let round = 0; round < rounds; round++) {
      for (const name of queries) {
        hits += Number(isKnownFlakyTest(tests, 'mocha', 'suite.js', name))
      }
    }
    const elapsed = performance.now() - start
    assert.strictEqual(hits, size * rounds / 2)
    if (sample > 0) samples.push(elapsed * 1e6 / (size * rounds))
  }
  samples.sort((a, b) => a - b)
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ size, lookups: size * rounds, medianNsPerLookup: samples[3] }))
}
