'use strict'

const assert = require('node:assert/strict')

for (const type of ['before', 'after', 'beforeEach', 'afterEach']) {
  global[type](() => { process.stdout.write(`exclusive ${type} hook\n`) })
}

// eslint-disable-next-line mocha/no-exclusive-tests
it.only('exclusive root-level test on a reused Mocha instance', () => {})

it('non-exclusive root-level test', () => {
  assert.fail('This test must be excluded by Mocha')
})

describe('non-exclusive nested tests', () => {
  it('must remain excluded', () => {
    assert.fail('This test must be excluded by Mocha')
  })
})
