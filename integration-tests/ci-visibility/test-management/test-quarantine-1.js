'use strict'

const assert = require('assert')
describe('quarantine tests', () => {
  it('can quarantine a test', () => {
    // eslint-disable-next-line no-console
    console.log('I am running when quarantined') // to check if this is being run
    if (process.env.JEST_WORKER_ID) {
      process.stdout.write('I am running when quarantined\n')
    }
    assert.strictEqual(1 + 2, 4)
  })

  it('can pass normally', () => {
    assert.strictEqual(1 + 2, 3)
  })
})
