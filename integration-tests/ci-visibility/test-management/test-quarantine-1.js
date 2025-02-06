'use strict'

const { expect } = require('chai')

describe('quarantine tests', () => {
  it('can quarantine a test', () => {
    // eslint-disable-next-line no-console
    console.log('I am running when quarantined') // to check if this is being run
    expect(1 + 2).to.equal(4)
  })

  it('can pass normally', () => {
    expect(1 + 2).to.equal(3)
  })
})
