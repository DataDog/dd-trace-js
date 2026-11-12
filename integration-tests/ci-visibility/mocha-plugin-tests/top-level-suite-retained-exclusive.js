'use strict'

const assert = require('node:assert/strict')

it('non-exclusive root-level test', () => {
  assert.fail('This test must be excluded by Mocha')
})

// eslint-disable-next-line mocha/no-exclusive-tests
describe.only('retained exclusive suite', () => {
  it('passes', () => {})
})
