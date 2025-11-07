'use strict'

const assert = require('assert')

describe('jest-test-focused', () => {
  it('will be skipped', () => {
    assert.strictEqual(true, true)
  })
  // eslint-disable-next-line
  it.only('can do focused test', () => {
    assert.strictEqual(true, true)
  })
})

describe('jest-test-focused-2', () => {
  it('will be skipped too', () => {
    assert.strictEqual(true, true)
  })
})
