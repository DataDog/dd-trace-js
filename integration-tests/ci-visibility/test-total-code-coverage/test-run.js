'use strict'

const { expect } = require('chai')
const sum = require('./used-dependency')

describe('test-run', () => {
  it('can report tests', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
