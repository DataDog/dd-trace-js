// eslint-disable-next-line
const { expect } = require('chai')
const dependency = require('./dependency')

describe('subproject-test', () => {
  it('can run', () => {
    // eslint-disable-next-line
    expect(dependency(1, 2)).to.equal(3)
  })
})
