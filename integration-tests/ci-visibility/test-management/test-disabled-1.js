'use strict'

const { expect } = require('chai')

describe('disable tests', () => {
  it('can disable a test', () => {
    // eslint-disable-next-line no-console
    console.log('I am running') // to check if this is being run
    expect(1 + 2).to.equal(4)
  })
})
