'use strict'

const { expect } = require('chai')

it('no describe can do stuff', () => {
  expect(1).to.equal(1)
})

describe('describe ', () => {
  it('trailing space ', () => {
    expect(1).to.equal(1)
  })
})
