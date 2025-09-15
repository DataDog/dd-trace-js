'use strict'

const { expect } = require('chai')

let counter = 0

describe('test-flaky-test-retries', () => {
  it('can retry failed tests', () => {
    expect(++counter).to.equal(3)
  })
})
