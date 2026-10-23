'use strict'

const assert = require('node:assert/strict')
const { setImmediate: nextTurn } = require('node:timers/promises')

const Mocha = require('mocha')

async function runTests () {
  const mocha = new Mocha({
    reporter: 'dot',
    // These options normally arrive from Mocha's parallel runner.
    _ddIsFlakyTestRetriesEnabled: true,
    _ddIsDynamicAtrEnabled: true,
    _ddDynamicAtrBuckets: [1, 1, 1, 1, 1],
  })
  const refs = [new WeakRef(mocha.suite)]
  for (const fails of [false, true]) {
    const test = new Mocha.Test(`fails=${fails}`, () => {
      if (fails) assert.fail('retry this test')
    })
    test.file = __filename
    mocha.suite.addTest(test)
    refs.push(new WeakRef(test))
  }
  let retries = 0
  const failures = await new Promise(resolve => {
    mocha.run(resolve).on('retry', () => { retries++ })
  })
  assert.strictEqual(failures, 1)
  assert.strictEqual(retries, 1)
  mocha.dispose()
  return refs
}

async function main () {
  const refs = await runTests()
  for (let attempt = 0; attempt < 5; attempt++) {
    // WeakRef targets remain alive until the current JavaScript job ends.
    await nextTurn()
    global.gc()
    if (refs.every(ref => ref.deref() === undefined)) return
  }
  assert.fail('dynamic ATR retained completed worker tests or their suite')
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
