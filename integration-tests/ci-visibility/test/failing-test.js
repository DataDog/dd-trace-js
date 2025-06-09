const { expect } = require('chai')

describe('failing', () => {
  it.failing('can report failed tests', () => {
    expect(1 + 2).to.equal(4)
  })
})
