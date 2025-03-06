const { expect } = require('chai')

describe('quarantine tests', () => {
  it('can quarantine a test', () => {
    expect(1 + 2).to.equal(4)
  })

  it('can pass normally', () => {
    expect(1 + 2).to.equal(3)
  })
})
