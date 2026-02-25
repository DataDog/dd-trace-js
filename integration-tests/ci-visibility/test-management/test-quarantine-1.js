'use strict'

const assert = require('assert')
describe('quarantine tests', () => {
  it('can quarantine a test', () => {
    // eslint-disable-next-line no-console
    console.log('I am running when quarantined') // to check if this is being run
    assert.strictEqual(1 + 2, 4)
  })

  it('can pass normally', () => {
    assert.strictEqual(1 + 2, 3)
  })
})
