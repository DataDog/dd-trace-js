'use strict'

const { expect } = require('chai')

let numAttempts = 0

describe('attempt to fix tests', () => {
  it('can attempt to fix a test', () => {
    // eslint-disable-next-line no-console
    console.log('I am running when attempt to fix') // to check if this is being run
    if (process.env.SHOULD_ALWAYS_PASS) {
      expect(1 + 2).to.equal(3)
    } else if (process.env.SHOULD_FAIL_SOMETIMES) {
      if (numAttempts++ % 2 === 0) {
        expect(1 + 2).to.equal(3)
      } else {
        expect(1 + 2).to.equal(4)
      }
    } else {
      expect(1 + 2).to.equal(4)
    }
  })
})
