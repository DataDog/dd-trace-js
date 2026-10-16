'use strict'

const assert = require('node:assert/strict')

before(() => { global.sharedBeforeRan = true })
beforeEach(() => { global.sharedBeforeEachRan = true })
afterEach(() => { process.stdout.write('shared afterEach hook\n') })
after(() => {
  assert.strictEqual(global.sharedBeforeRan, true)
  process.stdout.write('shared after hook\n')
})
