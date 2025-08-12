'use strict'

const { expect } = require('chai')

describe('attempt to fix tests 2', () => {
  it('can attempt to fix a test', () => {
    // eslint-disable-next-line no-console
    console.log('I am running when attempt to fix 2') // to check if this is being run
    expect(1 + 2).to.equal(3)
  })
})
