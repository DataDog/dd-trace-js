'use strict'

const { expect } = require('chai')

describe('test-to-skip', () => {
  it('can report tests', () => {
    expect(1 + 2).to.equal(3)
  })
})
