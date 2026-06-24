'use strict'

const assert = require('assert')

let attempt = 0

describe('quarantine tests with retries', () => {
  it('can quarantine a test that eventually passes', () => {
    // eslint-disable-next-line no-console
    console.log('I am running when quarantined and eventually passes')
    assert.strictEqual(attempt++, 2)
  })
})
