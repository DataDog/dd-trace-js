const { expect } = require('chai')
const dependency = require('./dependency')

describe('subproject-test', () => {
  it('can run', () => {
    expect(dependency(1, 2)).to.equal(3)
  })
})
