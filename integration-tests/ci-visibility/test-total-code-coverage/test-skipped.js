'use strict'

const { expect } = require('chai')
const sum = require('./unused-dependency')

describe('test-skipped', () => {
  it('can report tests', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
