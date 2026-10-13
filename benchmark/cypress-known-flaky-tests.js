'use strict'

// node benchmark/cypress-known-flaky-tests.js /tmp/baseline-cypress-support.js
// node benchmark/cypress-known-flaky-tests.js
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { performance } = require('node:perf_hooks')
const { runInNewContext } = require('node:vm')

const source = readFileSync(process.argv[2] || 'packages/datadog-plugin-cypress/src/support.js', 'utf8')

for (const size of [10, 1000, 10000]) {
  const names = Array.from({ length: size }, (_, index) => `parameterized test with example ${index}`)
  const tests = names.map((name, index) => ({
    id: String(index),
    fullTitle: () => index % 2 ? `${name} missing` : name,
    _retries: 2,
  }))
  const samples = []
  for (let sample = 0; sample < 8; sample++) {
    const hooks = new Map()
    const suite = { file: 'suite.cy.js', eachTest: fn => tests.forEach(fn) }
    const runner = { runTests () {} }
    const suiteConfig = { flakyTestsForSuite: names.slice(), nativeRetryCount: 0, isTextTerminal: true }
    let beforeSuite
    runInNewContext(source, {
      Cypress: {
        on: (event, handler) => hooks.set(event, handler),
        config: () => true,
        mocha: { getRunner: () => runner, getRootSuite: () => suite },
      },
      cy: { task: () => ({ then: fn => fn(suiteConfig) }) },
      before: fn => { beforeSuite = fn },
      beforeEach () {},
      afterEach () {},
      after () {},
    })
    const beforeRun = hooks.get('test:before:run')
    const beforeRunAsync = hooks.get('test:before:run:async')
    const start = performance.now()
    // Include index creation and the root-suite pass, followed by both per-test events.
    beforeSuite()
    for (const test of tests) {
      beforeRun({}, test)
      beforeRunAsync({}, test)
    }
    const elapsed = performance.now() - start
    for (const [index, test] of tests.entries()) {
      assert.strictEqual(test._retries, index % 2 ? 0 : 2)
    }
    if (sample > 0) samples.push(elapsed)
  }
  samples.sort((a, b) => a - b)
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ size, lookups: size * 3, medianMsPerSuite: samples[3] }))
}
