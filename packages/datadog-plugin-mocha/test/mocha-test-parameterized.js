const { expect } = require('chai')
const forEach = require('../../../versions/mocha-each/index').get()

describe('mocha-parameterized', () => {
  forEach([[1, 2, 3]]).it('can do parameterized', (left, right, expected) => {
    expect(left + right).to.equal(expected)
  })
})
